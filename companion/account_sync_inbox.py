"""Separate durable account inbox; raw evidence, receipts and cursors never mix.

Each method owns a short SQLite transaction. There is no network or Vault I/O
under the database lock. The legacy Companion database/tables are untouched.
"""
from __future__ import annotations

import copy
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from account_sync_schema import (canonical_json, study_count, study_digest, study_hash, study_id, study_text,
                                 study_object, study_size, validate_bundle, validate_record, validate_receipt)
from account_sync_planning import validate_planning_catalog, validate_planning_facts

DDL = '''
CREATE TABLE IF NOT EXISTS account_inbox_cursors(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL DEFAULT 0,
 through_cursor INTEGER,complete_cursor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,library_id));
CREATE TABLE IF NOT EXISTS account_inbox_pages(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL,through_cursor INTEGER NOT NULL,
 page_hash TEXT NOT NULL,PRIMARY KEY(account_id,library_id,after_cursor,through_cursor));
CREATE TABLE IF NOT EXISTS account_inbox_records(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 envelope_hash TEXT NOT NULL,record_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(account_id,library_id,event_id),UNIQUE(account_id,library_id,sequence));
CREATE TABLE IF NOT EXISTS account_inbox_receipts(
 outbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,library_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL,event_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,cloud_sequence INTEGER,
 UNIQUE(account_id,library_id,receipt_id),
 FOREIGN KEY(account_id,library_id,event_id) REFERENCES account_inbox_records(account_id,library_id,event_id));
CREATE INDEX IF NOT EXISTS account_inbox_outbox ON account_inbox_receipts(account_id,library_id,cloud_sequence,outbox_sequence);
CREATE TABLE IF NOT EXISTS account_inbox_exports(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,revision INTEGER NOT NULL,
 export_hash TEXT NOT NULL,export_json TEXT NOT NULL,PRIMARY KEY(account_id,library_id,snapshot_id),
 UNIQUE(account_id,library_id,revision));
CREATE TABLE IF NOT EXISTS account_inbox_publications(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,
 begun INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,library_id,snapshot_id),
 FOREIGN KEY(account_id,library_id,snapshot_id) REFERENCES account_inbox_exports(account_id,library_id,snapshot_id));
CREATE TABLE IF NOT EXISTS account_inbox_planning_exports(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,catalog_hash TEXT NOT NULL,
 catalog_json TEXT NOT NULL,materials_hash TEXT NOT NULL,materials_json TEXT NOT NULL,routes_hash TEXT NOT NULL,routes_json TEXT NOT NULL,cloud_acked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,library_id,snapshot_id),
 FOREIGN KEY(account_id,library_id,snapshot_id) REFERENCES account_inbox_exports(account_id,library_id,snapshot_id));
CREATE TABLE IF NOT EXISTS account_inbox_planning_facts(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,library_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
 facts_hash TEXT NOT NULL,facts_json TEXT NOT NULL,cloud_acked INTEGER NOT NULL DEFAULT 0,
 UNIQUE(account_id,library_id,facts_hash),
 FOREIGN KEY(account_id,library_id,snapshot_id) REFERENCES account_inbox_planning_exports(account_id,library_id,snapshot_id));
CREATE TABLE IF NOT EXISTS account_inbox_plan_cursors(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL DEFAULT 0,through_cursor INTEGER,complete_cursor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,library_id));
CREATE TABLE IF NOT EXISTS account_inbox_plan_operations(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,operation_hash TEXT NOT NULL,operation_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(account_id,library_id,operation_id),UNIQUE(account_id,library_id,sequence));
CREATE TABLE IF NOT EXISTS account_inbox_plan_receipts(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,library_id TEXT NOT NULL,receipt_id TEXT NOT NULL,operation_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,cloud_sequence INTEGER,
 UNIQUE(account_id,library_id,receipt_id),FOREIGN KEY(account_id,library_id,operation_id) REFERENCES account_inbox_plan_operations(account_id,library_id,operation_id));
CREATE TABLE IF NOT EXISTS account_inbox_content_cursors(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL DEFAULT 0,through_cursor INTEGER,complete_cursor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,library_id));
CREATE TABLE IF NOT EXISTS account_inbox_content_operations(
 account_id TEXT NOT NULL,library_id TEXT NOT NULL,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,operation_hash TEXT NOT NULL,operation_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(account_id,library_id,operation_id),UNIQUE(account_id,library_id,sequence));
CREATE TABLE IF NOT EXISTS account_inbox_content_receipts(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,library_id TEXT NOT NULL,receipt_id TEXT NOT NULL,operation_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,cloud_sequence INTEGER,
 UNIQUE(account_id,library_id,receipt_id),FOREIGN KEY(account_id,library_id,operation_id) REFERENCES account_inbox_content_operations(account_id,library_id,operation_id));
'''


def _scope(account_id, library_id):
    return study_id(account_id, 'account'), study_id(library_id, 'library')


