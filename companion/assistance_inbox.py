"""Independent auxiliary inbox/cursors/receipts. No network, scoring or Vault writes."""
from __future__ import annotations
import copy
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from account_sync_schema import canonical_json, study_id, study_count, study_hash, study_object, study_size, study_iso
from assistance_schema import validate_account_assistance, validate_native_assistance, validate_parent, check_assistance_receipt

DDL = '''
CREATE TABLE IF NOT EXISTS assistance_cursors(owner_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL,through_cursor INTEGER,complete_cursor INTEGER NOT NULL,PRIMARY KEY(owner_id,library_id));
CREATE TABLE IF NOT EXISTS assistance_pages(owner_id TEXT NOT NULL,library_id TEXT NOT NULL,after_cursor INTEGER NOT NULL,through_cursor INTEGER NOT NULL,page_hash TEXT NOT NULL,PRIMARY KEY(owner_id,library_id,after_cursor,through_cursor));
CREATE TABLE IF NOT EXISTS assistance_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,channel TEXT NOT NULL,library_id TEXT NOT NULL,
 summary_id TEXT NOT NULL,event_id TEXT NOT NULL,cloud_sequence INTEGER,association_hash TEXT NOT NULL,record_json TEXT NOT NULL,parent_json TEXT,route_json TEXT,metadata_hash TEXT NOT NULL,
 UNIQUE(owner_id,channel,library_id,summary_id),UNIQUE(owner_id,channel,library_id,event_id),UNIQUE(owner_id,channel,library_id,cloud_sequence));
CREATE TABLE IF NOT EXISTS assistance_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,channel TEXT NOT NULL,library_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL,summary_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,cloud_sequence INTEGER,
 UNIQUE(owner_id,channel,library_id,receipt_id),FOREIGN KEY(owner_id,channel,library_id,summary_id) REFERENCES assistance_records(owner_id,channel,library_id,summary_id));
CREATE INDEX IF NOT EXISTS assistance_pending_receipts ON assistance_receipts(owner_id,channel,library_id,cloud_sequence,sequence);
CREATE TABLE IF NOT EXISTS assistance_scan_cursors(owner_id TEXT NOT NULL,channel TEXT NOT NULL,library_id TEXT NOT NULL,last_sequence INTEGER NOT NULL,PRIMARY KEY(owner_id,channel,library_id));
'''


def _scope(owner, library, channel='account'):
    study_id(owner, 'owner'); study_id(library, 'library')
    if channel not in ('account', 'local') or (channel == 'local' and library != 'native'):
        raise ValueError('invalid-assistance-scope')
    return owner, channel, library


