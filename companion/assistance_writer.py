"""Subject-owned immutable auxiliary JSON and reconstructible monthly Markdown.

Each pair has a durable intent and idempotent per-file replacements; this is not
a cross-file atomic transaction. Original materials and learning state are never
targets. File/path compare-and-readback detects conflicts but cannot lock editors.
"""
from __future__ import annotations
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import index_gateway as gateway
from account_sync_schema import canonical_json, study_hash, study_id, study_iso, study_count, study_object
from account_sync_writer import VerifiedVaultWriter, WritebackBlocked, _hash, _encoded, _decoded
from assistance_binding import binding_hash
from assistance_schema import validate_account_assistance, validate_native_assistance, validate_parent

ACTION_LABELS = {'meaning-check':'释义核对', 'meaning-study':'不会时查看释义', 'reference-answer':'展开参考答案', 'ai-hint':'AI 提示', 'ai-tutor':'AI 导师帮助', 'answer-feedback':'作答后反馈'}
MODE_LABELS = {'three-stage':'三阶段背词', 'quiz':'选择题', 'recall':'回忆', 'calculation':'计算', 'code':'代码练习', 'flashcard':'闪卡', 'spelling':'拼写'}


def _month(occurred):
    value = datetime.fromisoformat(occurred.replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8)))
    return value.strftime('%Y'), value.strftime('%m')


def _filename(owner, channel, library, summary_id):
    return study_hash([owner, channel, library, summary_id]) + '.json'


def _document(owner, channel, library, record, occurred):
    body = dict(schemaVersion=1, recordKind='assistance-summary-v1', ownerId=owner, channel=channel, libraryId=library, occurredAt=occurred, record=record)
    return dict(body, documentHash=study_hash(body))


def _parse_document(raw):
    study_object(raw, ['schemaVersion', 'recordKind', 'ownerId', 'channel', 'libraryId', 'occurredAt', 'record', 'documentHash'])
    if study_count(raw['schemaVersion']) != 1 or raw['recordKind'] != 'assistance-summary-v1' or raw['channel'] not in ('account', 'local'):
        raise WritebackBlocked('write-conflict')
    study_id(raw['ownerId']); study_id(raw['libraryId']); study_iso(raw['occurredAt'])
    record = validate_account_assistance(raw['record']) if raw['channel'] == 'account' else validate_native_assistance(raw['record'])
    if (raw['channel']=='account' and record['libraryId']!=raw['libraryId']) or (raw['channel']=='local' and raw['libraryId']!='native'):
        raise WritebackBlocked('write-conflict')
    expected = _document(raw['ownerId'], raw['channel'], raw['libraryId'], record, raw['occurredAt'])
    if expected != raw: raise WritebackBlocked('write-conflict')
    return expected


def render_month(documents, year, month):
    """A deterministic report from immutable records; empty does not mean unaided."""
    lines = ['---', 'type: zhixue-assistance-summary', 'schema_version: 1', f'month: "{year}-{month}"', '---',
             f'# 辅助学习摘要 · {year}-{month}', '', '只汇总本次页面观察到的辅助行为；不改变评分、复习计划或正式掌握状态。', '',
             '| 学习时间 | 练习方式 | 作答前辅助 | 作答后反馈 | 原作答 ID | 记录 |', '|---|---|---|---|---|---|']
    def actions(rows, empty): return '、'.join(f"{ACTION_LABELS[row['action']]} × {row['count']}" for row in rows) if rows else empty
    for doc in sorted(documents, key=lambda row:(row['occurredAt'], row['record']['summary']['summaryId'])):
        summary = doc['record']['summary']; occurred = datetime.fromisoformat(doc['occurredAt'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8)))
        name = _filename(doc['ownerId'], doc['channel'], doc['libraryId'], summary['summaryId'])
        event_id = summary['attemptEventId'].replace('`', '′').replace('|', r'\|')
        link = '[[' + name + r'\|摘要]]'
        lines.append(f"| {occurred:%m-%d %H:%M} | {MODE_LABELS[summary['practiceMode']]} | {actions(summary['preSubmitAssistance'], '本次页面未记录作答前辅助')} | {actions(summary['postSubmitFeedback'], '本次页面未记录反馈')} | `{event_id}` | {link} |")
    return ('\n'.join(lines)+'\n').encode('utf-8')


