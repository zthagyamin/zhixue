"""Private chat calls and owner reservations; no formal learning event writer."""
from __future__ import annotations
import json
import math
import os
import sqlite3
import time
import threading
from contextlib import closing, contextmanager, ExitStack
from datetime import datetime, timezone
from pathlib import Path
from application.source_admission import canonical_json
from application.failures import CompanionFailure
from infrastructure.source_protocol_hash import fingerprint
from infrastructure.shared_ai_budget import reservation_totals
from infrastructure.chat_executor_lock import ChatExecutorLock

SETTINGS_FIELDS = ('provider', 'model', 'baseUrl', 'revision', 'maxOutputTokens',
                   'dailyRequestLimit', 'dailyTokenLimit', 'concurrentLimit')
SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS study_chat_requests (
       owner TEXT, library TEXT, root TEXT, request_id TEXT, input_hash TEXT NOT NULL,
       intent_hash TEXT NOT NULL, request TEXT NOT NULL, settings TEXT NOT NULL,
       settings_hash TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL,
       lease_until REAL NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL,
       result TEXT, result_hash TEXT, PRIMARY KEY(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS study_chat_budget (
       owner TEXT, library TEXT, root TEXT, request_id TEXT, day TEXT,
       reserved INTEGER NOT NULL, started REAL NOT NULL, state TEXT NOT NULL, usage INTEGER,
       PRIMARY KEY(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS study_chat_executors (
       owner TEXT,library TEXT,root TEXT,request_id TEXT,generation INTEGER NOT NULL,
       device TEXT NOT NULL,inode TEXT NOT NULL,PRIMARY KEY(owner,library,root,request_id))''',
)


class LocalChatLedger:
    def __init__(self, path, owner, library, root, clock=time.time, lease_seconds=120):
        self.path = Path(path)
        self.scope = (owner, library, os.path.normcase(str(Path(root).resolve())))
        if any(not isinstance(value, str) or not value for value in self.scope):
            raise ValueError('ai-chat-scope')
        self.clock, self.lease_seconds = clock, lease_seconds
        self._executions = {}
        if not callable(clock) or type(lease_seconds) not in (int, float) or not 0 < lease_seconds <= 3600:
            raise ValueError('ai-chat-clock')

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('ai-chat-clock')
        return value

    @contextmanager
    def execution(self, ticket, executor=None):
        lock=executor or ChatExecutorLock(self.path,self.scope,ticket['requestId'])
        try:
            if not lock.acquire():raise ValueError('ai-request-pending')
        except BaseException:
            if executor is not None:
                executor.stop()
                self.abandon(ticket,unsent_only=True)
            raise
        identity=(ticket['requestId'],ticket['generation'],threading.get_ident())
        self._executions[identity]=lock
        try:yield
        finally:
            self._executions.pop(identity,None)
            lock.close()

    def _execution(self, ticket):
        lock=self._executions.get((ticket['requestId'],ticket['generation'],threading.get_ident()))
        if lock is None:raise ValueError('ai-chat-execution-required')
        check=getattr(lock,'check',None)
        if check:check()
        return lock

    @contextmanager
    def _recovery_db(self):
        with ExitStack() as locks:
            with self._db() as db:
                rows=db.execute("SELECT r.library,r.root,r.request_id,r.generation,e.device,e.inode "
                    "FROM study_chat_requests r JOIN study_chat_executors e ON e.owner=r.owner "
                    "AND e.library=r.library AND e.root=r.root AND e.request_id=r.request_id "
                    "AND e.generation=r.generation WHERE r.owner=? AND r.state='dispatched'",(self.scope[0],)).fetchall()
                for library,root,request_id,generation,device,inode in rows:
                    scope=(self.scope[0],library,root)
                    lock=ChatExecutorLock(self.path,scope,request_id)
                    if not lock.acquire(create=False):continue
                    locks.callback(lock.close)
                    if tuple(map(str,lock.identity()))!=(device,inode):raise ValueError('ai-chat-execution-unverified')
                    db.execute("UPDATE study_chat_requests SET state='unknown' WHERE owner=? AND library=? "
                               "AND root=? AND request_id=? AND generation=? AND state='dispatched'",(*scope,request_id,generation))
                    db.execute("UPDATE study_chat_budget SET state='unknown' WHERE owner=? AND library=? "
                               "AND root=? AND request_id=?",(*scope,request_id))
                yield db

    @contextmanager
    def _db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        timed=[lock for (_,_,thread),lock in self._executions.items()
               if thread==threading.get_ident() and hasattr(lock,'remaining') and not lock.stopped]
        timeout=min([10]+[lock.remaining() for lock in timed])
        with closing(sqlite3.connect(self.path, timeout=timeout)) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                for statement in SCHEMA:
                    db.execute(statement)
                yield db
                for lock in timed:lock.check()
                db.commit()
            except (OSError, sqlite3.Error) as error:
                db.rollback()
                raise CompanionFailure(503, {'error': 'ai-chat-storage-unavailable'}) from error
            except BaseException:
                db.rollback()
                raise

    def _row(self, db, request_id):
        raw = db.execute('SELECT request_id,input_hash,intent_hash,request,settings,settings_hash,'
                         'state,generation,lease_until,text,text_hash,result,result_hash '
                         'FROM study_chat_requests WHERE owner=? AND library=? AND root=? AND request_id=?',
                         (*self.scope, request_id)).fetchone()
        if raw is None:
            return None
        keys = ('requestId', 'inputHash', 'intentHash', 'request', 'settings', 'settingsHash',
                'state', 'generation', 'leaseUntil', 'text', 'textHash', 'result', 'resultHash')
        row = dict(zip(keys, raw))
        try:
            for field in ('request', 'settings'):
                row[field] = json.loads(row[field])
            if (fingerprint(row['request']) != row['inputHash'] or
                    fingerprint(row['settings']) != row['settingsHash'] or
                    fingerprint(row['text']) != row['textHash'] or
                    self.intent(row['request']) != row['intentHash']):
                raise ValueError('ai-chat-integrity')
            if row['result'] is not None:
                row['result'] = json.loads(row['result'])
                if fingerprint(row['result']) != row['resultHash']:
                    raise ValueError('ai-chat-integrity')
        except (TypeError, KeyError, ValueError) as error:
            raise ValueError('ai-chat-integrity') from error
        return row

    @staticmethod
    def intent(request):
        return fingerprint({key: request[key] for key in ('context', 'messages')})

    def _existing(self, db, request):
        own = self._row(db, request['requestId'])
        if own and own['inputHash'] != fingerprint(request):
            raise ValueError('ai-request-conflict')
        if own and own['state'] == 'done':
            return {'kind': 'done', 'result': own['result']}
        rows = db.execute('SELECT request_id FROM study_chat_requests WHERE owner=? AND library=? '
                          'AND root=? AND intent_hash=? ORDER BY rowid DESC',
                          (*self.scope, self.intent(request))).fetchall()
        for (request_id,) in rows:
            row = self._row(db, request_id)
            if row['state'] in ('dispatched', 'unknown'):
                return {'kind': 'unknown', 'text': row['text']}
            if row['state'] == 'preflight' and row['leaseUntil'] > self._now():
                return {'kind': 'wait', 'text': row['text']}
        return None

    def lookup(self, request):
        with self._recovery_db() as db:
            return self._existing(db, request)

    def begin(self, request, selected):
        settings = {key: selected[key] for key in SETTINGS_FIELDS}
        limits = {key: settings[key] for key in ('dailyRequestLimit', 'dailyTokenLimit',
                                               'concurrentLimit', 'maxOutputTokens')}
        if any(type(value) is not int or value < 1 for value in limits.values()):
            raise ValueError('invalid-ai-budget')
        amount = len(canonical_json(request).encode('utf8')) + limits['maxOutputTokens'] + 4096
        now = self._now()
        day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
        with self._recovery_db() as db:
            existing = self._existing(db, request)
            if existing:
                return existing
            old = db.execute("SELECT library,root,request_id FROM study_chat_requests WHERE owner=? "
                             "AND state='preflight' AND lease_until<=?", (self.scope[0], now)).fetchall()
            for library, root, request_id in old:
                expired_scope = (self.scope[0], library, root, request_id)
                db.execute("UPDATE study_chat_requests SET state='abandoned' WHERE owner=? AND library=? "
                           'AND root=? AND request_id=?', expired_scope)
                db.execute("UPDATE study_chat_budget SET reserved=0,state='released' WHERE owner=? AND library=? "
                           'AND root=? AND request_id=?', expired_scope)
            count, tokens, active = reservation_totals(db, self.scope[0], day, now-self.lease_seconds)
            if count >= limits['dailyRequestLimit']:
                raise ValueError('account-ai-daily-limit')
            if tokens + amount > limits['dailyTokenLimit']:
                raise ValueError('account-ai-token-limit')
            if active >= limits['concurrentLimit']:
                raise ValueError('account-ai-concurrency-limit')
            own = self._row(db, request['requestId'])
            generation = own['generation'] + 1 if own else 1
            values = (*self.scope, request['requestId'], fingerprint(request), self.intent(request),
                      canonical_json(request), canonical_json(settings), fingerprint(settings),
                      'preflight', generation, now+self.lease_seconds, '', fingerprint(''), None, None)
            db.execute('INSERT OR REPLACE INTO study_chat_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', values)
            db.execute('INSERT OR REPLACE INTO study_chat_budget VALUES (?,?,?,?,?,?,?,?,?)',
                       (*self.scope, request['requestId'], day, amount, now, 'inflight', None))
            return {'kind': 'start', 'requestId': request['requestId'], 'generation': generation}

    def _active(self, db, ticket, states):
        row = self._row(db, ticket['requestId'])
        if not row or row['state'] not in states or row['generation'] != ticket['generation']:
            raise ValueError('ai-request-conflict')
        return row

    def dispatch(self, ticket):
        lock=self._execution(ticket)
        with self._db() as db:
            row = self._active(db, ticket, ('preflight',))
            if row['leaseUntil'] <= self._now():
                raise ValueError('ai-request-conflict')
            device,inode=map(str,lock.identity())
            db.execute('INSERT OR REPLACE INTO study_chat_executors VALUES (?,?,?,?,?,?,?)',
                       (*self.scope,ticket['requestId'],ticket['generation'],device,inode))
            db.execute("UPDATE study_chat_requests SET state='dispatched' WHERE owner=? AND library=? "
                       'AND root=? AND request_id=?', (*self.scope, ticket['requestId']))

    def append(self, ticket, delta):
        self._execution(ticket)
        if not isinstance(delta, str):
            raise ValueError('ai-stream-limit')
        with self._db() as db:
            row = self._active(db, ticket, ('dispatched',))
            text = row['text'] + delta
            if len(text) > 50000:
                raise ValueError('ai-stream-limit')
            db.execute('UPDATE study_chat_requests SET text=?,text_hash=? WHERE owner=? AND library=? '
                       'AND root=? AND request_id=?', (text, fingerprint(text), *self.scope, ticket['requestId']))

    def complete(self, ticket, metadata):
        self._execution(ticket)
        with self._db() as db:
            row = self._active(db, ticket, ('dispatched',))
            amount = db.execute('SELECT reserved FROM study_chat_budget WHERE owner=? AND library=? '
                                'AND root=? AND request_id=?', (*self.scope, ticket['requestId'])).fetchone()[0]
            usage = metadata.get('usageTokens')
            if (metadata.get('type') != 'done' or metadata.get('provider') != row['settings']['provider'] or
                    not isinstance(metadata.get('model'), str) or not 1 <= len(metadata['model']) <= 160):
                raise ValueError('ai-provider-error')
            if usage is not None and (type(usage) is not int or not 0 <= usage <= amount):
                raise ValueError('ai-provider-error')
            result = {'text': row['text'], 'done': metadata}
            db.execute("UPDATE study_chat_requests SET state='done',result=?,result_hash=? WHERE owner=? "
                       'AND library=? AND root=? AND request_id=?',
                       (canonical_json(result), fingerprint(result), *self.scope, ticket['requestId']))
            db.execute("UPDATE study_chat_budget SET state='finished',usage=? WHERE owner=? AND library=? "
                       'AND root=? AND request_id=?', (usage, *self.scope, ticket['requestId']))

    def abandon(self, ticket, *, unsent_only=False):
        with self._db() as db:
            row = self._row(db, ticket['requestId'])
            if not row or row['generation'] != ticket['generation'] or row['state'] not in ('preflight', 'dispatched'):
                return
            if unsent_only and row['state'] != 'preflight':
                return
            state = 'abandoned' if row['state'] == 'preflight' else 'unknown'
            db.execute('UPDATE study_chat_requests SET state=? WHERE owner=? AND library=? AND root=? '
                       'AND request_id=?', (state, *self.scope, ticket['requestId']))
            if state == 'abandoned':
                db.execute("UPDATE study_chat_budget SET reserved=0,state='released' WHERE owner=? AND library=? "
                           'AND root=? AND request_id=?', (*self.scope, ticket['requestId']))
            else:
                # Only actual local stream cleanup releases concurrency. Keep
                # the reservation for unknown provider cost, even across days.
                db.execute("UPDATE study_chat_budget SET state='unknown' WHERE owner=? AND library=? "
                           'AND root=? AND request_id=?', (*self.scope, ticket['requestId']))
