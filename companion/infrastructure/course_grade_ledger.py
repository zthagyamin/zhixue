"""SQLite course recovery ledger; raw answer mirror is not formal study history."""
from __future__ import annotations

import copy
import json
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from account_sync_schema import canonical_json, study_digest, study_hash
from native_course_schema import logical_attempt_body, make_receipt, parse_grade_request
from course_study_domain import parse_course_diagnostic, parse_course_evaluation_trace

SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS native_course_attempts (
       owner TEXT, library TEXT, root TEXT, attempt_id TEXT, body_hash TEXT NOT NULL,
       request_json TEXT NOT NULL, state TEXT NOT NULL, active_request TEXT NOT NULL,
       started REAL NOT NULL, receipt_json TEXT,
       PRIMARY KEY(owner,library,root,attempt_id))''',
    '''CREATE TABLE IF NOT EXISTS native_course_requests (
       owner TEXT, library TEXT, root TEXT, request_id TEXT, attempt_id TEXT NOT NULL,
       fingerprint TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT,
       budget_day TEXT, reserved INTEGER NOT NULL DEFAULT 0, usage INTEGER,
       PRIMARY KEY(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS native_course_claims (
       owner TEXT, library TEXT, root TEXT, attempt_id TEXT, event_id TEXT NOT NULL,
       claim_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
       PRIMARY KEY(owner,library,root,attempt_id), UNIQUE(owner,library,event_id))''',
    '''CREATE TABLE IF NOT EXISTS native_course_formal_slots (
       owner TEXT, library TEXT, root TEXT, logical_key TEXT, attempt_id TEXT NOT NULL,
       PRIMARY KEY(owner,library,root,logical_key))''',
    '''CREATE TABLE IF NOT EXISTS native_course_request_inputs (
       owner TEXT, library TEXT, root TEXT, request_id TEXT, input_json TEXT NOT NULL,
       PRIMARY KEY(owner,library,root,request_id))''',
)


def _echo(receipt, request_id):
    body = {key: copy.deepcopy(value) for key, value in receipt.items() if key != 'receiptHash'}
    body['requestId'] = request_id
    return {**body, 'receiptHash': study_hash(body)}


def _formal_key(claim):
    # Existing V1 source-round uniqueness is scoped by the authenticated owner
    # and library. A browser namespace is neither an account alias nor a way to
    # create another official result for the same item/version/source round.
    binding = claim['binding']
    return study_hash([binding[key] for key in ('groupId', 'roundId', 'itemKey', 'contentHash')])


class CourseGradeLedger:
    def __init__(self, store_path, owner, library, vault_root, clock=time.time, lease_seconds=120):
        self.path = Path(store_path)
        self.owner = study_digest(owner)
        self.library = library
        self.root = os.path.normcase(str(Path(vault_root).resolve()))
        self.scope = (self.owner, self.library, self.root)
        self.clock = clock
        self.lease_seconds = lease_seconds

    @contextmanager
    def _db(self, write=False):
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            target, uri = str(self.path), False
        else:
            if not self.path.is_file():
                yield None
                return
            target, uri = self.path.resolve().as_uri() + '?mode=ro', True
        with closing(sqlite3.connect(target, uri=uri, timeout=10)) as db:
            try:
                if write:
                    db.execute('BEGIN IMMEDIATE')
                    for sql in SCHEMA:
                        db.execute(sql)
                yield db
                if write:
                    db.commit()
            except BaseException:
                if write:
                    db.rollback()
                raise

    def _attempt(self, db, attempt_id):
        return db.execute('''SELECT body_hash,request_json,state,active_request,started,receipt_json
            FROM native_course_attempts WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                          (*self.scope, attempt_id)).fetchone()

    def _verified_request(self, db, request_id):
        row = db.execute('''SELECT i.input_json,r.fingerprint FROM native_course_request_inputs i
            JOIN native_course_requests r ON r.owner=i.owner AND r.library=i.library
            AND r.root=i.root AND r.request_id=i.request_id
            WHERE i.owner=? AND i.library=? AND i.root=? AND i.request_id=?''',
                         (*self.scope, request_id)).fetchone()
        if row is None:
            raise ValueError('native-course-ledger-integrity')
        request = parse_grade_request(json.loads(row[0]))
        if study_hash(request) != row[1] or request['requestId'] != request_id:
            raise ValueError('native-course-ledger-integrity')
        return request

    def _verified(self, db, row, attempt_id):
        try:
            request = parse_grade_request(json.loads(row[1]))
            if (request['attemptId'] != attempt_id or request['identity']['libraryId'] != self.library
                    or study_hash(logical_attempt_body(request)) != row[0]
                    or self._verified_request(db, request['requestId']) != request):
                raise ValueError('native-course-ledger-integrity')
            receipt, diagnosis_request = None, None
            if row[5]:
                receipt = json.loads(row[5])
                diagnosis_request = self._verified_request(db, receipt['originRequestId'])
                if study_hash(logical_attempt_body(diagnosis_request)) != row[0]:
                    raise ValueError('native-course-ledger-integrity')
                diagnostic = parse_course_diagnostic(receipt['diagnostic'])
                trace = parse_course_evaluation_trace(receipt['trace'])
                if diagnostic['source'] == 'self-assess' and (
                        diagnosis_request['action'] != 'self-assess'
                        or diagnostic['status'] != diagnosis_request['selfStatus'] or trace is not None):
                    raise ValueError('native-course-ledger-integrity')
                if diagnostic['source'] == 'model' and (trace is None
                        or diagnosis_request['action'] != 'evaluate'
                        or trace['requestId'] != receipt['originRequestId']
                        or trace['promptVersion'] != 'course-task-json-v1'
                        or trace['ruleVersion'] != 'course-diagnostic-v1'):
                    raise ValueError('native-course-ledger-integrity')
                if diagnostic['source'] in ('none', 'deterministic') and trace is not None:
                    raise ValueError('native-course-ledger-integrity')
                expected = _echo(make_receipt(diagnosis_request, diagnostic, trace,
                                             receipt['remediationTaskId']), receipt['requestId'])
                if (receipt != expected
                        or row[2] == 'resolved' and diagnostic['status'] == 'undetermined'
                        or row[2] == 'pending' and diagnostic['status'] != 'undetermined'):
                    raise ValueError('native-course-ledger-integrity')
            return {'request': request, 'state': row[2], 'receipt': receipt,
                    'diagnosisRequest': diagnosis_request}
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError('native-course-ledger-integrity') from error

    def read_attempt(self, attempt_id):
        with self._db() as db:
            if db is None:
                return None
            try:
                row = self._attempt(db, attempt_id)
            except sqlite3.OperationalError:
                return None
            return self._verified(db, row, attempt_id) if row else None

    def begin(self, request):
        fingerprint = study_hash(request)
        body_hash = study_hash(logical_attempt_body(request))
        request_id, attempt_id = request['requestId'], request['attemptId']
        with self._db(True) as db:
            existing = db.execute('''SELECT fingerprint,state,receipt_json FROM native_course_requests
                WHERE owner=? AND library=? AND root=? AND request_id=?''',
                                  (*self.scope, request_id)).fetchone()
            if existing and existing[0] != fingerprint:
                raise ValueError('native-course-request-conflict')
            row = self._attempt(db, attempt_id)
            if row and row[0] != body_hash:
                raise ValueError('native-course-attempt-conflict')
            if row:
                self._verified(db, row, attempt_id)
            if existing and existing[2] and existing[1] != 'prepared':
                own_row = (*row[:2], existing[1], *row[3:5], existing[2])
                verified = self._verified(db, own_row, attempt_id)
                return {'kind': 'receipt', 'receipt': verified['receipt']}
            if existing and existing[2] and existing[1] == 'prepared':
                self._verified(db, (*row[:2], 'prepared', *row[3:5], existing[2]), attempt_id)
                return {'kind': 'prepared'}
            if row and row[2] in ('resolved', 'prepared'):
                receipt = _echo(json.loads(row[5]), request_id)
                if not existing:
                    self._insert_request(db, request, fingerprint)
                db.execute('''UPDATE native_course_requests SET state=?,receipt_json=?
                    WHERE owner=? AND library=? AND root=? AND request_id=?''',
                           (row[2], canonical_json(receipt), *self.scope, request_id))
                return {'kind': 'receipt' if row[2] == 'resolved' else 'prepared'} | (
                    {'receipt': receipt} if row[2] == 'resolved' else {})
            orphan = False
            if row and row[2] == 'inflight':
                if self.clock() - row[4] < self.lease_seconds:
                    raise ValueError('native-course-attempt-inflight')
                orphan = True
            if not existing:
                self._insert_request(db, request, fingerprint)
            if not row:
                db.execute('INSERT INTO native_course_attempts VALUES (?,?,?,?,?,?,?,?,?,?)',
                           (*self.scope, attempt_id, body_hash, canonical_json(request), 'inflight',
                            request_id, self.clock(), None))
            else:
                db.execute('''UPDATE native_course_attempts SET state='inflight',active_request=?,started=?
                    WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                           (request_id, self.clock(), *self.scope, attempt_id))
            return {'kind': 'orphan' if orphan else 'start'}

    def _insert_request(self, db, request, fingerprint):
        db.execute('''INSERT INTO native_course_requests
            (owner,library,root,request_id,attempt_id,fingerprint,state)
            VALUES (?,?,?,?,?,?,?)''',
                   (*self.scope, request['requestId'], request['attemptId'], fingerprint, 'inflight'))
        db.execute('INSERT INTO native_course_request_inputs VALUES (?,?,?,?,?)',
                   (*self.scope, request['requestId'], canonical_json(request)))

    def reserve(self, request, task, settings):
        output = settings.get('maxOutputTokens', 2000)
        limits = {key: settings.get(key, default) for key, default in
                  (('dailyRequestLimit', 10), ('dailyTokenLimit', 20000), ('concurrentLimit', 1))}
        if any(type(value) is not int or value < 1 for value in (*limits.values(), output)):
            raise ValueError('native-course-invalid-budget')
        # One UTF-8 byte per estimated token is deliberately conservative; include
        # protocol instructions and the frozen maximum output in the reservation.
        reservation = len(canonical_json(task).encode('utf-8')) + len(
            request['submission']['answer'].encode('utf-8')) + output + 2048
        day = datetime.fromtimestamp(self.clock(), timezone.utc).date().isoformat()
        with self._db(True) as db:
            row = self._attempt(db, request['attemptId'])
            if row is None or row[2] != 'inflight' or row[3] != request['requestId']:
                raise ValueError('native-course-reservation-conflict')
            count, tokens = db.execute('''SELECT count(*),COALESCE(sum(reserved),0)
                FROM native_course_requests WHERE owner=? AND budget_day=? AND reserved>0''',
                                       (self.owner, day)).fetchone()
            active = db.execute('''SELECT count(*) FROM native_course_requests r
                JOIN native_course_attempts a ON a.owner=r.owner AND a.library=r.library
                AND a.root=r.root AND a.active_request=r.request_id
                WHERE r.owner=? AND r.reserved>0 AND r.state='inflight' AND a.started>=?''',
                                (self.owner, self.clock() - self.lease_seconds)).fetchone()[0]
            # Additive math authority shares the same authenticated-owner limits.
            # Older databases have no math table and retain the original behavior.
            math_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_math_budget'").fetchone()
            if math_table:
                math_count, math_tokens = db.execute(
                    'SELECT count(*),COALESCE(sum(reserved),0) FROM native_math_budget WHERE owner=? AND day=?',
                    (self.owner, day)).fetchone()
                count += math_count
                tokens += math_tokens
                active += db.execute(
                    "SELECT count(*) FROM native_math_budget WHERE owner=? AND state='inflight' AND started>=?",
                    (self.owner, self.clock() - self.lease_seconds)).fetchone()[0]
            if count >= limits['dailyRequestLimit'] or tokens + reservation > limits['dailyTokenLimit']:
                raise ValueError('native-course-daily-budget')
            if active >= limits['concurrentLimit']:
                raise ValueError('native-course-concurrent-budget')
            db.execute('''UPDATE native_course_requests SET budget_day=?,reserved=?
                WHERE owner=? AND library=? AND root=? AND request_id=? AND reserved=0''',
                       (day, reservation, *self.scope, request['requestId']))
        return reservation

    def prepare(self, request, receipt, usage=None):
        with self._db(True) as db:
            row = self._attempt(db, request['attemptId'])
            if row is None or row[2] != 'inflight' or row[3] != request['requestId']:
                raise ValueError('native-course-prepare-conflict')
            raw = canonical_json(receipt)
            db.execute('''UPDATE native_course_attempts SET state='prepared',receipt_json=?
                WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                       (raw, *self.scope, request['attemptId']))
            db.execute('''UPDATE native_course_requests SET state='prepared',receipt_json=?,usage=?
                WHERE owner=? AND library=? AND root=? AND request_id=?''',
                       (raw, usage, *self.scope, request['requestId']))
            # Expired requests have unknown transport/commit outcomes. Seal each
            # original request with this pending receipt instead of ever allowing
            # its same requestID to invoke the provider again after lease expiry.
            stale = db.execute('''SELECT request_id FROM native_course_requests
                WHERE owner=? AND library=? AND root=? AND attempt_id=? AND state='inflight' ''',
                               (*self.scope, request['attemptId'])).fetchall()
            for (request_id,) in stale:
                db.execute('''UPDATE native_course_requests SET state='pending',receipt_json=?
                    WHERE owner=? AND library=? AND root=? AND request_id=?''',
                           (canonical_json(_echo(receipt, request_id)), *self.scope, request_id))

    def finish(self, request):
        with self._db(True) as db:
            row = self._attempt(db, request['attemptId'])
            if row is None or row[2] not in ('inflight', 'prepared', 'resolved', 'pending') or row[5] is None:
                raise ValueError('native-course-finish-conflict')
            self._verified(db, row, request['attemptId'])
            own = db.execute('''SELECT fingerprint,receipt_json FROM native_course_requests
                WHERE owner=? AND library=? AND root=? AND request_id=?''',
                             (*self.scope, request['requestId'])).fetchone()
            if own is None or own[0] != study_hash(request) or own[1] is None:
                raise ValueError('native-course-finish-conflict')
            self._verified(db, (*row[:2], 'prepared', *row[3:5], own[1]), request['attemptId'])
            receipt = json.loads(own[1])
            state = 'pending' if receipt['diagnostic']['status'] == 'undetermined' else 'resolved'
            aggregate = json.loads(row[5])
            if (row[2] == 'prepared' and aggregate['originRequestId'] == receipt['originRequestId']
                    and aggregate['diagnosticHash'] == receipt['diagnosticHash']
                    and aggregate['attemptEvaluationHash'] == receipt['attemptEvaluationHash']):
                db.execute('''UPDATE native_course_attempts SET state=?
                    WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                           (state, *self.scope, request['attemptId']))
            db.execute('''UPDATE native_course_requests SET state=?,receipt_json=?
                WHERE owner=? AND library=? AND root=? AND request_id=?''',
                       (state, canonical_json(receipt), *self.scope, request['requestId']))
        return receipt

    def read_claim(self, attempt_id, event_id=None):
        with self._db() as db:
            if db is None:
                return None
            try:
                row = db.execute('''SELECT event_id,claim_json,receipt_json FROM native_course_claims
                    WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                                 (*self.scope, attempt_id)).fetchone()
                saved = self._attempt(db, attempt_id) if row else None
                verified = self._verified(db, saved, attempt_id) if saved else None
            except sqlite3.OperationalError:
                return None
        if row is None or saved is None or event_id is not None and row[0] != event_id:
            return None
        claim, claim_receipt = json.loads(row[1]), json.loads(row[2])
        expected = {'schemaVersion': 1, 'durable': True, 'status': 'accepted',
                    'eventId': claim['eventId'], 'claimHash': study_hash(claim)}
        if (claim_receipt != expected or claim['attemptId'] != attempt_id or claim['eventId'] != row[0]
                or verified['state'] != 'resolved'
                or any(claim[key] != verified['receipt'][key] for key in
                       ('binding', 'identity', 'captureId', 'diagnosticHash', 'attemptEvaluationHash'))):
            raise ValueError('native-course-ledger-integrity')
        return {'request': verified['request'], 'receipt': verified['receipt'],
                'claim': claim, 'claimReceipt': claim_receipt}

    def read_claim_by_event(self, event_id):
        with self._db() as db:
            if db is None:
                return None
            try:
                row = db.execute('''SELECT attempt_id FROM native_course_claims
                    WHERE owner=? AND library=? AND root=? AND event_id=?''',
                                 (*self.scope, event_id)).fetchone()
            except sqlite3.OperationalError:
                return None
        return self.read_claim(row[0], event_id) if row else None

    def save_claim(self, claim):
        body = {'schemaVersion': 1, 'durable': True, 'status': 'accepted',
                'eventId': claim['eventId'], 'claimHash': study_hash(claim)}
        with self._db(True) as db:
            row = db.execute('''SELECT claim_json,receipt_json FROM native_course_claims
                WHERE owner=? AND library=? AND root=? AND attempt_id=?''',
                             (*self.scope, claim['attemptId'])).fetchone()
            if row:
                if json.loads(row[0]) != claim:
                    raise ValueError('native-course-claim-conflict')
                return json.loads(row[1])
            saved = self._attempt(db, claim['attemptId'])
            if saved is None or saved[2] != 'resolved':
                raise ValueError('native-course-claim-unresolved')
            self._verified(db, saved, claim['attemptId'])
            logical_key = _formal_key(claim)
            # Preserve older additive claim rows if a pre-slot development
            # database is reopened. Reading their closed claim bodies here is
            # under the same write transaction as slot admission and insertion.
            prior = db.execute('''SELECT attempt_id,claim_json FROM native_course_claims
                WHERE owner=? AND library=? AND root=?''', self.scope).fetchall()
            if any(attempt != claim['attemptId'] and _formal_key(json.loads(raw)) == logical_key
                   for attempt, raw in prior):
                raise ValueError('native-course-claim-formal-binding-conflict')
            try:
                db.execute('INSERT INTO native_course_formal_slots VALUES (?,?,?,?,?)',
                           (*self.scope, logical_key, claim['attemptId']))
                db.execute('INSERT INTO native_course_claims VALUES (?,?,?,?,?,?,?)',
                           (*self.scope, claim['attemptId'], claim['eventId'], canonical_json(claim),
                            canonical_json(body)))
            except sqlite3.IntegrityError:
                slot = db.execute('''SELECT attempt_id FROM native_course_formal_slots
                    WHERE owner=? AND library=? AND root=? AND logical_key=?''',
                                  (*self.scope, logical_key)).fetchone()
                code = 'formal-binding' if slot and slot[0] != claim['attemptId'] else 'event'
                raise ValueError(f'native-course-claim-{code}-conflict') from None
        return body