class Inbox:
    def __init__(self, database_path):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(DDL)

    @contextmanager
    def _connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            if db.in_transaction:
                db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    def _cursor(self, db, scope):
        row = db.execute('SELECT * FROM account_inbox_cursors WHERE account_id=? AND library_id=?', scope).fetchone()
        if not row:
            return {'after': 0, 'through': None, 'completeThrough': 0}
        after = study_count(row['after_cursor']); complete = study_count(row['complete_cursor'])
        through = row['through_cursor']
        if through is not None:
            study_count(through)
        if complete > after or (through is None and after != complete) or (through is not None and through <= after):
            raise ValueError('inbox-cursor-integrity')
        return {'after': after, 'through': through, 'completeThrough': complete}

    def cursor(self, account_id, library_id):
        with self._connect() as db:
            return self._cursor(db, _scope(account_id, library_id))

    def _record(self, row, scope, db):
        record = validate_record(json.loads(row['record_json']))
        if ((row['account_id'], row['library_id']) != scope or record['libraryId'] != scope[1]
                or row['event_id'] != record['event']['eventId'] or row['envelope_hash'] != record['envelopeHash']
                or row['status'] not in ('pending', 'received', 'blocked', 'applied')):
            raise ValueError('inbox-record-integrity')
        study_count(row['sequence'], minimum=1)
        latest = db.execute('SELECT * FROM account_inbox_receipts WHERE account_id=? AND library_id=? AND event_id=? ORDER BY outbox_sequence DESC LIMIT 1', (*scope, row['event_id'])).fetchone()
        receipt = self._receipt(latest, scope) if latest else None
        if (row['status'] != (receipt['status'] if receipt else 'pending')
                or (receipt and (receipt['envelopeHash'] != record['envelopeHash']
                    or (receipt['status'] == 'applied' and receipt['proof']['coreHash'] != record['event']['coreHash'])))):
            raise ValueError('inbox-status-integrity')
        return {'sequence': row['sequence'], 'record': record, 'status': row['status']}

    def receive_page(self, account_id, library_id, page, *, after=None):
        scope = _scope(account_id, library_id)
        if after is None:
            after = self.cursor(*scope)['after']
        study_count(after); study_object(page, ['records', 'through', 'nextCursor']); study_size(page, 2200000)
        through = study_count(page['through']); next_cursor = page['nextCursor']
        if through < after or type(page['records']) is not list or len(page['records']) > 20:
            raise ValueError('invalid-inbox-page')
        records, previous = [], after
        for entry in page['records']:
            study_object(entry, ['sequence', 'record']); sequence = study_count(entry['sequence'], minimum=1)
            record = validate_record(entry['record'])
            if not previous < sequence <= through or record['libraryId'] != library_id:
                raise ValueError('invalid-inbox-page-binding')
            records.append((sequence, record)); previous = sequence
        if next_cursor is not None:
            study_count(next_cursor)
            if not records or next_cursor != previous or previous >= through:
                raise ValueError('invalid-inbox-read-fence')
        elif previous != through:
            raise ValueError('incomplete-inbox-read-fence')
        digest = study_hash(page)
        with self._connect(write=True) as db:
            old_page = db.execute('SELECT page_hash FROM account_inbox_pages WHERE account_id=? AND library_id=? AND after_cursor=? AND through_cursor=?', (*scope, after, through)).fetchone()
            if old_page:
                if old_page['page_hash'] != digest:
                    raise ValueError('inbox-page-conflict')
                # Even a retry must not hide corrupt durable evidence.
                for sequence, record in records:
                    row = db.execute('SELECT * FROM account_inbox_records WHERE account_id=? AND library_id=? AND event_id=?', (*scope, record['event']['eventId'])).fetchone()
                    if not row or self._record(row, scope, db)['record'] != record or row['sequence'] != sequence:
                        raise ValueError('inbox-record-conflict')
                return 'duplicate'
            cursor = self._cursor(db, scope)
            if cursor['after'] != after or (cursor['through'] is not None and cursor['through'] != through):
                raise ValueError('inbox-cursor-conflict')
            for sequence, record in records:
                row = db.execute('SELECT * FROM account_inbox_records WHERE account_id=? AND library_id=? AND (event_id=? OR sequence=?)', (*scope, record['event']['eventId'], sequence)).fetchone()
                if row:
                    if self._record(row, scope, db)['record'] != record or row['sequence'] != sequence:
                        raise ValueError('inbox-record-conflict')
                else:
                    db.execute('INSERT INTO account_inbox_records(account_id,library_id,event_id,sequence,envelope_hash,record_json) VALUES(?,?,?,?,?,?)',
                               (*scope, record['event']['eventId'], sequence, record['envelopeHash'], canonical_json(record)))
            db.execute('INSERT INTO account_inbox_pages VALUES(?,?,?,?,?)', (*scope, after, through, digest))
            db.execute('INSERT INTO account_inbox_cursors VALUES(?,?,?,?,?) ON CONFLICT(account_id,library_id) DO UPDATE SET after_cursor=excluded.after_cursor,through_cursor=excluded.through_cursor,complete_cursor=excluded.complete_cursor',
                       (*scope, previous, through if next_cursor is not None else None, cursor['completeThrough'] if next_cursor is not None else through))
        return 'accepted'

    def records_through(self, account_id, library_id, *, pending_only=False):
        scope = _scope(account_id, library_id)
        with self._connect() as db:
            fence = self._cursor(db, scope)['completeThrough']
            rows = db.execute('SELECT * FROM account_inbox_records WHERE account_id=? AND library_id=? AND sequence<=? ORDER BY sequence', (*scope, fence)).fetchall()
            checked = [self._record(row, scope, db) for row in rows]
            return [row for row in checked if not pending_only or row['status'] != 'applied']

    def pending_records(self, account_id, library_id):
        return self.records_through(account_id, library_id, pending_only=True)

    def get_record(self, account_id, library_id, event_id):
        """Verified complete-fence point read for an auxiliary association."""
        scope = _scope(account_id, library_id); study_id(event_id)
        with self._connect() as db:
            row = db.execute('SELECT * FROM account_inbox_records WHERE account_id=? AND library_id=? AND event_id=?', (*scope, event_id)).fetchone()
            if not row or row['sequence'] > self._cursor(db, scope)['completeThrough']:
                return None
            return self._record(row, scope, db)

    def _receipt(self, row, scope):
        receipt = validate_receipt(json.loads(row['receipt_json']))
        if ((row['account_id'], row['library_id']) != scope or receipt['receiptId'] != row['receipt_id']
                or receipt['eventId'] != row['event_id'] or study_hash(receipt) != row['receipt_hash']):
            raise ValueError('inbox-receipt-integrity')
        return receipt

    def set_result(self, account_id, library_id, event_id, status, *, reason=None, proof=None):
        scope = _scope(account_id, library_id); study_id(event_id)
        with self._connect(write=True) as db:
            row = db.execute('SELECT * FROM account_inbox_records WHERE account_id=? AND library_id=? AND event_id=?', (*scope, event_id)).fetchone()
            if not row or row['sequence'] > self._cursor(db, scope)['completeThrough']:
                raise ValueError('unknown-complete-inbox-record')
            record = self._record(row, scope, db)['record']
            body = {'schemaVersion': 1, 'eventId': event_id, 'envelopeHash': record['envelopeHash'], 'status': status}
            if reason is not None:
                body['reason'] = reason
            if proof is not None:
                body['proof'] = proof
            latest = db.execute('SELECT * FROM account_inbox_receipts WHERE account_id=? AND library_id=? AND event_id=? ORDER BY outbox_sequence DESC LIMIT 1', (*scope, event_id)).fetchone()
            latest_receipt = self._receipt(latest, scope) if latest else None
            if latest_receipt and {key: value for key, value in latest_receipt.items() if key != 'receiptId'} == body:
                return latest_receipt
            receipt = validate_receipt({**body, 'receiptId': 'receipt:' + study_hash({'body': body, 'previous': latest_receipt['receiptId'] if latest_receipt else None})})
            if status == 'applied' and receipt['proof']['coreHash'] != record['event']['coreHash']:
                raise ValueError('inbox-proof-binding')
            if row['status'] == 'applied' and receipt != latest_receipt:
                raise ValueError('inbox-terminal-receipt-conflict')
            if row['status'] == 'blocked' and status == 'received':
                raise ValueError('inbox-receipt-regression')
            old = db.execute('SELECT * FROM account_inbox_receipts WHERE account_id=? AND library_id=? AND receipt_id=?', (*scope, receipt['receiptId'])).fetchone()
            if old:
                if self._receipt(old, scope) != receipt:
                    raise ValueError('inbox-receipt-conflict')
                return receipt
            db.execute('INSERT INTO account_inbox_receipts(account_id,library_id,receipt_id,event_id,receipt_hash,receipt_json) VALUES(?,?,?,?,?,?)',
                       (*scope, receipt['receiptId'], event_id, study_hash(receipt), canonical_json(receipt)))
            db.execute('UPDATE account_inbox_records SET status=? WHERE account_id=? AND library_id=? AND event_id=?', (status, *scope, event_id))
            return receipt

    def pending_receipts(self, account_id, library_id, limit=20):
        scope = _scope(account_id, library_id); study_count(limit, minimum=1)
        if limit > 100:
            raise ValueError('invalid-outbox-limit')
        with self._connect() as db:
            return [self._receipt(row, scope) for row in db.execute('SELECT * FROM account_inbox_receipts WHERE account_id=? AND library_id=? AND cloud_sequence IS NULL ORDER BY outbox_sequence LIMIT ?', (*scope, limit))]

    def ack_receipt(self, account_id, library_id, receipt_id, cloud_sequence):
        scope = _scope(account_id, library_id); study_id(receipt_id); study_count(cloud_sequence, minimum=1)
        with self._connect(write=True) as db:
            row = db.execute('SELECT * FROM account_inbox_receipts WHERE account_id=? AND library_id=? AND receipt_id=?', (*scope, receipt_id)).fetchone()
            if not row:
                raise ValueError('unknown-inbox-receipt')
            self._receipt(row, scope)
            if row['cloud_sequence'] is not None and row['cloud_sequence'] != cloud_sequence:
                raise ValueError('inbox-receipt-ack-conflict')
            db.execute('UPDATE account_inbox_receipts SET cloud_sequence=? WHERE account_id=? AND library_id=? AND receipt_id=?', (cloud_sequence, *scope, receipt_id))

    def _export(self, value):
        study_object(value, ['bundle', 'bindings']); study_size(value, 32 * 1024 * 1024)
        bundle = validate_bundle(value['bundle']); bindings = value['bindings']
        if type(bindings) is not dict or set(bindings) != {item['itemKey'] for item in bundle['items']}:
            raise ValueError('incomplete-private-bindings')
        for item in bundle['items']:
            binding = study_object(bindings[item['itemKey']], ['contentHash', 'binding'], ['context', 'reviewCardPath', 'reviewEntryName'])
            study_digest(binding['contentHash'])
            if binding['contentHash'] != item['contentHash'] or type(binding['binding']) is not dict:
                raise ValueError('private-content-binding')
        return {'bundle': bundle, 'bindings': json.loads(canonical_json(bindings))}

    def save_export(self, account_id, bundle, bindings):
        value = self._export({'bundle': bundle, 'bindings': bindings}); snapshot = value['bundle']['snapshot']
        scope = _scope(account_id, snapshot['libraryId'])
        with self._connect(write=True) as db:
            return self._save_export(db, scope, value)

    def _save_export(self, db, scope, value):
        snapshot = value['bundle']['snapshot']; digest = study_hash(value)
        row = db.execute('SELECT * FROM account_inbox_exports WHERE account_id=? AND library_id=? AND (snapshot_id=? OR revision=?)', (*scope, snapshot['snapshotId'], snapshot['revision'])).fetchone()
        if row:
            existing = self._export(json.loads(row['export_json']))
            old_snapshot = existing['bundle']['snapshot']
            if (study_hash(existing) != row['export_hash'] or existing != value or old_snapshot['revision'] != row['revision']
                    or old_snapshot['snapshotId'] != row['snapshot_id'] or old_snapshot['libraryId'] != row['library_id']):
                raise ValueError('immutable-export-conflict')
            return 'duplicate'
        db.execute('INSERT INTO account_inbox_exports VALUES(?,?,?,?,?,?)', (*scope, snapshot['snapshotId'], snapshot['revision'], digest, canonical_json(value)))
        return 'accepted'

    def get_export(self, account_id, library_id, snapshot_id):
        scope = _scope(account_id, library_id); study_id(snapshot_id)
        with self._connect() as db:
            row = db.execute('SELECT * FROM account_inbox_exports WHERE account_id=? AND library_id=? AND snapshot_id=?', (*scope, snapshot_id)).fetchone()
            if not row:
                return None
            value = self._export(json.loads(row['export_json'])); snapshot = value['bundle']['snapshot']
            if (study_hash(value) != row['export_hash'] or snapshot['libraryId'] != library_id
                    or snapshot['snapshotId'] != snapshot_id or snapshot['revision'] != row['revision']):
                raise ValueError('private-export-integrity')
            return value

    def _planning(self, value):
        planning_value = study_object(value, ['catalog', 'materials','routes'], ['facts'])
        catalog = validate_planning_catalog(planning_value['catalog']); materials = planning_value['materials'];routes=planning_value['routes']
        if type(materials) is not dict:
            raise ValueError('invalid-local-planning-materials')
        expected = {unit['action']['materialId'] for subject in catalog['subjects'] for unit in subject['units'] if unit['action']['kind'] == 'open-material'}
        if set(materials) != expected:
            raise ValueError('incomplete-local-planning-materials')
        normalized = {}
        for material_id, raw in materials.items():
            material = study_object(raw, ['materialId', 'subjectId', 'unitId', 'contentRef', 'sourceHash'], ['stateRef', 'abilityId'])
            if material['materialId'] != material_id: raise ValueError('local-planning-material-binding')
            for key in ('materialId', 'subjectId', 'unitId'): study_id(material[key])
            if type(material['contentRef']) is not str or not material['contentRef'].strip(): raise ValueError('invalid-local-material-ref')
            study_digest(material['sourceHash']); normalized[material_id] = json.loads(canonical_json(material))
        if type(routes) is not dict or set(routes)!={subject['subjectId'] for subject in catalog['subjects']}:raise ValueError('incomplete-local-subject-routes')
        normalized_routes={}
        for subject_id,raw in routes.items():
            route=study_object(raw,['id','contentRoot','recordsRoot','progressRef']);
            if route['id']!=subject_id:raise ValueError('local-subject-route-binding')
            for field in route.values():
                if type(field) is not str or not field.strip():raise ValueError('invalid-local-subject-route')
            normalized_routes[subject_id]=json.loads(canonical_json(route))
        result = {'catalog': catalog, 'materials': normalized,'routes':normalized_routes}
        if 'facts' in planning_value:
            facts = validate_planning_facts(planning_value['facts'])
            if facts['libraryId'] != catalog['libraryId'] or facts['snapshotId'] != catalog['snapshotId'] or facts['catalogHash'] != catalog['catalogHash']: raise ValueError('local-planning-facts-binding')
            result['facts'] = facts
        return result

    def _save_planning(self, db, scope, snapshot_id, value):
        checked = self._planning(value)
        if checked['catalog']['snapshotId'] != snapshot_id or checked['catalog']['libraryId'] != scope[1]: raise ValueError('local-planning-snapshot-binding')
        row = db.execute('SELECT * FROM account_inbox_planning_exports WHERE account_id=? AND library_id=? AND snapshot_id=?', (*scope, snapshot_id)).fetchone()
        digest = study_hash(checked['materials'])
        if row:
            stored={'catalog': json.loads(row['catalog_json']), 'materials': json.loads(row['materials_json']),'routes':json.loads(row['routes_json'])}
            existing = self._planning(stored)
            if existing != {'catalog':checked['catalog'],'materials':checked['materials'],'routes':checked['routes']} or row['catalog_hash'] != checked['catalog']['catalogHash'] or row['materials_hash'] != digest or row['routes_hash']!=study_hash(checked['routes']):
                raise ValueError('immutable-planning-export-conflict')
        else:
            db.execute('INSERT INTO account_inbox_planning_exports(account_id,library_id,snapshot_id,catalog_hash,catalog_json,materials_hash,materials_json,routes_hash,routes_json) VALUES(?,?,?,?,?,?,?,?,?)',
                       (*scope, snapshot_id, checked['catalog']['catalogHash'], canonical_json(checked['catalog']), digest, canonical_json(checked['materials']),study_hash(checked['routes']),canonical_json(checked['routes'])))
        if 'facts' in checked:
            old_facts=db.execute('SELECT facts_json FROM account_inbox_planning_facts WHERE account_id=? AND library_id=? AND facts_hash=?',(*scope,checked['facts']['factsHash'])).fetchone()
            if old_facts and validate_planning_facts(json.loads(old_facts['facts_json']))!=checked['facts']: raise ValueError('immutable-planning-facts-conflict')
            if not old_facts: db.execute('INSERT INTO account_inbox_planning_facts(account_id,library_id,snapshot_id,facts_hash,facts_json) VALUES(?,?,?,?,?)',(*scope,snapshot_id,checked['facts']['factsHash'],canonical_json(checked['facts'])))

    def start_publication(self, account_id, bundle, bindings, expected_revision, *, planning=None):
        study_count(expected_revision)
        value = self._export({'bundle': bundle, 'bindings': bindings}); bundle = value['bundle']
        if bundle['snapshot']['revision'] != expected_revision + 1:
            raise ValueError('invalid-publication-revision')
        snapshot = bundle['snapshot']; scope = _scope(account_id, snapshot['libraryId'])
        with self._connect(write=True) as db:
            self._save_export(db, scope, value)
            if planning is not None:
                value={'catalog': planning[0], 'materials': planning[1],'routes':planning[3] if len(planning)>3 else {}}
                if len(planning)>2: value['facts']=planning[2]
                self._save_planning(db, scope, snapshot['snapshotId'], value)
            db.execute('INSERT OR IGNORE INTO account_inbox_publications(account_id,library_id,snapshot_id,expected_revision) VALUES(?,?,?,?)', (*scope, snapshot['snapshotId'], expected_revision))
            row = db.execute('SELECT expected_revision FROM account_inbox_publications WHERE account_id=? AND library_id=? AND snapshot_id=?', (*scope, snapshot['snapshotId'])).fetchone()
            if row['expected_revision'] != expected_revision:
                raise ValueError('publication-binding-conflict')

    def pending_publication(self, account_id, library_id):
        scope = _scope(account_id, library_id)
        with self._connect() as db:
            row = db.execute('SELECT * FROM account_inbox_publications WHERE account_id=? AND library_id=? AND complete=0 ORDER BY expected_revision LIMIT 1', scope).fetchone()
        if not row:
            return None
        value = self.get_export(*scope, row['snapshot_id'])
        if (not value or row['begun'] not in (0, 1) or row['expected_revision'] != value['bundle']['snapshot']['revision'] - 1
                or not 0 <= row['position'] <= len(value['bundle']['items']) or (not row['begun'] and row['position'] != 0)):
            raise ValueError('publication-state-integrity')
        return {**value, 'expectedRevision': row['expected_revision'], 'begun': bool(row['begun']), 'position': row['position']}

    def advance_publication(self, account_id, library_id, snapshot_id, expected, *, begun, position, complete=False):
        scope = _scope(account_id, library_id); study_id(snapshot_id); study_count(position)
        if (type(begun) is not bool or type(complete) is not bool or position < expected['position']
                or position > len(expected['bundle']['items']) or (expected['begun'] and not begun)
                or (not begun and position != 0) or (complete and (not begun or position != len(expected['bundle']['items'])))
                or expected['bundle']['snapshot']['snapshotId'] != snapshot_id):
            raise ValueError('invalid-publication-progress')
        with self._connect(write=True) as db:
            changed = db.execute('UPDATE account_inbox_publications SET begun=?,position=?,complete=? WHERE account_id=? AND library_id=? AND snapshot_id=? AND begun=? AND position=? AND complete=0 AND expected_revision=?',
                                 (int(begun), position, int(complete), *scope, snapshot_id, int(expected['begun']), expected['position'], expected['expectedRevision'])).rowcount
            if changed != 1:
                raise ValueError('publication-progress-conflict')

    def get_planning(self, account_id, library_id, snapshot_id):
        scope = _scope(account_id, library_id); study_id(snapshot_id)
        with self._connect() as db:
            row = db.execute('SELECT * FROM account_inbox_planning_exports WHERE account_id=? AND library_id=? AND snapshot_id=?', (*scope, snapshot_id)).fetchone()
        if not row: return None
        stored={'catalog': json.loads(row['catalog_json']), 'materials': json.loads(row['materials_json']),'routes':json.loads(row['routes_json'])}
        with self._connect() as db:
            facts=db.execute('SELECT facts_json FROM account_inbox_planning_facts WHERE account_id=? AND library_id=? AND snapshot_id=? ORDER BY sequence DESC LIMIT 1',(*scope,snapshot_id)).fetchone()
        if facts: stored['facts']=json.loads(facts['facts_json'])
        value = self._planning(stored)
        if row['catalog_hash'] != value['catalog']['catalogHash'] or row['materials_hash'] != study_hash(value['materials']): raise ValueError('local-planning-export-integrity')
        return value

    def pending_planning(self, account_id, library_id):
        scope = _scope(account_id, library_id)
        with self._connect() as db:
            row = db.execute('SELECT p.snapshot_id,p.cloud_acked FROM account_inbox_planning_exports p JOIN account_inbox_publications u ON u.account_id=p.account_id AND u.library_id=p.library_id AND u.snapshot_id=p.snapshot_id WHERE p.account_id=? AND p.library_id=? AND u.complete=1 AND (p.cloud_acked=0 OR EXISTS (SELECT 1 FROM account_inbox_planning_facts f WHERE f.account_id=p.account_id AND f.library_id=p.library_id AND f.snapshot_id=p.snapshot_id AND f.cloud_acked=0)) ORDER BY u.expected_revision LIMIT 1', scope).fetchone()
            facts=db.execute('SELECT facts_json FROM account_inbox_planning_facts WHERE account_id=? AND library_id=? AND snapshot_id=? AND cloud_acked=0 ORDER BY sequence LIMIT 1',(*scope,row['snapshot_id'])).fetchone() if row else None
        if not row: return None
        result=self.get_planning(*scope,row['snapshot_id'])
        if facts: result['facts']=validate_planning_facts(json.loads(facts['facts_json']))
        result['catalogPending']=row['cloud_acked']==0
        return result

    def ack_planning(self, account_id, library_id, snapshot_id, catalog_hash, facts_hash=None):
        scope = _scope(account_id, library_id); study_id(snapshot_id); study_digest(catalog_hash)
        with self._connect(write=True) as db:
            changed = db.execute('UPDATE account_inbox_planning_exports SET cloud_acked=1 WHERE account_id=? AND library_id=? AND snapshot_id=? AND catalog_hash=?', (*scope, snapshot_id, catalog_hash)).rowcount
            if changed != 1:
                row = db.execute('SELECT catalog_hash,cloud_acked FROM account_inbox_planning_exports WHERE account_id=? AND library_id=? AND snapshot_id=?', (*scope, snapshot_id)).fetchone()
                if not row or row['catalog_hash'] != catalog_hash or row['cloud_acked'] != 1: raise ValueError('planning-ack-conflict')
            if facts_hash is not None:
                study_digest(facts_hash)
                changed=db.execute('UPDATE account_inbox_planning_facts SET cloud_acked=1 WHERE account_id=? AND library_id=? AND snapshot_id=? AND facts_hash=?',(*scope,snapshot_id,facts_hash)).rowcount
                if changed!=1:
                    row=db.execute('SELECT cloud_acked FROM account_inbox_planning_facts WHERE account_id=? AND library_id=? AND snapshot_id=? AND facts_hash=?',(*scope,snapshot_id,facts_hash)).fetchone()
                    if not row or row['cloud_acked']!=1: raise ValueError('planning-facts-ack-conflict')

    def queue_planning(self, account_id, library_id, snapshot_id, catalog, materials, facts,routes):
        scope=_scope(account_id,library_id);study_id(snapshot_id)
        with self._connect(write=True) as db:self._save_planning(db,scope,snapshot_id,{'catalog':catalog,'materials':materials,'facts':facts,'routes':routes})

    def planning_for_catalog(self, account_id, library_id, catalog_hash):
        scope=_scope(account_id,library_id);study_digest(catalog_hash)
        with self._connect() as db:row=db.execute('SELECT snapshot_id FROM account_inbox_planning_exports WHERE account_id=? AND library_id=? AND catalog_hash=?',(*scope,catalog_hash)).fetchone()
        return self.get_planning(*scope,row['snapshot_id']) if row else None

    def _plan_operation(self, value):
        from account_sync_plan_writer import validate_cloud_plan
        value=copy.deepcopy(study_object(value,['sequence','operationId','day','action','plan','predecessorOperationId','stateRevision','receivedAt']))
        study_count(value['sequence'],minimum=1);study_id(value['operationId']);study_text(value['day']);study_count(value['stateRevision'],minimum=1);study_text(value['receivedAt'])
        if value['action'] not in ('save','approve','reject','cancel','restore'):raise ValueError('invalid-plan-operation')
        if value['plan'] is not None:value['plan']=validate_cloud_plan(value['plan'])
        if value['predecessorOperationId'] is not None:study_id(value['predecessorOperationId'])
        if value['action'] in ('approve','restore') and value['plan'] is None:raise ValueError('incomplete-plan-operation')
        return value

    def plan_cursor(self, account_id, library_id):
        scope=_scope(account_id,library_id)
        with self._connect() as db:row=db.execute('SELECT * FROM account_inbox_plan_cursors WHERE account_id=? AND library_id=?',scope).fetchone()
        if not row:return {'after':0,'through':None,'completeThrough':0}
        result={'after':study_count(row['after_cursor']),'through':row['through_cursor'],'completeThrough':study_count(row['complete_cursor'])}
        if result['through'] is not None:study_count(result['through'])
        if result['completeThrough']>result['after'] or result['through'] is None and result['after']!=result['completeThrough'] or result['through'] is not None and result['through']<=result['after']:raise ValueError('plan-cursor-integrity')
        return result

    def receive_plan_page(self, account_id, library_id, page, *, after=None):
        scope=_scope(account_id,library_id);after=self.plan_cursor(*scope)['after'] if after is None else study_count(after)
        study_object(page,['operations','nextCursor','through']);study_size(page,2200000)
        if type(page['operations']) is not list or len(page['operations'])>20:raise ValueError('invalid-plan-page')
        operations=[self._plan_operation(value) for value in page['operations']];previous=after;through=study_count(page['through'])
        for operation in operations:
            if not previous<operation['sequence']<=through:raise ValueError('invalid-plan-page-order')
            previous=operation['sequence']
        if page['nextCursor'] is None:
            if previous!=through:raise ValueError('incomplete-plan-fence')
        elif study_count(page['nextCursor'])!=previous or not operations or previous>=through:raise ValueError('invalid-plan-fence')
        digest=study_hash(page)
        with self._connect(write=True) as db:
            cursor=db.execute('SELECT * FROM account_inbox_plan_cursors WHERE account_id=? AND library_id=?',scope).fetchone()
            current=cursor['after_cursor'] if cursor else 0;own_through=cursor['through_cursor'] if cursor else None;complete=cursor['complete_cursor'] if cursor else 0
            if current!=after or own_through is not None and own_through!=through:raise ValueError('plan-cursor-conflict')
            for operation in operations:
                row=db.execute('SELECT * FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? AND (operation_id=? OR sequence=?)',(*scope,operation['operationId'],operation['sequence'])).fetchone()
                if row:
                    if row['operation_hash']!=study_hash(operation) or json.loads(row['operation_json'])!=operation:raise ValueError('plan-operation-conflict')
                else:db.execute('INSERT INTO account_inbox_plan_operations(account_id,library_id,operation_id,sequence,operation_hash,operation_json,status) VALUES(?,?,?,?,?,?,?)',(*scope,operation['operationId'],operation['sequence'],study_hash(operation),canonical_json(operation),'pending' if operation['action'] in ('approve','restore') else 'ignored'))
            # A cancellation is an ordered control record, not a file write.
            # Apply it to the local queue in the same transaction as the page so
            # a worker can never claim the cancelled approval between steps.
            cancelled=set()
            for operation in operations:
                if operation['action']!='cancel':continue
                target=operation['predecessorOperationId']
                if not target:raise ValueError('invalid-plan-cancel-target')
                target_row=db.execute('SELECT status FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? AND operation_id=?',(*scope,target)).fetchone()
                if not target_row:raise ValueError('unknown-plan-cancel-target')
                if target_row['status'] in ('pending','blocked','needs-review'):
                    db.execute("UPDATE account_inbox_plan_operations SET status='cancelled' WHERE account_id=? AND library_id=? AND operation_id=?",(*scope,target));cancelled.add(target)
            while cancelled:
                next_cancelled=set()
                for row in db.execute("SELECT operation_id,operation_json FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? AND status='pending'",scope).fetchall():
                    value=self._plan_operation(json.loads(row['operation_json']))
                    if value['predecessorOperationId'] in cancelled:
                        db.execute("UPDATE account_inbox_plan_operations SET status='needs-review' WHERE account_id=? AND library_id=? AND operation_id=?",(*scope,row['operation_id']));next_cancelled.add(row['operation_id'])
                cancelled=next_cancelled
            db.execute('INSERT INTO account_inbox_plan_cursors VALUES(?,?,?,?,?) ON CONFLICT(account_id,library_id) DO UPDATE SET after_cursor=excluded.after_cursor,through_cursor=excluded.through_cursor,complete_cursor=excluded.complete_cursor',(*scope,previous,through if page['nextCursor'] is not None else None,complete if page['nextCursor'] is not None else through))
        return 'accepted'

    def pending_plan_operations(self, account_id, library_id):
        scope=_scope(account_id,library_id);fence=self.plan_cursor(*scope)['completeThrough']
        with self._connect() as db:rows=db.execute("SELECT * FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? AND sequence<=? AND status='pending' ORDER BY sequence",(*scope,fence)).fetchall()
        result=[]
        for row in rows:
            operation=self._plan_operation(json.loads(row['operation_json']))
            if row['operation_hash']!=study_hash(operation) or row['operation_id']!=operation['operationId'] or row['sequence']!=operation['sequence']:raise ValueError('plan-operation-integrity')
            result.append(operation)
        return result

    def set_plan_result(self, account_id, library_id, result):
        from account_sync_plan_writer import execution_receipt
        scope=_scope(account_id,library_id);receipt=execution_receipt(result);operation_id=receipt['operationId']
        with self._connect(write=True) as db:
            operation=db.execute('SELECT status FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? AND operation_id=?',(*scope,operation_id)).fetchone()
            if not operation:raise ValueError('unknown-local-plan-operation')
            old=db.execute('SELECT receipt_json FROM account_inbox_plan_receipts WHERE account_id=? AND library_id=? AND receipt_id=?',(*scope,receipt['receiptId'])).fetchone()
            if old:
                if json.loads(old['receipt_json'])!=receipt:raise ValueError('local-plan-receipt-conflict')
                return receipt
            if operation['status']!='pending':raise ValueError('local-plan-operation-not-executable')
            latest=db.execute('SELECT receipt_json FROM account_inbox_plan_receipts WHERE account_id=? AND library_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1',(*scope,operation_id)).fetchone()
            if latest and json.loads(latest['receipt_json'])['status']=='applied' and receipt['status']!='applied':raise ValueError('local-plan-receipt-regression')
            db.execute('INSERT INTO account_inbox_plan_receipts(account_id,library_id,receipt_id,operation_id,receipt_hash,receipt_json) VALUES(?,?,?,?,?,?)',(*scope,receipt['receiptId'],operation_id,study_hash(receipt),canonical_json(receipt)))
            db.execute('UPDATE account_inbox_plan_operations SET status=? WHERE account_id=? AND library_id=? AND operation_id=?',('applied' if receipt['status']=='applied' else 'needs-review',*scope,operation_id))
        return receipt

    def latest_plan_result(self, account_id, library_id, operation_id):
        scope=_scope(account_id,library_id);study_id(operation_id)
        with self._connect() as db:row=db.execute('SELECT * FROM account_inbox_plan_receipts WHERE account_id=? AND library_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1',(*scope,operation_id)).fetchone()
        if not row:return None
        receipt=json.loads(row['receipt_json'])
        if row['receipt_hash']!=study_hash(receipt):raise ValueError('local-plan-receipt-integrity')
        result={key:value for key,value in receipt.items() if key not in ('schemaVersion','receiptId')}
        return result

    def pending_plan_receipts(self, account_id, library_id):
        scope=_scope(account_id,library_id)
        with self._connect() as db:rows=db.execute('SELECT * FROM account_inbox_plan_receipts WHERE account_id=? AND library_id=? AND cloud_sequence IS NULL ORDER BY sequence LIMIT 20',scope).fetchall()
        result=[]
        for row in rows:
            receipt=json.loads(row['receipt_json'])
            if row['receipt_hash']!=study_hash(receipt):raise ValueError('local-plan-receipt-integrity')
            result.append(receipt)
        return result

    def ack_plan_receipt(self, account_id, library_id, receipt_id, cloud_sequence):
        scope=_scope(account_id,library_id);study_id(receipt_id);study_count(cloud_sequence,minimum=1)
        with self._connect(write=True) as db:
            row=db.execute('SELECT cloud_sequence FROM account_inbox_plan_receipts WHERE account_id=? AND library_id=? AND receipt_id=?',(*scope,receipt_id)).fetchone()
            if not row:raise ValueError('unknown-local-plan-receipt')
            if row['cloud_sequence'] is not None and row['cloud_sequence']!=cloud_sequence:raise ValueError('local-plan-receipt-ack-conflict')
            db.execute('UPDATE account_inbox_plan_receipts SET cloud_sequence=? WHERE account_id=? AND library_id=? AND receipt_id=?',(cloud_sequence,*scope,receipt_id))

    def plan_operation_for_hash(self, account_id, library_id, plan_hash):
        scope=_scope(account_id,library_id);study_digest(plan_hash)
        with self._connect() as db:rows=db.execute("SELECT operation_json FROM account_inbox_plan_operations WHERE account_id=? AND library_id=? ORDER BY sequence DESC",scope).fetchall()
        for row in rows:
            operation=self._plan_operation(json.loads(row['operation_json']))
            if operation['action'] in ('approve','restore') and operation['plan'] and operation['plan']['cloudPlanHash']==plan_hash:return operation
        return None

    def _content_operation(self,value):
        value=copy.deepcopy(study_object(value,['sequence','operationId','factsHash','candidateId','contentHash','decision','status','receivedAt']))
        study_count(value['sequence'],minimum=1);study_id(value['operationId']);study_digest(value['factsHash']);study_id(value['candidateId']);study_digest(value['contentHash']);study_text(value['receivedAt'])
        if value['decision'] not in ('approved','rejected','later'):raise ValueError('invalid-content-decision')
        if value['status'] not in ('pending','applied','blocked'):raise ValueError('invalid-content-decision-status')
        return value

    def _content_receipt(self,value):
        value=copy.deepcopy(study_object(value,['schemaVersion','receiptId','operationId','candidateId','contentHash','decision','status'],['proofHash','reason']))
        if value['schemaVersion']!=1:raise ValueError('unsupported-content-receipt')
        for key in ('receiptId','operationId','candidateId'):study_id(value[key])
        study_digest(value['contentHash'])
        if value['decision'] not in ('approved','rejected','later') or value['status'] not in ('applied','blocked'):raise ValueError('invalid-content-receipt')
        if value['status']=='applied':study_digest(value.get('proofHash'));study_object(value,['schemaVersion','receiptId','operationId','candidateId','contentHash','decision','status','proofHash'])
        else:study_text(value.get('reason'),'reason',200);study_object(value,['schemaVersion','receiptId','operationId','candidateId','contentHash','decision','status','reason'])
        return value

    def content_cursor(self,account_id,library_id):
        scope=_scope(account_id,library_id)
        with self._connect() as db:row=db.execute('SELECT * FROM account_inbox_content_cursors WHERE account_id=? AND library_id=?',scope).fetchone()
        if not row:return {'after':0,'through':None,'completeThrough':0}
        result={'after':study_count(row['after_cursor']),'through':row['through_cursor'],'completeThrough':study_count(row['complete_cursor'])}
        if result['through'] is not None:study_count(result['through'])
        if result['completeThrough']>result['after'] or result['through'] is None and result['after']!=result['completeThrough'] or result['through'] is not None and result['through']<=result['after']:raise ValueError('content-cursor-integrity')
        return result

    def receive_content_page(self,account_id,library_id,page,after=None):
        scope=_scope(account_id,library_id);after=self.content_cursor(*scope)['after'] if after is None else study_count(after);study_object(page,['operations','nextCursor','through']);study_size(page,2200000)
        if type(page['operations']) is not list or len(page['operations'])>20:raise ValueError('invalid-content-page')
        operations=[self._content_operation(value) for value in page['operations']];previous=after;through=study_count(page['through'])
        for operation in operations:
            if not previous<operation['sequence']<=through:raise ValueError('invalid-content-page-order')
            previous=operation['sequence']
        if page['nextCursor'] is None:
            if previous!=through:raise ValueError('incomplete-content-fence')
        elif study_count(page['nextCursor'])!=previous or not operations or previous>=through:raise ValueError('invalid-content-fence')
        with self._connect(write=True) as db:
            cursor=db.execute('SELECT * FROM account_inbox_content_cursors WHERE account_id=? AND library_id=?',scope).fetchone();current=cursor['after_cursor'] if cursor else 0;own_through=cursor['through_cursor'] if cursor else None;complete=cursor['complete_cursor'] if cursor else 0
            if current!=after or own_through is not None and own_through!=through:raise ValueError('content-cursor-conflict')
            for operation in operations:
                row=db.execute('SELECT * FROM account_inbox_content_operations WHERE account_id=? AND library_id=? AND (operation_id=? OR sequence=?)',(*scope,operation['operationId'],operation['sequence'])).fetchone()
                if row:
                    if row['operation_hash']!=study_hash(operation) or json.loads(row['operation_json'])!=operation:raise ValueError('content-operation-conflict')
                else:db.execute('INSERT INTO account_inbox_content_operations(account_id,library_id,operation_id,sequence,operation_hash,operation_json,status) VALUES(?,?,?,?,?,?,?)',(*scope,operation['operationId'],operation['sequence'],study_hash(operation),canonical_json(operation),'pending'))
            db.execute('INSERT INTO account_inbox_content_cursors VALUES(?,?,?,?,?) ON CONFLICT(account_id,library_id) DO UPDATE SET after_cursor=excluded.after_cursor,through_cursor=excluded.through_cursor,complete_cursor=excluded.complete_cursor',(*scope,previous,through if page['nextCursor'] is not None else None,complete if page['nextCursor'] is not None else through))

    def pending_content_operations(self,account_id,library_id):
        scope=_scope(account_id,library_id);fence=self.content_cursor(*scope)['completeThrough']
        with self._connect() as db:rows=db.execute("SELECT * FROM account_inbox_content_operations WHERE account_id=? AND library_id=? AND sequence<=? AND status='pending' ORDER BY sequence",(*scope,fence)).fetchall()
        result=[]
        for row in rows:
            value=self._content_operation(json.loads(row['operation_json']))
            if row['operation_hash']!=study_hash(value):raise ValueError('content-operation-integrity')
            result.append(value)
        return result

    def set_content_result(self,account_id,library_id,value):
        scope=_scope(account_id,library_id);receipt=self._content_receipt(value)
        with self._connect(write=True) as db:
            operation=db.execute('SELECT * FROM account_inbox_content_operations WHERE account_id=? AND library_id=? AND operation_id=?',(*scope,receipt['operationId'])).fetchone()
            if not operation or operation['status']!='pending':raise ValueError('content-operation-not-executable')
            expected=self._content_operation(json.loads(operation['operation_json']))
            if any(receipt[key]!=expected[key] for key in ('operationId','candidateId','contentHash','decision')):raise ValueError('content-receipt-binding')
            old=db.execute('SELECT receipt_json FROM account_inbox_content_receipts WHERE account_id=? AND library_id=? AND receipt_id=?',(*scope,receipt['receiptId'])).fetchone()
            if old:
                if json.loads(old['receipt_json'])!=receipt:raise ValueError('content-receipt-conflict')
                return receipt
            db.execute('INSERT INTO account_inbox_content_receipts(account_id,library_id,receipt_id,operation_id,receipt_hash,receipt_json) VALUES(?,?,?,?,?,?)',(*scope,receipt['receiptId'],receipt['operationId'],study_hash(receipt),canonical_json(receipt)))
            db.execute('UPDATE account_inbox_content_operations SET status=? WHERE account_id=? AND library_id=? AND operation_id=?',(receipt['status'],*scope,receipt['operationId']))
        return receipt

    def pending_content_receipts(self,account_id,library_id):
        scope=_scope(account_id,library_id)
        with self._connect() as db:rows=db.execute('SELECT * FROM account_inbox_content_receipts WHERE account_id=? AND library_id=? AND cloud_sequence IS NULL ORDER BY sequence LIMIT 20',scope).fetchall()
        result=[]
        for row in rows:
            receipt=self._content_receipt(json.loads(row['receipt_json']))
            if row['receipt_hash']!=study_hash(receipt):raise ValueError('content-receipt-integrity')
            result.append(receipt)
        return result

    def ack_content_receipt(self,account_id,library_id,receipt_id,cloud_sequence):
        scope=_scope(account_id,library_id);study_id(receipt_id);study_count(cloud_sequence,minimum=1)
        with self._connect(write=True) as db:
            row=db.execute('SELECT cloud_sequence FROM account_inbox_content_receipts WHERE account_id=? AND library_id=? AND receipt_id=?',(*scope,receipt_id)).fetchone()
            if not row:raise ValueError('unknown-content-receipt')
            if row['cloud_sequence'] is not None and row['cloud_sequence']!=cloud_sequence:raise ValueError('content-receipt-ack-conflict')
            db.execute('UPDATE account_inbox_content_receipts SET cloud_sequence=? WHERE account_id=? AND library_id=? AND receipt_id=?',(cloud_sequence,*scope,receipt_id))
