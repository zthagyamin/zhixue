"""Verified, recoverable subject-owned writeback for the account channel.

Raw evidence stays in Inbox. This ledger owns only local admission, baseline
and file-intent metadata. No network, credential or live-server imports.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import index_gateway as gateway
import account_sync_projection as projection
from account_sync_export import source_fingerprint
from account_sync_schema import canonical_json, check_record_binding, study_digest, study_hash, validate_bundle, validate_record


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _encoded(raw):
    return base64.b64encode(raw).decode('ascii') if raw is not None else None


def _decoded(value):
    return base64.b64decode(value, validate=True) if value is not None else None


class WritebackBlocked(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class VerifiedVaultWriter:
    def __init__(self, vault_root, owner_id, inbox, ledger_path, *, after_write=None, catalog_loader=None):
        self.catalog_loader = catalog_loader or gateway.load_gateway
        self.vault = Path(vault_root).resolve(); study_digest(owner_id)
        self.owner_id = owner_id; self.inbox = inbox; self.path = Path(ledger_path); self.after_write = after_write
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS account_vault_baselines(
                  owner_id TEXT NOT NULL,library_id TEXT NOT NULL,card_ref TEXT NOT NULL,
                  baseline_json TEXT NOT NULL,baseline_hash TEXT NOT NULL,last_fingerprint TEXT NOT NULL,
                  PRIMARY KEY(owner_id,library_id,card_ref));
                CREATE TABLE IF NOT EXISTS account_vault_jobs(
                  owner_id TEXT NOT NULL,library_id TEXT NOT NULL,event_id TEXT NOT NULL,
                  envelope_hash TEXT NOT NULL,job_hash TEXT NOT NULL,job_json TEXT NOT NULL,
                  complete INTEGER NOT NULL DEFAULT 0,proof_json TEXT,
                  PRIMARY KEY(owner_id,library_id,event_id));
                CREATE TABLE IF NOT EXISTS account_vault_targets(
                  owner_id TEXT NOT NULL,library_id TEXT NOT NULL,target_ref TEXT NOT NULL,
                  fingerprint TEXT NOT NULL,PRIMARY KEY(owner_id,library_id,target_ref));
                CREATE TABLE IF NOT EXISTS account_vault_task_jobs(
                  owner_id TEXT NOT NULL,library_id TEXT NOT NULL,event_id TEXT NOT NULL,envelope_hash TEXT NOT NULL,target_ref TEXT NOT NULL,
                  after_hash TEXT NOT NULL,record_json TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,proof_json TEXT,PRIMARY KEY(owner_id,library_id,event_id));
            ''')

    @contextmanager
    def _db(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None); db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            if db.in_transaction: db.commit()
        except BaseException:
            if db.in_transaction: db.rollback()
            raise
        finally:
            db.close()

    def _scope(self, library):
        return self.owner_id, library

    def _read(self, path):
        raw = path.read_bytes()
        if len(raw) > 4 * 1024 * 1024:
            raise WritebackBlocked('storage-unavailable')
        return raw

    def _target(self, ref, binding, *, journal=False):
        path = gateway._path(self.vault, ref, must_exist=not journal)
        if journal:
            root = gateway._records_root(self.vault, binding)
            try:relative=path.relative_to(root)
            except ValueError:raise WritebackBlocked('mapping-missing') from None
            if not relative.parts or relative.parts[0] not in ('account-study','account-study-tasks'):
                raise WritebackBlocked('mapping-missing')
        elif ref not in (binding['stateRef'], binding['progressRef'], binding.get('reviewCardPath')):
            raise WritebackBlocked('mapping-missing')
        return path

    def _source(self, binding, item_key, catalog):
        for ref in (binding['documentPath'], binding['sourceNote']):
            try: gateway._path(self.vault, ref)
            except (ValueError, OSError): raise WritebackBlocked('source-missing') from None
        current = catalog.get('bindings', {}).get(item_key)
        keys = ('itemId', 'subjectId', 'abilityId', 'sourceNote', 'stateRef', 'progressRef', 'recordsRoot', 'contentRoot', 'documentPath', 'signature', 'wordKey')
        if not current or any(current.get(key) != binding.get(key) for key in keys):
            raise WritebackBlocked('source-changed')
        fingerprints = binding.get('sourceFingerprints')
        if type(fingerprints) is not dict or set(fingerprints) != {binding['documentPath'], binding['sourceNote']}:
            raise WritebackBlocked('mapping-missing')
        captured = {ref: self._read(gateway._path(self.vault, ref)) for ref in fingerprints}
        if any(source_fingerprint(raw) != fingerprints[ref] for ref, raw in captured.items()):
            # Vocabulary evidence refers to the complete frozen word/meaning/example,
            # not every other row or later annotation in its provenance document.
            # Other question types still depend on their original source text.
            if not binding.get('wordKey'):
                raise WritebackBlocked('source-changed')
            rechecked = getattr(self, 'catalog_loader', gateway.load_gateway)(self.vault, refresh=False).get('bindings', {}).get(item_key)
            if not rechecked or any(rechecked.get(key) != binding.get(key) for key in keys):
                raise WritebackBlocked('source-changed')
            # Bracket the fresh parse with byte reads: an edit during validation
            # must not be accepted using a stale per-item signature.
            if any(self._read(gateway._path(self.vault, ref)) != raw for ref, raw in captured.items()):
                raise WritebackBlocked('source-changed')
        gateway._records_root(self.vault, binding)

    def prepare_snapshot(self, bundle, bindings):
        bundle = validate_bundle(bundle); snapshot = bundle['snapshot']; library = snapshot['libraryId']
        saved = self.inbox.get_export(self.owner_id, library, snapshot['snapshotId'])
        if saved is not None and saved != {'bundle': bundle, 'bindings': bindings}:
            raise ValueError('snapshot-private-binding-conflict')
        with gateway.LOCK:
            catalog = self.catalog_loader(self.vault, refresh=False)
            for item in bundle['items']:
                private = bindings[item['itemKey']]; binding = private['binding']; self._source(binding, item['itemKey'], catalog)
                card_ref = private.get('reviewCardPath')
                if not card_ref:
                    continue
                path = self._target(card_ref, {**binding, 'reviewCardPath': card_ref})
                text = self._read(path).decode('utf-8')
                with self._db(write=True) as db:
                    old = db.execute('SELECT * FROM account_vault_baselines WHERE owner_id=? AND library_id=? AND card_ref=?', (*self._scope(library), card_ref)).fetchone()
                    if old:
                        self._baseline(old)
                        if projection.review_fingerprint(text) != old['last_fingerprint']:
                            raise WritebackBlocked('write-conflict')
                        continue
                    known = {row['event']['eventId']: row['event']['coreHash'] for row in gateway.read_subject_events(self.vault, binding, self.owner_id)}
                    baseline = projection.capture_review_baseline(text, known, snapshot['generatedAt'])
                    db.execute('INSERT INTO account_vault_baselines VALUES(?,?,?,?,?,?)',
                               (*self._scope(library), card_ref, canonical_json(baseline), study_hash(baseline), projection.review_fingerprint(text)))

    @staticmethod
    def _baseline(row):
        value = json.loads(row['baseline_json'])
        if study_hash(value) != row['baseline_hash']:
            raise WritebackBlocked('baseline-unverified')
        return value

    def _job(self, row):
        value = json.loads(row['job_json']); record = validate_record(value['record'])
        if (study_hash(value) != row['job_hash'] or record['envelopeHash'] != row['envelope_hash']
                or record['event']['eventId'] != row['event_id'] or record['libraryId'] != row['library_id']
                or row['owner_id'] != self.owner_id or row['complete'] not in (0, 1)):
            raise ValueError('writeback-ledger-integrity')
        if row['complete']:
            if not row['proof_json'] or json.loads(row['proof_json']) != self._proof(value):
                raise ValueError('writeback-proof-integrity')
        elif row['proof_json'] is not None:
            raise ValueError('writeback-proof-integrity')
        return value

    @staticmethod
    def _proof(job):
        record = job['record']
        return {'coreHash': record['event']['coreHash'], 'proofHash': study_hash({'envelopeHash': record['envelopeHash'],
                'files': [{'ref': file['ref'], 'hash': _hash(_decoded(file['after']))} for file in job['files']], 'owned': job['owned']}),
                'targetCount': len(job['files'])}

    def _jobs(self, library):
        with self._db() as db:
            return [(dict(row), self._job(row)) for row in db.execute('SELECT * FROM account_vault_jobs WHERE owner_id=? AND library_id=? ORDER BY rowid', self._scope(library))]

    def _association(self, record):
        value = self.inbox.get_export(self.owner_id, record['libraryId'], record['snapshotId'])
        if not value:
            raise WritebackBlocked('mapping-missing')
        if record['provenanceMode'] == 'task':
            raise WritebackBlocked('dependency-pending')
        key = record['event']['item']['key']
        item = next((item for item in value['bundle']['items'] if item['itemKey'] == key), None)
        private = value['bindings'].get(key)
        if not item or not private or item['contentHash'] != record['contentHash']:
            raise WritebackBlocked('mapping-missing')
        return item, private

    def _journal_ref(self, record, binding):
        occurred = datetime.fromisoformat(record['event']['occurredAt'].replace('Z', '+00:00'))
        day = occurred.astimezone(timezone(timedelta(hours=8))).date()
        name = study_hash([self.owner_id, record['libraryId'], record['event']['eventId']]) + '.json'
        return (Path(binding['recordsRoot']) / 'account-study' / str(day.year) / f'{day.month:02d}' / name).as_posix()

    @staticmethod
    def _evidence_fingerprint(text):
        return study_hash(projection.managed_body(text, projection.ACCOUNT_EVIDENCE_BEGIN, projection.ACCOUNT_EVIDENCE_END))

    def _intent(self, record, private, jobs):
        library = record['libraryId']; binding = {**private['binding'], 'reviewCardPath': private.get('reviewCardPath')}
        journal_ref = self._journal_ref(record, binding)
        journal = {'schemaVersion': 1, 'recordKind': 'account-study-v1', 'accountId': self.owner_id,
                   'subjectId': binding['subjectId'], 'record': record, 'localContext': private['context']}
        after_journal = (canonical_json(journal) + '\n').encode('utf-8')
        journal_path = self._target(journal_ref, binding, journal=True)
        before_journal = self._read(journal_path) if journal_path.exists() else None
        if before_journal is not None and before_journal != after_journal:
            raise WritebackBlocked('write-conflict')
        files = [{'ref': journal_ref, 'kind': 'journal', 'before': _encoded(before_journal), 'after': _encoded(after_journal)}]
        owned = []
        admitted = [job for _, job in jobs] + [{'record': record, 'private': private}]
        if projection.effective_events([record]):
            for ref in dict.fromkeys([binding['stateRef'], binding['progressRef']]):
                groups = {}
                for job in admitted:
                    local = job['private']['binding']
                    if ref not in (local['stateRef'], local['progressRef']):
                        continue
                    groups.setdefault(local['abilityId'], []).extend(projection.effective_events([job['record']]))
                path = self._target(ref, binding); before = self._read(path); text = before.decode('utf-8')
                with self._db() as db:
                    old = db.execute('SELECT fingerprint FROM account_vault_targets WHERE owner_id=? AND library_id=? AND target_ref=?', (*self._scope(library), ref)).fetchone()
                expected = old['fingerprint'] if old else study_hash(None)
                if self._evidence_fingerprint(text) != expected:
                    raise WritebackBlocked('write-conflict')
                after = projection.render_account_evidence(text, groups)
                files.append({'ref': ref, 'kind': 'evidence', 'before': _encoded(before), 'after': _encoded(after.encode('utf-8'))})
                owned.append({'ref': ref, 'fingerprint': self._evidence_fingerprint(after)})
            card_ref = private.get('reviewCardPath')
            if card_ref:
                path = self._target(card_ref, binding); before = self._read(path); text = before.decode('utf-8')
                with self._db() as db:
                    baseline_row = db.execute('SELECT * FROM account_vault_baselines WHERE owner_id=? AND library_id=? AND card_ref=?', (*self._scope(library), card_ref)).fetchone()
                if not baseline_row:
                    raise WritebackBlocked('baseline-unverified')
                baseline = self._baseline(baseline_row)
                if projection.review_fingerprint(text) != baseline_row['last_fingerprint']:
                    raise WritebackBlocked('write-conflict')
                evidence = [{'record': job['record'], 'entryName': job['private']['reviewEntryName']} for job in admitted if job['private'].get('reviewCardPath') == card_ref]
                try:
                    state = projection.replay_review_queue(baseline, evidence)
                except ValueError:
                    raise WritebackBlocked('baseline-unverified') from None
                after = projection.render_review_queue(text, state)
                files.append({'ref': card_ref, 'kind': 'queue', 'before': _encoded(before), 'after': _encoded(after.encode('utf-8'))})
                owned.append({'ref': card_ref, 'queueFingerprint': projection.review_fingerprint(after), 'baselineHash': baseline['baselineHash']})
        if len({file['ref'] for file in files}) != len(files):
            raise WritebackBlocked('mapping-missing')
        occupied = {file['ref'] for row, job in jobs if not row['complete'] for file in job['files']}
        if occupied.intersection(file['ref'] for file in files):
            raise WritebackBlocked('write-conflict')
        return {'record': record, 'private': private, 'files': files, 'owned': owned}

    def _write(self, path, before, after, binding, journal):
        ref = path.relative_to(self.vault).as_posix()
        current = self._read(path) if path.exists() else None
        if current == after:
            return
        if current != before:
            raise WritebackBlocked('write-conflict')
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._target(ref, binding, journal=journal) != path:
            raise WritebackBlocked('write-conflict')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.zhixue-account-', suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name); handle.write(after); handle.flush(); os.fsync(handle.fileno())
            if (self._target(ref, binding, journal=journal) != path
                    or (self._read(path) if path.exists() else None) != before):
                raise WritebackBlocked('write-conflict')
            os.replace(temporary, path); temporary = None
            if self._read(path) != after:
                raise WritebackBlocked('write-conflict')
            if self.after_write:
                self.after_write(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _finish(self, job):
        record = job['record']; private = job['private']; binding = {**private['binding'], 'reviewCardPath': private.get('reviewCardPath')}
        self._source(binding, record['event']['item']['key'], self.catalog_loader(self.vault, refresh=False))
        for file in job['files']:
            if file['kind'] != 'journal':
                self._source(binding, record['event']['item']['key'], self.catalog_loader(self.vault, refresh=False))
            path = self._target(file['ref'], binding, journal=file['kind'] == 'journal')
            self._write(path, _decoded(file['before']), _decoded(file['after']), binding, file['kind'] == 'journal')
        for file in job['files']:
            if self._read(self._target(file['ref'], binding, journal=file['kind'] == 'journal')) != _decoded(file['after']):
                raise WritebackBlocked('write-conflict')
        proof = self._proof(job)
        with self._db(write=True) as db:
            for owned in job['owned']:
                if 'queueFingerprint' in owned:
                    db.execute('UPDATE account_vault_baselines SET last_fingerprint=? WHERE owner_id=? AND library_id=? AND card_ref=?', (owned['queueFingerprint'], *self._scope(record['libraryId']), owned['ref']))
                else:
                    db.execute('INSERT INTO account_vault_targets VALUES(?,?,?,?) ON CONFLICT(owner_id,library_id,target_ref) DO UPDATE SET fingerprint=excluded.fingerprint', (*self._scope(record['libraryId']), owned['ref'], owned['fingerprint']))
            db.execute('UPDATE account_vault_jobs SET complete=1,proof_json=? WHERE owner_id=? AND library_id=? AND event_id=?',
                       (canonical_json(proof), *self._scope(record['libraryId']), record['event']['eventId']))
        return proof

    def _task_result(self,record,catalog):
        operation=self.inbox.plan_operation_for_hash(self.owner_id,record['libraryId'],record['planHash'])
        if not operation:raise WritebackBlocked('dependency-pending')
        task=next((task for task in operation['plan']['tasks'] if task['taskId']==record['event']['taskId']),None)
        if not task or record['assignmentId']!=task['taskId'] or record['event']['subjectId']!=task['subjectId'] or record['event']['unitIds']!=task['unitIds'] or record['event']['source']!='self-report' or task['completionRule']!='self-report':raise WritebackBlocked('mapping-missing')
        planning=self.inbox.planning_for_catalog(self.owner_id,record['libraryId'],operation['plan']['catalogHash'])
        route=planning.get('routes',{}).get(task['subjectId']) if planning else None
        current=next((definition for definition in catalog.get('planningDefinitions',[]) if definition['id']==task['subjectId']),None)
        if not route or not current or any(route[key]!=current[key] for key in ('id','contentRoot','recordsRoot','progressRef')):raise WritebackBlocked('source-changed')
        occurred=datetime.fromisoformat(record['event']['occurredAt'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8)));name=study_hash([self.owner_id,record['libraryId'],record['event']['eventId']])+'.json'
        ref=(Path(route['recordsRoot'])/'account-study-tasks'/str(occurred.year)/f'{occurred.month:02d}'/name).as_posix();binding={**route,'subjectId':task['subjectId']};path=self._target(ref,binding,journal=True)
        row={'schemaVersion':1,'recordKind':'account-task-v1','accountId':self.owner_id,'subjectId':task['subjectId'],'record':record};after=(canonical_json(row)+'\n').encode();after_hash=_hash(after)
        with self._db() as db:
            old=db.execute('SELECT * FROM account_vault_task_jobs WHERE owner_id=? AND library_id=? AND event_id=?',(*self._scope(record['libraryId']),record['event']['eventId'])).fetchone()
        if old:
            if old['envelope_hash']!=record['envelopeHash'] or old['target_ref']!=ref or old['after_hash']!=after_hash or json.loads(old['record_json'])!=record:raise WritebackBlocked('write-conflict')
            proof=json.loads(old['proof_json']) if old['complete'] else None
        else:
            with self._db(write=True) as db:db.execute('INSERT INTO account_vault_task_jobs(owner_id,library_id,event_id,envelope_hash,target_ref,after_hash,record_json) VALUES(?,?,?,?,?,?,?)',(*self._scope(record['libraryId']),record['event']['eventId'],record['envelopeHash'],ref,after_hash,canonical_json(record)))
            proof=None
        if proof is None:
            before=self._read(path) if path.exists() else None
            if before is not None and before!=after:raise WritebackBlocked('write-conflict')
            self._write(path,before,after,binding,True);proof={'coreHash':record['event']['coreHash'],'proofHash':study_hash({'envelopeHash':record['envelopeHash'],'target':after_hash}),'targetCount':1}
            with self._db(write=True) as db:db.execute('UPDATE account_vault_task_jobs SET complete=1,proof_json=? WHERE owner_id=? AND library_id=? AND event_id=? AND complete=0',(canonical_json(proof),*self._scope(record['libraryId']),record['event']['eventId']))
        if self._read(path)!=after:raise WritebackBlocked('write-conflict')
        return proof

    def task_events(self,library):
        with self._db() as db:rows=db.execute('SELECT * FROM account_vault_task_jobs WHERE owner_id=? AND library_id=? AND complete=1 AND proof_json IS NOT NULL ORDER BY rowid',self._scope(library)).fetchall()
        result=[]
        for row in rows:
            record=validate_record(json.loads(row['record_json']));proof=json.loads(row['proof_json'])
            expected_bytes=(canonical_json({'schemaVersion':1,'recordKind':'account-task-v1','accountId':self.owner_id,'subjectId':record['event']['subjectId'],'record':record})+'\n').encode();target=(self.vault/row['target_ref']).resolve()
            try:target.relative_to(self.vault)
            except ValueError:raise ValueError('task-proof-integrity') from None
            expected_proof={'coreHash':record['event']['coreHash'],'proofHash':study_hash({'envelopeHash':record['envelopeHash'],'target':row['after_hash']}),'targetCount':1}
            if row['envelope_hash']!=record['envelopeHash'] or row['after_hash']!=_hash(expected_bytes) or proof!=expected_proof or not target.is_file() or target.read_bytes()!=expected_bytes:raise ValueError('task-proof-integrity')
            result.append(record['event'])
        return result

    def process(self, rows, pending):
        records = [validate_record(row['record']) for row in rows]
        wanted = {row['record']['event']['eventId'] for row in pending}
        results = {}
        with gateway.LOCK:
            remaining = [record for record in records if record['event']['eventId'] in wanted]
            # A child downloaded before its parent is retried after that parent
            # is durably admitted; no network or browser must remain open here.
            while remaining:
                progressed = False; retry = []
                for record in remaining:
                    event_id = record['event']['eventId']; library = record['libraryId']
                    try:
                        if record['provenanceMode']=='task':
                            proof=self._task_result(record,self.catalog_loader(self.vault,refresh=False));results[event_id]={'eventId':event_id,'status':'applied','proof':proof};progressed=True;continue
                        jobs = self._jobs(library)
                        existing = next(((row, job) for row, job in jobs if row['event_id'] == event_id), None)
                        if existing:
                            row, job = existing
                            if row['envelope_hash'] != record['envelopeHash']:
                                raise WritebackBlocked('write-conflict')
                            proof = json.loads(row['proof_json']) if row['complete'] else self._finish(job)
                        else:
                            item, private = self._association(record)
                            self._source(private['binding'], record['event']['item']['key'], self.catalog_loader(self.vault, refresh=False))
                            try:
                                state = check_record_binding(record, item, records)
                            except ValueError:
                                raise WritebackBlocked('write-conflict') from None
                            if state != 'ready':
                                raise WritebackBlocked('dependency-pending')
                            if record['parentEventId'] is not None and not any(row['event_id'] == record['parentEventId'] and row['complete'] for row, _ in jobs):
                                retry.append(record); continue
                            job = self._intent(record, private, jobs)
                            with self._db(write=True) as db:
                                db.execute('INSERT INTO account_vault_jobs(owner_id,library_id,event_id,envelope_hash,job_hash,job_json) VALUES(?,?,?,?,?,?)',
                                           (*self._scope(library), event_id, record['envelopeHash'], study_hash(job), canonical_json(job)))
                            proof = self._finish(job)
                        results[event_id] = {'eventId': event_id, 'status': 'applied', 'proof': proof}; progressed = True
                    except WritebackBlocked as error:
                        results[event_id] = {'eventId': event_id, 'status': 'blocked', 'reason': error.reason}
                    except sqlite3.Error:
                        results[event_id] = {'eventId': event_id, 'status': 'blocked', 'reason': 'storage-unavailable'}
                    except (ValueError, OSError):
                        results[event_id] = {'eventId': event_id, 'status': 'blocked', 'reason': 'writeback-failed'}
                if not progressed:
                    for record in retry:
                        event_id = record['event']['eventId']; results[event_id] = {'eventId': event_id, 'status': 'blocked', 'reason': 'dependency-pending'}
                    break
                remaining = retry
        return [results[row['record']['event']['eventId']] for row in pending]