class AssistanceInbox:
    def __init__(self, database_path):
        self.path = Path(database_path); self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript(DDL)

    @contextmanager
    def _db(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None); db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON'); db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            if db.in_transaction: db.commit()
        except BaseException:
            if db.in_transaction: db.rollback()
            raise
        finally:
            db.close()

    def _cursor(self, db, owner, library):
        row = db.execute('SELECT * FROM assistance_cursors WHERE owner_id=? AND library_id=?', (owner, library)).fetchone()
        if not row: return dict(after=0, through=None, completeThrough=0)
        after = study_count(row['after_cursor']); complete = study_count(row['complete_cursor']); through = row['through_cursor']
        if through is not None: study_count(through)
        if complete > after or (through is None and complete != after) or (through is not None and through <= after):
            raise ValueError('assistance-cursor-integrity')
        return dict(after=after, through=through, completeThrough=complete)

    def cursor(self, owner, library):
        _scope(owner, library)
        with self._db() as db: return self._cursor(db, owner, library)

    def _record(self, row, scope):
        if (row['owner_id'], row['channel'], row['library_id']) != scope:
            raise ValueError('assistance-inbox-owner')
        raw = json.loads(row['record_json']); parent = json.loads(row['parent_json']) if row['parent_json'] else None; route = json.loads(row['route_json']) if row['route_json'] else None
        record = validate_account_assistance(raw) if scope[1] == 'account' else validate_native_assistance(raw)
        if (record['associationHash'] != row['association_hash'] or record['summary']['summaryId'] != row['summary_id'] or record['summary']['attemptEventId'] != row['event_id']
                or study_hash([record, parent, route]) != row['metadata_hash']):
            raise ValueError('assistance-inbox-integrity')
        if scope[1] == 'account':
            study_count(row['cloud_sequence'], minimum=1)
            if record['libraryId'] != scope[2] or parent is not None or route is not None: raise ValueError('assistance-inbox-binding')
        else:
            if row['cloud_sequence'] is not None or type(route) is not dict: raise ValueError('assistance-inbox-binding')
            validate_parent(record['summary'], parent, record['binding']['practiceMode'])
        return dict(sequence=row['cloud_sequence'] if scope[1] == 'account' else row['sequence'], record=record, parent=parent, route=route)

    def _insert(self, db, scope, record, sequence, parent=None, route=None):
        summary = record['summary']; digest = study_hash([record, parent, route])
        old = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND (summary_id=? OR event_id=?)', (*scope, summary['summaryId'], summary['attemptEventId'])).fetchone()
        if old:
            self._record(old, scope)
            if old['metadata_hash'] != digest or old['cloud_sequence'] != sequence: raise ValueError('assistance-inbox-conflict')
            return 'duplicate'
        db.execute('INSERT INTO assistance_records(owner_id,channel,library_id,summary_id,event_id,cloud_sequence,association_hash,record_json,parent_json,route_json,metadata_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (*scope, summary['summaryId'], summary['attemptEventId'], sequence, record['associationHash'], canonical_json(record), canonical_json(parent) if parent is not None else None, canonical_json(route) if route is not None else None, digest))
        return 'accepted'

    def receive_page(self, owner, library, page, *, after):
        scope = _scope(owner, library); study_count(after); study_size(page, 2200000); study_object(page, ['summaries', 'through', 'nextCursor'])
        through = study_count(page['through']); entries = page['summaries']; next_cursor = page['nextCursor']
        if through < after or type(entries) is not list or len(entries) > 20: raise ValueError('invalid-assistance-page')
        rows, previous = [], after
        for entry in entries:
            study_object(entry, ['sequence', 'record', 'receivedAt']); study_iso(entry['receivedAt']); sequence = study_count(entry['sequence'], minimum=1)
            record = validate_account_assistance(entry['record'])
            if not previous < sequence <= through or record['libraryId'] != library: raise ValueError('invalid-assistance-page-binding')
            rows.append((sequence, record)); previous = sequence
        if next_cursor is not None:
            study_count(next_cursor)
            if not rows or next_cursor != previous or previous >= through: raise ValueError('invalid-assistance-fence')
        elif previous != through: raise ValueError('incomplete-assistance-fence')
        digest = study_hash(page)
        with self._db(write=True) as db:
            old = db.execute('SELECT page_hash FROM assistance_pages WHERE owner_id=? AND library_id=? AND after_cursor=? AND through_cursor=?', (owner, library, after, through)).fetchone()
            if old:
                if old['page_hash'] != digest: raise ValueError('assistance-page-conflict')
                for sequence, record in rows:
                    saved = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?', (*scope, record['summary']['summaryId'])).fetchone()
                    if not saved or self._record(saved, scope)['record'] != record or saved['cloud_sequence'] != sequence: raise ValueError('assistance-page-integrity')
                return 'duplicate'
            cursor = self._cursor(db, owner, library)
            if cursor['after'] != after or cursor['through'] is not None and cursor['through'] != through: raise ValueError('assistance-cursor-conflict')
            for sequence, record in rows: self._insert(db, scope, record, sequence)
            db.execute('INSERT INTO assistance_pages VALUES(?,?,?,?,?)', (owner, library, after, through, digest))
            db.execute('INSERT INTO assistance_cursors VALUES(?,?,?,?,?) ON CONFLICT(owner_id,library_id) DO UPDATE SET after_cursor=excluded.after_cursor,through_cursor=excluded.through_cursor,complete_cursor=excluded.complete_cursor',
                       (owner, library, previous, through if next_cursor is not None else None, cursor['completeThrough'] if next_cursor is not None else through))
        return 'accepted'

    def receive_native(self, owner, raw, raw_parent, frozen_route):
        scope = _scope(owner, 'native', 'local'); record = validate_native_assistance(raw); parent = copy.deepcopy(raw_parent)
        if type(parent) is dict and type(parent.get('scheduling')) is dict: parent['scheduling'].pop('clientStateAfter', None)
        validate_parent(record['summary'], parent, record['binding']['practiceMode'])
        if type(frozen_route) is not dict: raise ValueError('invalid-assistance-route')
        # Do not copy title, weak points or other local context into auxiliary storage.
        route = {key: copy.deepcopy(frozen_route[key]) for key in ('binding', 'assistanceBinding', 'assistanceSources', 'assistanceBindingIssue') if key in frozen_route}
        study_size(route, 16000)
        with self._db(write=True) as db: return self._insert(db, scope, record, None, parent, route)

    def _receipt(self, row, scope, record):
        receipt = check_assistance_receipt(record, json.loads(row['receipt_json']))
        if (row['owner_id'], row['channel'], row['library_id']) != scope or row['receipt_id'] != receipt['receiptId'] or row['summary_id'] != receipt['summaryId'] or row['receipt_hash'] != study_hash(receipt):
            raise ValueError('assistance-inbox-receipt-integrity')
        return receipt

    def pending(self, owner, library, *, channel='account', limit=20):
        scope = _scope(owner, library, channel); study_count(limit, minimum=1)
        if limit > 20: raise ValueError('invalid-assistance-limit')
        with self._db() as db:
            fence = self._cursor(db, owner, library)['completeThrough'] if channel == 'account' else None
            scan = db.execute('SELECT last_sequence FROM assistance_scan_cursors WHERE owner_id=? AND channel=? AND library_id=?',scope).fetchone()
            last = study_count(scan['last_sequence']) if scan else 0
            rows = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND (? IS NULL OR cloud_sequence<=?) ORDER BY CASE WHEN sequence>? THEN 0 ELSE 1 END,sequence', (*scope, fence, fence, last))
            result = []
            # Verify a terminal receipt before allowing it to suppress a retry.
            for row in rows:
                checked = self._record(row, scope)
                latest = db.execute('SELECT * FROM assistance_receipts WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=? ORDER BY sequence DESC LIMIT 1', (*scope, row['summary_id'])).fetchone()
                receipt = self._receipt(latest, scope, checked['record']) if latest else None
                if receipt is None or receipt['status'] != 'applied': result.append(checked)
                if len(result) == limit: break
            return result

    def set_result(self, owner, library, summary_id, status, *, channel='account', reason=None, proof=None, initial_only=False):
        scope = _scope(owner, library, channel); study_id(summary_id)
        with self._db(write=True) as db:
            row = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?', (*scope, summary_id)).fetchone()
            if not row or channel == 'account' and row['cloud_sequence'] > self._cursor(db, owner, library)['completeThrough']: raise ValueError('unknown-complete-assistance')
            record = self._record(row, scope)['record']; summary = record['summary']
            # Delivery bookkeeping only: round-robin retries prevent a blocked
            # old summary from starving later evidence. This is not study progress.
            db.execute('INSERT INTO assistance_scan_cursors VALUES(?,?,?,?) ON CONFLICT(owner_id,channel,library_id) DO UPDATE SET last_sequence=excluded.last_sequence',(*scope,row['sequence']))
            body = dict(schemaVersion=1, summaryId=summary_id, summaryHash=summary['summaryHash'], associationHash=record['associationHash'], status=status)
            if reason is not None: body['reason'] = reason
            if proof is not None: body['proof'] = proof
            previous = db.execute('SELECT * FROM assistance_receipts WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=? ORDER BY sequence DESC LIMIT 1', (*scope, summary_id)).fetchone()
            prior = self._receipt(previous, scope, record) if previous else None
            if initial_only:
                if status!='received' or reason is not None or proof is not None: raise ValueError('invalid-assistance-initial-receipt')
                if prior: return prior
            if prior and {k: v for k, v in prior.items() if k != 'receiptId'} == body: return prior
            receipt = check_assistance_receipt(record, dict(body, receiptId='aux-receipt:' + study_hash([body, prior['receiptId'] if prior else None])))
            if prior and prior['status'] == 'applied': raise ValueError('assistance-terminal-receipt')
            if prior and prior['status'] == 'blocked' and status == 'received': raise ValueError('assistance-receipt-regression')
            db.execute('INSERT INTO assistance_receipts(owner_id,channel,library_id,receipt_id,summary_id,receipt_hash,receipt_json) VALUES(?,?,?,?,?,?,?)', (*scope, receipt['receiptId'], summary_id, study_hash(receipt), canonical_json(receipt)))
            return receipt

    def latest_receipt(self, owner, library, summary_id, *, channel='account'):
        scope = _scope(owner, library, channel)
        with self._db() as db:
            parent = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?', (*scope, summary_id)).fetchone()
            row = db.execute('SELECT * FROM assistance_receipts WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=? ORDER BY sequence DESC LIMIT 1', (*scope, summary_id)).fetchone()
            return dict(sequence=row['sequence'], receipt=self._receipt(row, scope, self._record(parent, scope)['record'])) if parent and row else None

    def get(self, owner, library, summary_id, *, channel='account'):
        scope = _scope(owner, library, channel); study_id(summary_id)
        with self._db() as db:
            row = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?',(*scope,summary_id)).fetchone()
            if not row or channel=='account' and row['cloud_sequence']>self._cursor(db,owner,library)['completeThrough']: return None
            return self._record(row,scope)

    def pending_receipts(self, owner, library, limit=20):
        scope = _scope(owner, library); study_count(limit, minimum=1)
        if limit > 20: raise ValueError('invalid-assistance-limit')
        with self._db() as db:
            rows = db.execute('SELECT * FROM assistance_receipts WHERE owner_id=? AND channel=? AND library_id=? AND cloud_sequence IS NULL ORDER BY sequence LIMIT ?', (*scope, limit)).fetchall()
            result = []
            for row in rows:
                parent = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?', (*scope, row['summary_id'])).fetchone()
                result.append(self._receipt(row, scope, self._record(parent, scope)['record']))
            return result

    def ack_receipt(self, owner, library, receipt_id, sequence):
        scope = _scope(owner, library); study_id(receipt_id); study_count(sequence, minimum=1)
        with self._db(write=True) as db:
            row = db.execute('SELECT * FROM assistance_receipts WHERE owner_id=? AND channel=? AND library_id=? AND receipt_id=?', (*scope, receipt_id)).fetchone()
            if not row: raise ValueError('unknown-assistance-receipt')
            parent = db.execute('SELECT * FROM assistance_records WHERE owner_id=? AND channel=? AND library_id=? AND summary_id=?', (*scope, row['summary_id'])).fetchone()
            self._receipt(row, scope, self._record(parent, scope)['record'])
            if row['cloud_sequence'] is not None and row['cloud_sequence'] != sequence: raise ValueError('assistance-receipt-ack-conflict')
            db.execute('UPDATE assistance_receipts SET cloud_sequence=? WHERE sequence=?', (sequence, row['sequence']))
