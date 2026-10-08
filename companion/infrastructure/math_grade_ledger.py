"""Immutable raw math answer ledger; this store never writes formal study events."""
from __future__ import annotations
import copy
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from contextlib import closing, contextmanager
from account_sync_schema import canonical_json, study_digest, study_hash
from native_math_schema import logical_claim, parse_claim, parse_evaluate, parse_formal

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS native_math_budget(owner TEXT,library TEXT,root TEXT,request_id TEXT,day TEXT,reserved INTEGER NOT NULL,started REAL NOT NULL,state TEXT NOT NULL,usage INTEGER,PRIMARY KEY(owner,library,root,request_id))""",
    '''CREATE TABLE IF NOT EXISTS native_math_attempts(
        owner TEXT, library TEXT, root TEXT, attempt_id TEXT, claim_json TEXT NOT NULL,
        logical_hash TEXT NOT NULL, claim_hash TEXT NOT NULL,
        PRIMARY KEY(owner,library,root,attempt_id))''',
    '''CREATE TABLE IF NOT EXISTS native_math_namespaces(owner TEXT PRIMARY KEY, namespace TEXT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS native_math_requests(
        owner TEXT, library TEXT, root TEXT, request_id TEXT, attempt_id TEXT NOT NULL,
        input_json TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        started REAL NOT NULL, result_json TEXT,
        PRIMARY KEY(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS native_math_formal(
        owner TEXT, library TEXT, root TEXT, attempt_id TEXT, event_id TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
        PRIMARY KEY(owner,library,root,attempt_id), UNIQUE(owner,library,event_id))''',
)


def claim_receipt(claim):
    a = claim['attempt']
    return {'schemaVersion': 1, 'durable': True, 'attemptId': a['attemptId'],
            'answerRevision': a['submitted']['answerRevision'], 'captureId': claim['captureId'],
            'claimHash': study_hash(logical_claim(claim))}


class MathGradeLedger:
    def __init__(self, path, owner, library, root, clock=time.time, lease_seconds=120):
        self.path = Path(path)
        self.scope = (study_digest(owner), library, os.path.normcase(str(Path(root).resolve())))
        self.clock, self.lease_seconds = clock, lease_seconds

    @contextmanager
    def _db(self, write=False):
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            target, uri = str(self.path), False
        else:
            if not self.path.exists():
                yield None
                return
            target, uri = self.path.resolve().as_uri() + '?mode=ro', True
        with closing(sqlite3.connect(target, uri=uri, timeout=10)) as db:
            try:
                if write:
                    db.execute('BEGIN IMMEDIATE')
                    for statement in SCHEMA:
                        db.execute(statement)
                yield db
                if write:
                    db.commit()
            except BaseException:
                if write:
                    db.rollback()
                raise

    def _attempt(self, db, attempt_id):
        row = db.execute('SELECT claim_json,logical_hash,claim_hash FROM native_math_attempts WHERE owner=? AND library=? AND root=? AND attempt_id=?', (*self.scope, attempt_id)).fetchone()
        if row is None:
            return None
        try:
            claim = parse_claim(json.loads(row[0]))
            if (claim['attempt']['attemptId'] != attempt_id or claim['identity']['libraryId'] != self.scope[1]
                    or study_hash(claim) != row[2] or study_hash(logical_claim(claim)) != row[1]):
                raise ValueError('native-math-ledger-integrity')
            namespace = db.execute('SELECT namespace FROM native_math_namespaces WHERE owner=?', (self.scope[0],)).fetchone()
            if not namespace or namespace[0] != claim['attempt']['binding']['ownerId']:
                raise ValueError('native-math-ledger-integrity')
            return {'claim': claim, 'receipt': claim_receipt(claim)}
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError('native-math-ledger-integrity') from error

    def read_attempt(self, attempt_id):
        with self._db() as db:
            if db is None:
                return None
            try:
                return copy.deepcopy(self._attempt(db, attempt_id))
            except sqlite3.OperationalError:
                return None

    def claim(self, raw):
        claim = parse_claim(raw)
        a = claim['attempt']
        with self._db(True) as db:
            ns = db.execute('SELECT namespace FROM native_math_namespaces WHERE owner=?', (self.scope[0],)).fetchone()
            if ns and ns[0] != a['binding']['ownerId']:
                raise ValueError('native-math-owner-namespace-conflict')
            prior = self._attempt(db, a['attemptId'])
            if prior:
                if logical_claim(prior['claim']) != logical_claim(claim):
                    raise ValueError('native-math-attempt-conflict')
                return prior['receipt']
            if claim['identity']['libraryId'] != self.scope[1]:
                raise ValueError('native-math-library-conflict')
            if a['parentAttemptId'] is not None:
                parent = self._attempt(db, a['parentAttemptId'])
                if not parent or any(parent['claim'][key] != claim[key] for key in ('identity','captureId')) or parent['claim']['attempt']['binding'] != a['binding']:
                    raise ValueError('native-math-parent-conflict')
                if 'variant' in claim and 'variant' in parent['claim']:
                    raise ValueError('native-math-variant-parent-conflict')
            if not ns:
                db.execute('INSERT INTO native_math_namespaces VALUES (?,?)', (self.scope[0], a['binding']['ownerId']))
            db.execute('INSERT INTO native_math_attempts VALUES (?,?,?,?,?,?,?)', (*self.scope, a['attemptId'], canonical_json(claim), study_hash(logical_claim(claim)), study_hash(claim)))
        return claim_receipt(claim)

    def _formal(self, db, attempt_id):
        row = db.execute('SELECT event_id,payload,payload_hash FROM native_math_formal WHERE owner=? AND library=? AND root=? AND attempt_id=?', (*self.scope, attempt_id)).fetchone()
        if not row:
            return None
        formal = parse_formal(json.loads(row[1]))
        if formal['attemptId'] != attempt_id or formal['eventId'] != row[0] or study_hash(formal) != row[2]:
            raise ValueError('native-math-ledger-integrity')
        return formal

    def formal(self, raw):
        formal = parse_formal(raw)
        with self._db(True) as db:
            saved = self._attempt(db, formal['attemptId'])
            if not saved:
                raise ValueError('native-math-attempt-not-found')
            a = saved['claim']['attempt']
            if a['parentAttemptId'] is not None or a['checkpoint'].get('purpose','first')!='first':
                raise ValueError('native-math-formal-ineligible')
            if formal['answerRevision'] != a['submitted']['answerRevision'] or formal['sourceVersion'] != a['binding']['contentHash'] or formal['occurredAt'] != a['submitted']['submittedAt']:
                raise ValueError('native-math-formal-binding-conflict')
            old = self._formal(db, formal['attemptId'])
            if old and old != formal:
                raise ValueError('native-math-formal-conflict')
            if not old:
                resolved = db.execute("SELECT result_json FROM native_math_requests WHERE owner=? AND library=? AND root=? AND attempt_id=? AND state='done'", (*self.scope, formal['attemptId'])).fetchall()
                if not any(json.loads(r[0]).get('final',{}).get('status') in ('correct','incorrect') for r in resolved):
                    raise ValueError('native-math-formal-unresolved')
                try:
                    db.execute('INSERT INTO native_math_formal VALUES (?,?,?,?,?,?,?)', (*self.scope, formal['attemptId'], formal['eventId'], canonical_json(formal), study_hash(formal)))
                except sqlite3.IntegrityError:
                    raise ValueError('native-math-formal-event-conflict') from None
        return {'schemaVersion':1,'durable':True,'status':'barrier-saved','attemptId':formal['attemptId'],'eventId':formal['eventId'],'claimHash':study_hash(formal)}

    def _request(self, db, request_id):
        row = db.execute('SELECT input_json,fingerprint,state,started,result_json FROM native_math_requests WHERE owner=? AND library=? AND root=? AND request_id=?', (*self.scope,request_id)).fetchone()
        if not row:
            return None
        request = parse_evaluate(json.loads(row[0]))
        if request['requestId'] != request_id or study_hash(request) != row[1]:
            raise ValueError('native-math-ledger-integrity')
        result = json.loads(row[4]) if row[4] else None
        if result:
            expected = {k:v for k,v in result.items() if k != 'receiptHash'}
            if result.get('receiptHash') != study_hash(expected) or any(result.get(k) != request[k] for k in ('requestId','attemptId','answerRevision','sourceVersion')):
                raise ValueError('native-math-ledger-integrity')
        return {'request':request,'state':row[2],'started':row[3],'result':result}

    def begin(self, raw):
        request = parse_evaluate(raw)
        with self._db(True) as db:
            saved = self._attempt(db, request['attemptId'])
            if not saved:
                raise ValueError('native-math-attempt-not-found')
            a = saved['claim']['attempt']
            if a['submitted']['answerRevision'] != request['answerRevision']:
                raise ValueError('native-math-answer-revision-conflict')
            if a['binding']['contentHash'] != request['sourceVersion']:
                raise ValueError('native-math-source-version-conflict')
            step = saved['claim'].get('stepInput')
            if 'stepRevision' in request and (not step or step['revision'] != request['stepRevision']):
                raise ValueError('native-math-step-revision-conflict')
            prior = self._request(db, request['requestId'])
            if prior and prior['request'] != request:
                raise ValueError('native-math-request-conflict')
            if prior and prior['result']:
                return {'kind':'prepared' if prior['state']=='prepared' else 'receipt','result':prior['result']}
            if request['mode']=='final' and self._formal(db,request['attemptId']):
                raise ValueError('native-math-formal-existing-result')
            if prior:
                if self.clock()-prior['started'] < self.lease_seconds:
                    raise ValueError('native-math-request-inflight')
                return {'kind':'orphan'}
            db.execute('INSERT INTO native_math_requests VALUES (?,?,?,?,?,?,?,?,?,?)', (*self.scope,request['requestId'],request['attemptId'],canonical_json(request),study_hash(request),'inflight',self.clock(),None))
        return {'kind':'start'}

    def prepare(self, request, result):
        body = {k:v for k,v in result.items() if k!='receiptHash'}
        result = {**body,'receiptHash':study_hash(body)}
        with self._db(True) as db:
            old = self._request(db,request['requestId'])
            if not old or old['request'] != request:
                raise ValueError('native-math-prepare-conflict')
            if old['result']:
                if old['result'] != result:
                    raise ValueError('native-math-result-conflict')
                return old['result']
            if request['mode']=='final' and self._formal(db,request['attemptId']):
                raise ValueError('native-math-formal-existing-result')
            db.execute("UPDATE native_math_requests SET state='prepared',result_json=? WHERE owner=? AND library=? AND root=? AND request_id=?", (canonical_json(result),*self.scope,request['requestId']))
        return copy.deepcopy(result)

    def finish(self, request):
        with self._db(True) as db:
            old = self._request(db,request['requestId'])
            if not old or old['request'] != request or not old['result']:
                raise ValueError('native-math-finish-conflict')
            db.execute("UPDATE native_math_requests SET state='done' WHERE owner=? AND library=? AND root=? AND request_id=?", (*self.scope,request['requestId']))
        return copy.deepcopy(old['result'])

    def reserve(self, request_id, data, settings):
        limits={key:settings.get(key,default) for key,default in (('dailyRequestLimit',10),('dailyTokenLimit',20000),('concurrentLimit',1),('maxOutputTokens',2000))}
        if any(type(value) is not int or value<1 for value in limits.values()):
            raise ValueError('native-math-budget-invalid')
        amount=len(canonical_json(data).encode('utf-8'))+limits['maxOutputTokens']+2048
        day=datetime.fromtimestamp(self.clock(),timezone.utc).date().isoformat()
        with self._db(True) as db:
            active=self._request(db,request_id)
            if not active or active['state']!='inflight':
                raise ValueError('native-math-budget-request-conflict')
            old=db.execute('SELECT reserved FROM native_math_budget WHERE owner=? AND library=? AND root=? AND request_id=?',(*self.scope,request_id)).fetchone()
            if old:
                raise ValueError('native-math-provider-outcome-unknown')
            count,tokens=db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM native_math_budget WHERE owner=? AND day=?',(self.scope[0],day)).fetchone()
            running=db.execute("SELECT count(*) FROM native_math_budget WHERE owner=? AND state='inflight' AND started>=?",(self.scope[0],self.clock()-self.lease_seconds)).fetchone()[0]
            exists=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_course_requests'").fetchone()
            if exists:
                other_count,other_tokens=db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM native_course_requests WHERE owner=? AND budget_day=? AND reserved>0',(self.scope[0],day)).fetchone()
                count+=other_count
                tokens+=other_tokens
                running+=db.execute("SELECT count(*) FROM native_course_requests r JOIN native_course_attempts a ON a.owner=r.owner AND a.library=r.library AND a.root=r.root AND a.active_request=r.request_id WHERE r.owner=? AND r.state='inflight' AND r.reserved>0 AND a.started>=?",(self.scope[0],self.clock()-self.lease_seconds)).fetchone()[0]
            if count>=limits['dailyRequestLimit'] or tokens+amount>limits['dailyTokenLimit']:
                raise ValueError('native-math-daily-budget')
            if running>=limits['concurrentLimit']:
                raise ValueError('native-math-concurrent-budget')
            db.execute('INSERT INTO native_math_budget VALUES (?,?,?,?,?,?,?,?,?)',(*self.scope,request_id,day,amount,self.clock(),'inflight',None))
        return amount

    def finish_budget(self, request_id, usage=None):
        with self._db(True) as db:
            row=db.execute('SELECT reserved FROM native_math_budget WHERE owner=? AND library=? AND root=? AND request_id=?',(*self.scope,request_id)).fetchone()
            if not row:
                return
            if usage is not None and (type(usage) is not int or not 0<=usage<=row[0]):
                raise ValueError('native-math-provider-usage-invalid')
            db.execute("UPDATE native_math_budget SET state='finished',usage=? WHERE owner=? AND library=? AND root=? AND request_id=?",(usage,*self.scope,request_id))

    def read(self, attempt_id, request_id=None):
        with self._db() as db:
            if db is None:
                raise ValueError('native-math-attempt-not-found')
            try:
                saved = self._attempt(db,attempt_id)
                if not saved:
                    raise ValueError('native-math-attempt-not-found')
                rows = db.execute('SELECT request_id FROM native_math_requests WHERE owner=? AND library=? AND root=? AND attempt_id=? ORDER BY request_id', (*self.scope,attempt_id)).fetchall()
                results = [self._request(db,r[0])['result'] for r in rows if request_id is None or r[0] == request_id]
                return {'schemaVersion':1,'durable':True,'claim':saved['claim'],'results':[r for r in results if r], 'formalBarrier':self._formal(db,attempt_id)}
            except sqlite3.OperationalError:
                raise ValueError('native-math-attempt-not-found') from None
