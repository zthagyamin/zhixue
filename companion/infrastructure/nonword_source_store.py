"""Scoped SQLite mirror for temporary answers; only verified claims admit V3."""
from __future__ import annotations

import copy
import json
import math
import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from application.source_admission import (digest, fields, identifier, instant,
                                          normalize_evaluation, parse_binding,
                                          parse_descriptor, parse_query, parse_submission)
from infrastructure.source_protocol_hash import fingerprint
from infrastructure import nonword_self_assessment as self_assessments
from infrastructure import nonword_code_reports as code_reports

SCHEMA = (
    self_assessments.SCHEMA,
    code_reports.SCHEMA,
    '''CREATE TABLE IF NOT EXISTS nonword_source_captures (
        owner TEXT, library TEXT, root TEXT, capture_id TEXT, payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL, PRIMARY KEY(owner,library,root,capture_id))''',
    '''CREATE TABLE IF NOT EXISTS nonword_source_attempts (
        owner TEXT, library TEXT, root TEXT, attempt_id TEXT, submission TEXT NOT NULL,
        submission_hash TEXT NOT NULL, capture_id TEXT NOT NULL, evaluation TEXT,
        receipt TEXT NOT NULL, evaluation_request TEXT, PRIMARY KEY(owner,library,root,attempt_id))''',
    '''CREATE TABLE IF NOT EXISTS nonword_source_evaluations (
        owner TEXT, library TEXT, root TEXT, request_id TEXT, attempt_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, receipt TEXT, lease_until REAL NOT NULL DEFAULT 0,
        execution_generation INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS nonword_source_claims (
        owner TEXT, library TEXT, root TEXT, attempt_id TEXT, event_id TEXT NOT NULL,
        payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
        PRIMARY KEY(owner,library,root,attempt_id), UNIQUE(owner,library,root,event_id))''',
)