class AssistanceVaultWriter:
    def __init__(self, vault_root, owner_id, ledger_path, *, after_write=None):
        self.vault = Path(vault_root).resolve(); study_id(owner_id); self.owner_id = owner_id
        self.path = Path(ledger_path); self.after_write = after_write; self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS assistance_vault_jobs(
              owner_id TEXT NOT NULL,channel TEXT NOT NULL,library_id TEXT NOT NULL,summary_id TEXT NOT NULL,
              association_hash TEXT NOT NULL,month_ref TEXT NOT NULL,job_hash TEXT NOT NULL,job_json TEXT NOT NULL,
              complete INTEGER NOT NULL DEFAULT 0,proof_json TEXT,PRIMARY KEY(owner_id,channel,library_id,summary_id));''')

    @contextmanager
    def _db(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None); db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN'); yield db
            if db.in_transaction: db.commit()
        except BaseException:
            if db.in_transaction: db.rollback()
            raise
        finally: db.close()

    def _read(self, path): return VerifiedVaultWriter._read(self, path)

    def _target(self, ref, binding, *, journal=True):
        if not journal: raise WritebackBlocked('mapping-missing')
        path = gateway._path(self.vault, ref, must_exist=False); root = gateway._records_root(self.vault, binding)
        if path!=self.vault/ref or not path.is_relative_to(root) or path.relative_to(root).parts[0:1] != ('assistance',):
            raise WritebackBlocked('mapping-missing')
        return path

    def _write(self, path, before, after, binding):
        # Reuse the tested fsync/replace/path-check/readback implementation, with
        # this writer's strictly auxiliary-only _target. No legacy ledger/state.
        VerifiedVaultWriter._write(self, path, before, after, binding, True)

    def _documents(self, parent, binding, year, month):
        result, size = [], 0
        if not parent.exists(): return result
        for file in sorted(parent.glob('*.json')):
            path = self._target(file.relative_to(self.vault).as_posix(), binding); raw = self._read(path); size += len(raw)
            if size > 32*1024*1024 or len(result) >= 10000: raise WritebackBlocked('storage-unavailable')
            doc = _parse_document(json.loads(raw))
            if _month(doc['occurredAt']) != (year, month) or path.name != _filename(doc['ownerId'],doc['channel'],doc['libraryId'],doc['record']['summary']['summaryId']):
                raise WritebackBlocked('write-conflict')
            if doc['ownerId'] == self.owner_id: result.append(doc)
        return result

    @staticmethod
    def _proof(job):
        return dict(attemptCoreHash=job['record']['summary']['attemptCoreHash'], targetCount=2,
                    proofHash=study_hash(dict(associationHash=job['record']['associationHash'], files=[dict(ref=file['ref'], hash=_hash(_decoded(file['after']))) for file in job['files']])))

    def _job(self, row, scope, record, binding):
        value = json.loads(row['job_json'])
        if (row['owner_id'],row['channel'],row['library_id']) != scope or row['summary_id'] != record['summary']['summaryId'] or row['association_hash'] != record['associationHash'] or study_hash(value) != row['job_hash']:
            raise WritebackBlocked('write-conflict')
        if value['record'] != record or value['binding'] != binding or row['complete'] not in (0,1) or len(value['files']) != 2 or value['files'][1]['ref'] != row['month_ref']:
            raise WritebackBlocked('write-conflict')
        if row['complete'] and (not row['proof_json'] or json.loads(row['proof_json']) != self._proof(value)):
            raise WritebackBlocked('write-conflict')
        if not row['complete'] and row['proof_json'] is not None: raise WritebackBlocked('write-conflict')
        return value

    def _apply(self, channel, library, record, event, binding, check_source):
        scope = (self.owner_id,channel,library); summary_id = record['summary']['summaryId']; year, month = _month(event['occurredAt'])
        root = gateway._records_root(self.vault,binding); folder = root/'assistance'/year/month
        json_ref = (folder/_filename(*scope,summary_id)).relative_to(self.vault).as_posix()
        month_ref = (folder/('summary-'+study_hash(self.owner_id)+'.md')).relative_to(self.vault).as_posix()
        with gateway.LOCK:
            with self._db() as db:
                row = db.execute('SELECT * FROM assistance_vault_jobs WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?',(*scope,summary_id)).fetchone()
            if row:
                job = self._job(row,scope,record,binding)
                if job['files'][0]['ref']!=json_ref: raise WritebackBlocked('write-conflict')
                if row['complete']:
                    if self._read(self._target(json_ref,binding))!=_decoded(job['files'][0]['after']): raise WritebackBlocked('write-conflict')
                    documents=self._documents(folder,binding,year,month)
                    if self._read(self._target(month_ref,binding))!=render_month(documents,year,month): raise WritebackBlocked('write-conflict')
                    return self._proof(job)
            else:
                check_source()
                with self._db() as db:
                    waiting=db.execute('SELECT 1 FROM assistance_vault_jobs WHERE owner_id=? AND month_ref=? AND complete=0 LIMIT 1',(self.owner_id,month_ref)).fetchone()
                if waiting: raise WritebackBlocked('dependency-pending')
                json_path=self._target(json_ref,binding); month_path=self._target(month_ref,binding)
                doc=_document(*scope,record,event['occurredAt']); after_json=(canonical_json(doc)+'\n').encode('utf-8')
                before_json=self._read(json_path) if json_path.exists() else None
                if before_json is not None and before_json!=after_json: raise WritebackBlocked('write-conflict')
                documents=self._documents(folder,binding,year,month)
                others=[old for old in documents if _filename(old['ownerId'],old['channel'],old['libraryId'],old['record']['summary']['summaryId'])!=json_path.name]
                before_month=self._read(month_path) if month_path.exists() else None
                if before_month is not None and before_month not in (render_month(documents,year,month),render_month(others,year,month)): raise WritebackBlocked('write-conflict')
                job=dict(record=record,binding=binding,files=[dict(ref=json_ref,before=_encoded(before_json),after=_encoded(after_json)),dict(ref=month_ref,before=_encoded(before_month),after=_encoded(render_month([*others,doc],year,month)))])
                with self._db(write=True) as db:
                    db.execute('INSERT INTO assistance_vault_jobs(owner_id,channel,library_id,summary_id,association_hash,month_ref,job_hash,job_json) VALUES(?,?,?,?,?,?,?,?)',(*scope,summary_id,record['associationHash'],month_ref,study_hash(job),canonical_json(job)))
            complete_files=all((path:=self._target(file['ref'],binding)).is_file() and self._read(path)==_decoded(file['after']) for file in job['files'])
            if not complete_files:
                for file in job['files']:
                    check_source(); self._write(self._target(file['ref'],binding),_decoded(file['before']),_decoded(file['after']),binding)
                check_source()
            # A completed immutable file pair can recover its lost receipt even
            # if materials changed later. No new file writes or retargeting here.
            for file in job['files']:
                if self._read(self._target(file['ref'],binding))!=_decoded(file['after']): raise WritebackBlocked('write-conflict')
            proof=self._proof(job)
            with self._db(write=True) as db:
                db.execute('UPDATE assistance_vault_jobs SET complete=1,proof_json=? WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?',(canonical_json(proof),*scope,summary_id))
            return proof

    def apply_account(self, raw, core_writer):
        record=validate_account_assistance(raw)
        if core_writer.owner_id!=self.owner_id or core_writer.vault!=self.vault: raise WritebackBlocked('mapping-missing')
        row=core_writer.inbox.get_record(self.owner_id,record['libraryId'],record['summary']['attemptEventId'])
        if not row or row['status']!='applied': raise WritebackBlocked('dependency-pending')
        parent=row['record']; validate_account_assistance(record,parent); _,private=core_writer._association(parent); binding=private['binding']
        def check(): core_writer._source(binding,parent['event']['item']['key'],gateway.load_gateway(self.vault,refresh=False))
        return self._apply('account',record['libraryId'],record,parent['event'],binding,check)

    def apply_native(self, raw, event, route):
        record=validate_native_assistance(raw); sidecar=route.get('assistanceBinding')
        if not sidecar: raise WritebackBlocked(route.get('assistanceBindingIssue','baseline-unverified'))
        if sidecar!=record['binding']: raise WritebackBlocked('source-changed')
        validate_parent(record['summary'],event,sidecar['practiceMode'])
        binding={**route['binding'],'sourceFingerprints':route.get('assistanceSources')}
        def check():
            VerifiedVaultWriter._source(self,binding,event['item']['key'],gateway.load_gateway(self.vault,refresh=False))
            if binding_hash(self.vault,binding)!=sidecar['localBindingHash']: raise WritebackBlocked('source-changed')
        return self._apply('local','native',record,event,binding,check)
