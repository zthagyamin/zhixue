"""Durable provider calls, separate from source admission and formal study history."""
from __future__ import annotations

import json
import math
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from application.source_admission import canonical_json, identifier
from infrastructure.source_protocol_hash import fingerprint
from infrastructure.shared_ai_budget import reservation_totals

SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS nonword_code_jobs (
       owner TEXT,library TEXT,root TEXT,job_id TEXT,request_id TEXT,attempt_id TEXT,
       input_json TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,
       lease_until REAL NOT NULL,generation INTEGER NOT NULL,receipt TEXT,receipt_hash TEXT,
       PRIMARY KEY(owner,library,root,job_id),UNIQUE(owner,library,root,request_id))''',
    '''CREATE TABLE IF NOT EXISTS nonword_code_budget (
       owner TEXT,library TEXT,root TEXT,request_id TEXT,day TEXT,reserved INTEGER NOT NULL,
       started REAL NOT NULL,state TEXT NOT NULL,usage INTEGER,
       PRIMARY KEY(owner,library,root,request_id))''',
)
SETTINGS_FIELDS = ('provider','model','baseUrl','enabled','configured','revision','serverAvailable',
                   'dailyRequestLimit','dailyTokenLimit','concurrentLimit','maxOutputTokens')


class ReviewJobLedger:
    def __init__(self, path, owner, library, root, clock=time.time, lease_seconds=120, *, family="code"):
        tables = {'code': ('nonword_code_jobs', 'nonword_code_budget'),
                  'recall': ('nonword_recall_jobs', 'nonword_recall_budget'),
                  'hint': ('nonword_hint_jobs', 'nonword_hint_budget')}
        if family not in tables:
            raise ValueError('unsupported-review-family')
        self.job_table, self.budget_table = tables[family]
        self.prefix, self.job_prefix = family + '-review-', family + '-review:'
        self.schema = tuple(statement.replace('nonword_code_jobs', self.job_table)
                            .replace('nonword_code_budget', self.budget_table) for statement in SCHEMA)
        self.path = Path(path)
        self.authenticated_owner = identifier(owner)
        self.scope = (self.authenticated_owner, identifier(library), os.path.normcase(str(Path(root).resolve())))
        if not callable(clock) or type(lease_seconds) not in (int,float) or not 0 < lease_seconds <= 3600:
            raise ValueError(self.prefix+'clock')
        self.clock, self.lease_seconds = clock, lease_seconds

    @contextmanager
    def _db(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(self.path,timeout=10)) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                for statement in self.schema: db.execute(statement)
                yield db
                db.commit()
            except BaseException:
                db.rollback(); raise

    def _time(self):
        now = self.clock()
        if type(now) not in (int,float) or not math.isfinite(now): raise ValueError(self.prefix+'clock')
        return now

    def _row(self, db, job_id):
        raw = db.execute('SELECT job_id,request_id,attempt_id,input_json,input_hash,state,lease_until,generation,receipt,receipt_hash '
                         f'FROM {self.job_table} WHERE owner=? AND library=? AND root=? AND job_id=?',(*self.scope,job_id)).fetchone()
        if not raw: return None
        keys = ('jobId','requestId','attemptId','input','inputHash','state','leaseUntil','generation','receipt','receiptHash')
        row = dict(zip(keys,raw))
        try:
            row['input'] = json.loads(row['input'])
            if (fingerprint(row['input']) != row['inputHash'] or row['attemptId'] != row['input']['data']['attemptId']
                    or row['jobId'] != self.job_prefix+fingerprint([list(self.scope),row['requestId']])):
                raise ValueError(self.prefix+'integrity')
            if row['receipt'] is not None:
                row['receipt'] = json.loads(row['receipt'])
                if fingerprint(row['receipt']) != row['receiptHash']: raise ValueError(self.prefix+'integrity')
        except (KeyError,TypeError,ValueError) as error:
            raise ValueError(self.prefix+'integrity') from error
        return row

    def begin(self, request_id, data, settings):
        identifier(request_id); identifier(data['attemptId'])
        for binding in (data['binding'],data['sourceBinding']):
            if binding['ownerId'] != self.authenticated_owner or binding['libraryId'] != self.scope[1]:
                raise ValueError(self.prefix+'binding')
        body = {'data':data,'settings':{key:settings[key] for key in SETTINGS_FIELDS if key in settings}}
        digest = fingerprint(body)
        job_id = self.job_prefix+fingerprint([list(self.scope),request_id])
        now = self._time()
        with self._db() as db:
            own = self._row(db,job_id)
            if own and own['inputHash'] != digest: raise ValueError(self.prefix+'request-conflict')
            if own and own['state'] in ('prepared','done'):
                return {'kind':own['state'],'jobId':job_id,'receipt':own['receipt']}
            rows = [self._row(db,row[0]) for row in db.execute(
                f'SELECT job_id FROM {self.job_table} WHERE owner=? AND library=? AND root=? AND attempt_id=? ORDER BY rowid DESC',
                (*self.scope,data['attemptId'])).fetchall()]
            for row in rows:
                original = {key:value for key,value in row['input']['data'].items() if key!='codeReports'}
                current = {key:value for key,value in data.items() if key!='codeReports'}
                if fingerprint(original)!=fingerprint(current): raise ValueError(self.prefix+'input-conflict')
                if row['state'] in ('dispatched','uncertain'):
                    return {'kind':'wait' if row['state']=='dispatched' and row['leaseUntil']>now else 'unknown','jobId':row['jobId']}
                if row['state'] in ('prepared','done') and (row['jobId']==job_id or row['receipt']['outcome']['status']=='resolved'):
                    if fingerprint(row['input']['data']) != fingerprint(data):
                        # New reports arrived after a known reply, while the outer
                        # source result was fenced. Keep the reply but allow a new
                        # explicit review; never do this for an unknown dispatch.
                        db.execute(f"UPDATE {self.job_table} SET state='done' WHERE owner=? AND library=? AND root=? AND job_id=?",(*self.scope,row['jobId']))
                        db.execute(f"UPDATE {self.budget_table} SET state='finished',usage=? WHERE owner=? AND library=? AND root=? AND request_id=?",
                                   (row['receipt']['usage'],*self.scope,row['jobId']))
                        continue
                    return {'kind':row['state'],'jobId':row['jobId'],'receipt':row['receipt']}
                if row['state']=='preflight' and row['leaseUntil']>now:
                    return {'kind':'wait','jobId':row['jobId']}
            # Preflight never entered transport: a expired worker can be fenced
            # and its unspent reservation released without repeating a model call.
            for row in rows:
                if row['state']=='preflight':
                    db.execute(f"UPDATE {self.job_table} SET state='abandoned' WHERE owner=? AND library=? AND root=? AND job_id=?",
                               (*self.scope,row['jobId']))
                    db.execute(f"UPDATE {self.budget_table} SET reserved=0,state='released' WHERE owner=? AND library=? AND root=? AND request_id=?",
                               (*self.scope,row['jobId']))
            generation = own['generation']+1 if own else 1
            if own:
                if own['state'] != 'preflight': return {'kind':'unknown','jobId':job_id}
                db.execute(f"UPDATE {self.job_table} SET state='preflight',lease_until=?,generation=? WHERE owner=? AND library=? AND root=? AND job_id=?",
                           (now+self.lease_seconds,generation,*self.scope,job_id))
            else:
                db.execute(f'INSERT INTO {self.job_table} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (*self.scope,job_id,request_id,data['attemptId'],canonical_json(body),digest,'preflight',now+self.lease_seconds,generation,None,None))
            return {'kind':'start','jobId':job_id,'generation':generation}

    def reserve(self, ticket):
        with self._db() as db:
            row = self._active(db,ticket,'preflight')
            settings = row['input']['settings']
            limits = {key:settings.get(key,default) for key,default in
                      (('dailyRequestLimit',10),('dailyTokenLimit',20000),('concurrentLimit',1),('maxOutputTokens',2000))}
            if any(type(value) is not int or value<1 for value in limits.values()): raise ValueError(self.prefix+'invalid-budget')
            amount = len(canonical_json(row['input']['data']).encode('utf8'))+limits['maxOutputTokens']+4096
            now = self._time(); day = datetime.fromtimestamp(now,timezone.utc).date().isoformat()
            previous = db.execute(f'SELECT reserved FROM {self.budget_table} WHERE owner=? AND library=? AND root=? AND request_id=?',(*self.scope,ticket['jobId'])).fetchone()
            if previous and previous[0]>0: raise ValueError(self.prefix+'budget-conflict')
            count,tokens,active = reservation_totals(db,self.scope[0],day,now-self.lease_seconds)
            if count>=limits['dailyRequestLimit'] or tokens+amount>limits['dailyTokenLimit']: raise ValueError(self.prefix+'daily-budget')
            if active>=limits['concurrentLimit']: raise ValueError(self.prefix+'concurrent-budget')
            if previous:
                db.execute(f"UPDATE {self.budget_table} SET day=?,reserved=?,started=?,state='inflight',usage=NULL "
                           "WHERE owner=? AND library=? AND root=? AND request_id=?",
                           (day,amount,now,*self.scope,ticket['jobId']))
            else:
                db.execute(f'INSERT INTO {self.budget_table} VALUES (?,?,?,?,?,?,?,?,?)',
                           (*self.scope,ticket['jobId'],day,amount,now,'inflight',None))
            return amount

    def _active(self, db, ticket, state):
        row = self._row(db,ticket['jobId'])
        if not row or row['state']!=state or row['generation']!=ticket['generation'] or row['leaseUntil']<=self._time():
            raise ValueError(self.prefix+'execution-conflict')
        return row

    def dispatch(self, ticket):
        with self._db() as db:
            self._active(db,ticket,'preflight')
            budget = db.execute(f'SELECT reserved FROM {self.budget_table} WHERE owner=? AND library=? AND root=? AND request_id=?',(*self.scope,ticket['jobId'])).fetchone()
            if not budget or budget[0]<=0: raise ValueError(self.prefix+'budget-required')
            db.execute(f"UPDATE {self.job_table} SET state='dispatched' WHERE owner=? AND library=? AND root=? AND job_id=?",(*self.scope,ticket['jobId']))

    def abort_preflight(self, ticket):
        with self._db() as db:
            row = self._row(db,ticket['jobId'])
            if not row or row['state']!='preflight' or row['generation']!=ticket['generation']: return
            db.execute(f"UPDATE {self.job_table} SET state='abandoned' WHERE owner=? AND library=? AND root=? AND job_id=?",(*self.scope,ticket['jobId']))
            db.execute(f"UPDATE {self.budget_table} SET reserved=0,state='released' WHERE owner=? AND library=? AND root=? AND request_id=?",(*self.scope,ticket['jobId']))

    def uncertain(self, ticket):
        with self._db() as db:
            row = self._row(db,ticket['jobId'])
            if not row or row['state']!='dispatched' or row['generation']!=ticket['generation']: return
            db.execute(f"UPDATE {self.job_table} SET state='uncertain' WHERE owner=? AND library=? AND root=? AND job_id=?",(*self.scope,ticket['jobId']))

    def prepare(self, ticket, outcome, usage, trace):
        receipt = {'outcome':outcome,'usage':usage,'trace':trace}
        with self._db() as db:
            row = self._row(db,ticket['jobId'])
            if not row or row['state'] not in ('dispatched','uncertain') or row['generation']!=ticket['generation']:
                raise ValueError(self.prefix+'execution-conflict')
            amount = db.execute(f'SELECT reserved FROM {self.budget_table} WHERE owner=? AND library=? AND root=? AND request_id=?',(*self.scope,ticket['jobId'])).fetchone()[0]
            if usage is not None and (type(usage) is not int or not 0<=usage<=amount): raise ValueError(self.prefix+'usage-invalid')
            db.execute(f"UPDATE {self.job_table} SET state='prepared',receipt=?,receipt_hash=? WHERE owner=? AND library=? AND root=? AND job_id=?",
                       (canonical_json(receipt),fingerprint(receipt),*self.scope,ticket['jobId']))
            return receipt

    def finish(self, job_id):
        with self._db() as db:
            row = self._row(db,job_id)
            if not row or row['state'] not in ('prepared','done') or not row['receipt']: raise ValueError(self.prefix+'prepared-required')
            db.execute(f"UPDATE {self.job_table} SET state='done' WHERE owner=? AND library=? AND root=? AND job_id=?",(*self.scope,job_id))
            db.execute(f"UPDATE {self.budget_table} SET state='finished',usage=? WHERE owner=? AND library=? AND root=? AND request_id=?",
                       (row['receipt']['usage'],*self.scope,job_id))
            return row['receipt']


class CodeReviewLedger(ReviewJobLedger):
    """Compatibility entry: existing code job tables and identities stay exact."""
    def __init__(self, path, owner, library, root, clock=time.time, lease_seconds=120):
        super().__init__(path, owner, library, root, clock, lease_seconds, family='code')