class SourceAdmissionStore:
    """Evaluation execution leases use the injected server clock (120s by default).

    A lease fences persistence, not the external grader's running process.
    Expiry permits a new generation; only that generation may store a receipt.
    """
    def __init__(self, store_path, owner, library_id, root, resolver, grade, now,
                 *, evaluation_lease_seconds=120, code_review=None, recall_review=None):
        self.path = Path(store_path)
        self.owner, self.library = identifier(owner), identifier(library_id)
        self.root_reference = Path(root)
        self.root = os.path.normcase(str(self.root_reference.resolve()))
        self.scope = self.owner, self.library, self.root
        if not all(callable(port) for port in (resolver, grade, now)):
            raise ValueError('source-admission-port')
        self.resolver, self.grade, self.now = resolver, grade, now
        self.code_review = code_review
        self.recall_review = recall_review
        if (isinstance(evaluation_lease_seconds, bool)
                or not isinstance(evaluation_lease_seconds, (int, float))
                or not math.isfinite(evaluation_lease_seconds)
                or not 0 < evaluation_lease_seconds <= 3600):
            raise ValueError('source-admission-evaluation-lease')
        self.evaluation_lease_seconds = evaluation_lease_seconds

    def _scope(self):
        if os.path.normcase(str(self.root_reference.resolve())) != self.root:
            raise ValueError('source-admission-scope')

    @contextmanager
    def _db(self, write=False):
        self._scope()
        if not write and not self.path.is_file():
            yield None
            return
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        target = str(self.path) if write else self.path.resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(target, uri=not write, timeout=10)) as db:
            try:
                if write:
                    db.execute('BEGIN IMMEDIATE')
                    for statement in SCHEMA:
                        db.execute(statement)
                    # Only temporary evaluation bookkeeping is upgraded, and
                    # only in an explicit write transaction. Legacy unfinished
                    # reservations have no reliable deadline and are recoverable.
                    columns = {row[1] for row in db.execute(
                        'PRAGMA table_info(nonword_source_evaluations)')}
                    for name, declaration in (
                            ('lease_until', 'REAL NOT NULL DEFAULT 0'),
                            ('execution_generation', 'INTEGER NOT NULL DEFAULT 0')):
                        if name not in columns:
                            db.execute(f'ALTER TABLE nonword_source_evaluations ADD COLUMN {name} {declaration}')
                yield db
                if write:
                    db.commit()
            except BaseException:
                if write:
                    db.rollback()
                raise

    def _row(self, db, table, key, value, columns):
        if db is None:
            return None
        try:
            return db.execute(f'SELECT {columns} FROM {table} WHERE owner=? AND library=? AND root=? AND {key}=?',
                              (*self.scope, value)).fetchone()
        except sqlite3.OperationalError as error:
            if 'no such table' in str(error):
                return None
            raise

    def _verified(self, encoded, expected):
        value = json.loads(encoded)
        if fingerprint(value) != expected:
            raise ValueError('source-admission-integrity')
        return value

    def _capture(self, db, capture_id):
        row = self._row(db, 'nonword_source_captures', 'capture_id', identifier(capture_id),
                        'payload,payload_hash')
        if row is None:
            raise ValueError('source-admission-capture-required')
        value = self._verified(*row)
        if value['binding']['captureId'] != capture_id:
            raise ValueError('source-admission-integrity')
        parse_binding(value['binding'], self.owner, self.library)
        return value

    def _attempt(self, db, attempt_id):
        row = self._row(db, 'nonword_source_attempts', 'attempt_id', identifier(attempt_id),
                        'submission,submission_hash,capture_id,evaluation,receipt,evaluation_request')
        if row is None:
            return None
        submission = self._verified(row[0], row[1])
        parse_submission(submission, self.owner, self.library)
        capture = self._capture(db, row[2])
        evaluation = json.loads(row[3]) if row[3] else None
        if evaluation and evaluation.get('evaluationHash') != fingerprint(
                {key: value for key, value in evaluation.items() if key != 'evaluationHash'}):
            raise ValueError('source-admission-integrity')
        return {'submission': submission, 'capture': capture,
                'binding': copy.deepcopy(submission['binding']),
                'originalBinding': copy.deepcopy(submission['binding']),
                'sourceBinding': copy.deepcopy(capture.get('sourceBinding')), 'evaluation': evaluation,
                'receipt': json.loads(row[4]), 'evaluationRequest': row[5],
                'selfAssessment': self_assessments.read(db, self.scope, submission),
                'codeReports': code_reports.read(db, self.scope, submission)}

    def _current(self, capture):
        self._scope()
        if capture['status'] != 'confirmed':
            return False
        try:
            actual = self.resolver(copy.deepcopy(capture['query']))
            return actual is not None and fingerprint(parse_descriptor(actual)) == fingerprint(capture['descriptor'])
        except (ValueError, OSError, KeyError, TypeError):
            return False

    def capture(self, raw):
        query = parse_query(raw)
        descriptor = self.resolver(copy.deepcopy(query))
        descriptor = None if descriptor is None else parse_descriptor(descriptor)
        payload = {'schemaVersion': 1, 'status': 'confirmed' if descriptor else 'pending',
                   'query': query, 'descriptor': descriptor}
        capture_id = 'source-capture:' + fingerprint([list(self.scope), payload])
        binding = {'ownerId': self.owner, 'libraryId': self.library,
                   'itemKey': query['itemKey'],
                   'contentHash': query['contentHash'],
                   'captureId': capture_id}
        payload['binding'] = binding
        if descriptor:
            payload['sourceBinding'] = {**binding, 'itemKey': descriptor['sourceKey'],
                                        'contentHash': descriptor['sourceHash']}
        encoded = json.dumps(payload, ensure_ascii=False)
        with self._db(True) as db:
            db.execute('INSERT OR IGNORE INTO nonword_source_captures VALUES (?,?,?,?,?,?)',
                       (*self.scope, capture_id, encoded, fingerprint(payload)))
            if self._capture(db, capture_id) != payload:
                raise ValueError('source-admission-capture-conflict')
        result = {'schemaVersion': 1, 'status': payload['status'], 'durable': True,
                  'captureId': capture_id, 'binding': binding, 'originalBinding': copy.deepcopy(binding)}
        if descriptor:
            result.update(item=copy.deepcopy(descriptor['item']), eventKind=descriptor['eventKind'],
                          sourceBinding=copy.deepcopy(payload['sourceBinding']))
        else:
            result['reason'] = 'source-unverified'
        return result

    def submit(self, raw):
        submission = parse_submission(raw, self.owner, self.library)
        body_hash = fingerprint(submission)
        receipt = {'schemaVersion': 1, 'status': 'saved', 'durable': True,
                   'attemptId': submission['attemptId'], 'answerRevision': submission['answerRevision'],
                   'submissionHash': body_hash, 'submittedAt': submission['submittedAt'],
                   'savedAt': instant(self.now().isoformat())}
        with self._db(True) as db:
            capture = self._capture(db, submission['binding']['captureId'])
            if capture['binding'] != submission['binding']:
                raise ValueError('source-admission-binding')
            previous = self._attempt(db, submission['attemptId'])
            if previous:
                if fingerprint(previous['submission']) != body_hash:
                    raise ValueError('source-admission-submission-conflict')
                return copy.deepcopy(previous['receipt'])
            parent = submission.get('parentAttemptId')
            # A guided draft may arrive before its parent's first submission.
            # Retain that pointer as metadata; guided/remediation cannot claim.
            db.execute('INSERT INTO nonword_source_attempts VALUES (?,?,?,?,?,?,?,?,?,?)',
                       (*self.scope, submission['attemptId'], json.dumps(submission, ensure_ascii=False),
                        body_hash, capture['binding']['captureId'], None, json.dumps(receipt), None))
        return receipt

    def read_attempt(self, attempt_id):
        with self._db() as db:
            return copy.deepcopy(self._attempt(db, attempt_id))

    def record_code_report(self, raw):
        return code_reports.record(self, raw)

    def self_assess(self, raw):
        return self_assessments.record(self, raw)

    def confirm(self, raw):
        request = fields(raw, ('attemptId', 'captureId'))
        with self._db(True) as db:
            attempt = self._attempt(db, request['attemptId'])
            if not attempt:
                raise ValueError('source-admission-submission-required')
            if self._row(db, 'nonword_source_claims', 'attempt_id', request['attemptId'], 'event_id'):
                raise ValueError('source-admission-claim-conflict')
            capture = self._capture(db, request['captureId'])
            if capture['status'] != 'confirmed' or not self._current(capture):
                raise ValueError('source-admission-source-changed')
            original = self._capture(db, attempt['submission']['binding']['captureId'])
            if fingerprint(original['query']['presentation']) != fingerprint(capture['query']['presentation']):
                raise ValueError('source-admission-presentation-conflict')
            if capture['binding']['captureId'] != attempt['capture']['binding']['captureId']:
                db.execute('UPDATE nonword_source_attempts SET capture_id=?,evaluation=NULL,evaluation_request=NULL '
                           'WHERE owner=? AND library=? AND root=? AND attempt_id=?',
                           (request['captureId'], *self.scope, request['attemptId']))
        return {'schemaVersion': 1, 'status': 'confirmed', 'durable': True,
                'attemptId': request['attemptId'], 'binding': copy.deepcopy(attempt['submission']['binding']),
                'sourceBinding': copy.deepcopy(capture['sourceBinding']), 'sourceCaptureId': request['captureId']}

    def _evaluation(self, attempt, request_id, outcome, *, durable=True):
        body = {'schemaVersion': 1, 'durable': durable, 'requestId': request_id,
                'attemptId': attempt['submission']['attemptId'], 'binding': attempt['binding'],
                'sourceBinding': attempt['sourceBinding'],
                'sourceCaptureId': attempt['capture']['binding']['captureId'],
                'answerRevision': attempt['submission']['answerRevision'],
                'answerHash': fingerprint(attempt['submission']['answer']), **outcome}
        return {**body, 'evaluationHash': fingerprint(body)}

    def _evaluation_time(self):
        current = self.now()
        if current.utcoffset() is None:
            raise ValueError('source-admission-evaluation-time')
        stamp = current.timestamp()
        if not math.isfinite(stamp):
            raise ValueError('source-admission-evaluation-time')
        return stamp

    def evaluate(self, raw):
        request = fields(raw, ('attemptId', 'requestId'))
        identifier(request['requestId'])
        with self._db(True) as db:
            attempt = self._attempt(db, request['attemptId'])
            if not attempt:
                raise ValueError('source-admission-submission-required')
            input_hash = code_reports.evaluation_input_hash(attempt)
            previous = self._row(db, 'nonword_source_evaluations', 'request_id',
                                 request['requestId'], 'input_hash,receipt,lease_until,execution_generation')
            if previous and previous[0] != input_hash:
                raise ValueError('source-admission-request-conflict')
            if previous and previous[1]:
                saved = json.loads(previous[1])
                if saved.get('evaluationHash') != fingerprint(
                        {key: value for key, value in saved.items() if key != 'evaluationHash'}):
                    raise ValueError('source-admission-integrity')
                if saved['status'] == 'pending' or self._current(attempt['capture']):
                    return saved
                return self._evaluation(attempt, request['requestId'],
                                        {'status': 'pending', 'reason': 'source-or-evaluation-unavailable'},
                                        durable=False)
            if self._row(db, 'nonword_source_claims', 'attempt_id', request['attemptId'], 'event_id'):
                raise ValueError('source-admission-claim-conflict')
            now = self._evaluation_time()
            active = (self._row(db, 'nonword_source_evaluations', 'request_id',
                               attempt['evaluationRequest'], 'receipt,lease_until')
                      if attempt['evaluationRequest'] else None)
            # Caller timeouts do not end a running execution. All requests for
            # this answer wait for its server lease, even with a different ID.
            if ((previous and previous[2] > now)
                    or (active and active[0] is None and active[1] > now)):
                return self._evaluation(attempt, request['requestId'],
                                        {'status': 'pending', 'reason': 'source-or-evaluation-unavailable'},
                                        durable=False)
            generation = previous[3] + 1 if previous else 1
            lease_until = now + self.evaluation_lease_seconds
            if previous:
                db.execute('UPDATE nonword_source_evaluations SET lease_until=?,execution_generation=? '
                           'WHERE owner=? AND library=? AND root=? AND request_id=?',
                           (lease_until, generation, *self.scope, request['requestId']))
            else:
                db.execute('INSERT INTO nonword_source_evaluations '
                           '(owner,library,root,request_id,attempt_id,input_hash,receipt,lease_until,execution_generation) '
                           'VALUES (?,?,?,?,?,?,?,?,?)',
                           (*self.scope, request['requestId'], request['attemptId'], input_hash,
                            None, lease_until, generation))
            db.execute('UPDATE nonword_source_attempts SET evaluation_request=? '
                       'WHERE owner=? AND library=? AND root=? AND attempt_id=?',
                       (request['requestId'], *self.scope, request['attemptId']))
        outcome = {'status': 'pending', 'reason': 'source-unverified'}
        if self._current(attempt['capture']):
            descriptor = attempt['capture']['descriptor']
            outcome = code_reports.evaluation(attempt,self.code_review,request['requestId']) or self_assessments.evaluation(attempt)
            if outcome is None and descriptor['item'].get('questionType')=='recall' and callable(self.recall_review):
                outcome=self.recall_review(attempt,request['requestId'])
            if outcome is None:
                try:
                    raw_grade = self.grade(copy.deepcopy(descriptor['item']),
                                           copy.deepcopy(attempt['submission']['answer']))
                    outcome = normalize_evaluation(raw_grade, descriptor['item'])
                except Exception:
                    outcome = {'status': 'pending', 'reason': 'evaluation-unavailable'}
            if not self._current(attempt['capture']):
                outcome = {'status': 'pending', 'reason': 'source-changed'}
        receipt = self._evaluation(attempt, request['requestId'], outcome)
        with self._db(True) as db:
            current = self._attempt(db, request['attemptId'])
            execution = self._row(db, 'nonword_source_evaluations', 'request_id',
                                  request['requestId'], 'input_hash,receipt,lease_until,execution_generation')
            if (not current or current['evaluationRequest'] != request['requestId']
                    or code_reports.evaluation_input_hash(current) != input_hash
                    or not execution or execution[0] != input_hash or execution[1] is not None
                    or execution[3] != generation or execution[2] <= self._evaluation_time()):
                raise ValueError('source-admission-evaluation-conflict')
            if self._row(db, 'nonword_source_claims', 'attempt_id', request['attemptId'], 'event_id'):
                raise ValueError('source-admission-claim-conflict')
            # Include the generation in the final write fence: an expired
            # worker cannot overwrite a recovered execution of the same ID.
            db.execute('UPDATE nonword_source_evaluations SET receipt=? '
                       'WHERE owner=? AND library=? AND root=? AND request_id=? AND execution_generation=?',
                       (json.dumps(receipt, ensure_ascii=False), *self.scope, request['requestId'], generation))
            db.execute('UPDATE nonword_source_attempts SET evaluation=? '
                       'WHERE owner=? AND library=? AND root=? AND attempt_id=?',
                       (json.dumps(receipt, ensure_ascii=False), *self.scope, request['attemptId']))
        return receipt

    def _claim(self, db, attempt_id):
        row = self._row(db, 'nonword_source_claims', 'attempt_id', attempt_id, 'payload,payload_hash')
        return self._verified(*row) if row else None

    def read_claim_by_event(self, event_id):
        with self._db() as db:
            row = self._row(db, 'nonword_source_claims', 'event_id', identifier(event_id), 'attempt_id')
            return copy.deepcopy(self._claim(db, row[0])) if row else None

    def claim(self, raw):
        request = fields(raw, ('attemptId', 'eventId'), ('rating',))
        identifier(request['eventId'])
        with self._db(True) as db:
            previous = self._claim(db, request['attemptId'])
            if previous:
                claim = previous['claim']
                if claim['eventId'] != request['eventId'] or request.get('rating', claim['rating']) != claim['rating']:
                    raise ValueError('source-admission-claim-conflict')
                return copy.deepcopy(previous)
            attempt = self._attempt(db, request['attemptId'])
            evaluation = attempt and attempt['evaluation']
            if (not attempt or attempt['submission'].get('purpose') != 'first'
                    or attempt['submission'].get('parentAttemptId') is not None):
                raise ValueError('source-admission-purpose')
            if (not evaluation or evaluation['status'] != 'resolved'
                    or evaluation['requestId'] != attempt['evaluationRequest']):
                raise ValueError('source-admission-evaluation-required')
            if (evaluation['binding'] != attempt['binding'] or evaluation['sourceBinding'] != attempt['sourceBinding']
                    or evaluation['sourceCaptureId'] != attempt['capture']['binding']['captureId']
                    or not self._current(attempt['capture'])):
                raise ValueError('source-admission-source-changed')
            correct = evaluation['correct']
            original_rating = self_assessments.original_rating(attempt, evaluation)
            rating = request.get('rating', original_rating or ('good' if correct else 'hard' if evaluation.get('outcome') == 'partial' else 'again'))
            if original_rating is not None and rating != original_rating:
                raise ValueError('source-admission-claim-conflict')
            if rating not in ('again', 'hard', 'good', 'easy') or not correct and rating in ('good', 'easy'):
                raise ValueError('source-admission-claim-conflict')
            level = attempt['submission'].get('maxPreHintLevel', 0)
            if attempt['capture']['descriptor']['item'].get('questionType') == 'recall':
                if level >= 3 and rating != 'again' or level >= 2 and rating in ('good', 'easy'):
                    raise ValueError('source-admission-claim-conflict')
            claim = {'schemaVersion': 1, 'attemptId': request['attemptId'], 'eventId': request['eventId'],
                     'binding': attempt['binding'], 'sourceBinding': attempt['sourceBinding'],
                     'sourceCaptureId': evaluation['sourceCaptureId'],
                     'evaluationHash': evaluation['evaluationHash'],
                     'answerRevision': evaluation['answerRevision'], 'answerHash': evaluation['answerHash'],
                     'rating': rating, 'correct': correct and rating in ('good', 'easy'),
                     'occurredAt': attempt['submission']['submittedAt'],
                     'eventKind': attempt['capture']['descriptor']['eventKind']}
            receipt = {'schemaVersion': 1, 'status': 'accepted', 'durable': True,
                       'claim': claim, 'claimHash': fingerprint(claim)}
            if self._row(db, 'nonword_source_claims', 'event_id', request['eventId'], 'attempt_id'):
                raise ValueError('source-admission-claim-conflict')
            db.execute('INSERT INTO nonword_source_claims VALUES (?,?,?,?,?,?,?)',
                       (*self.scope, request['attemptId'], request['eventId'],
                        json.dumps(receipt, ensure_ascii=False), fingerprint(receipt)))
            if not self._current(attempt['capture']):
                raise ValueError('source-admission-source-changed')
        return receipt

    def admit(self, event):
        aggregate = self.read_claim_by_event(event['eventId'])
        if aggregate is None:
            raise ValueError('source-admission-claim-required')
        claim = aggregate['claim']
        attempt = self.read_attempt(claim['attemptId'])
        if (not attempt or not attempt['evaluation']
                or attempt['submission'].get('purpose') != 'first'
                or attempt['submission'].get('parentAttemptId') is not None
                or aggregate['claimHash'] != fingerprint(claim)
                or claim['binding'] != attempt['binding']
                or claim['sourceBinding'] != attempt['sourceBinding']
                or claim['sourceCaptureId'] != attempt['capture']['binding']['captureId']
                or claim['evaluationHash'] != attempt['evaluation']['evaluationHash']
                or self_assessments.original_rating(attempt, attempt['evaluation']) not in (None, claim['rating'])):
            raise ValueError('source-admission-integrity')
        if (event.get('eventType') != 'practice-attempt'
                or event.get('item', {}).get('key') != claim['binding']['itemKey']
                or event.get('item', {}).get('kind') != claim['eventKind']
                or event.get('occurredAt') != claim['occurredAt']
                or event.get('attempt', {}).get('rating') != claim['rating']
                or event.get('attempt', {}).get('correct') is not claim['correct']
                or event.get('scheduling', {}).get('reviewedAt', claim['occurredAt']) != claim['occurredAt']
                or event.get('scheduling', {}).get('rating', claim['rating']) != claim['rating']):
            raise ValueError('source-admission-event-binding')

        def recheck():
            current = self.read_claim_by_event(event['eventId'])
            if current != aggregate:
                raise ValueError('source-admission-claim-conflict')
            if not self._current(attempt['capture']):
                raise ValueError('source-admission-source-changed')

        recheck()
        return recheck, copy.deepcopy(attempt['capture']['descriptor']['route'])
