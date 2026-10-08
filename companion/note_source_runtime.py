"""Native source scheduling and safe setup status; no browser or cloud credentials."""
import json
import sqlite3
import threading
from contextlib import closing
from pathlib import Path
import companion_setup
import source_results
from external_sources import safe_error


class SourceRuntime:
    def __init__(self, service, validate_event):
        self.service=service;self.validate_event=validate_event;self.lock=threading.RLock()
        with service.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS source_scan_cursor(owner TEXT,source TEXT,cursor_json TEXT,error TEXT,PRIMARY KEY(owner,source))')

    def deliver(self,owner,source):
        with self.lock:
            with self.service.db() as db:
                row=db.execute('SELECT cursor_json FROM source_scan_cursor WHERE owner=? AND source=?',(owner,source)).fetchone()
            try:
                records,cursor=source_results.read_results(self.service.data,owner,self.validate_event,json.loads(row[0]) if row else None)
                self.service.deliver_results(owner,source,records)
                with self.service.db() as db:
                    db.execute('INSERT INTO source_scan_cursor VALUES(?,?,?,NULL) ON CONFLICT(owner,source) DO UPDATE SET cursor_json=excluded.cursor_json,error=NULL',(owner,source,json.dumps(cursor)))
            except (ValueError,OSError,sqlite3.Error) as error:
                with self.service.db() as db:
                    db.execute('INSERT INTO source_scan_cursor VALUES(?,?,?,?) ON CONFLICT(owner,source) DO UPDATE SET error=excluded.error',(owner,source,'{}',safe_error(error)))

    def tick(self,owner):
        for source in self.service.list(owner):
            if not source['enabled']:continue
            row=self.service._row(owner,source['sourceId'])
            if row['next_read']<=self.service.clock():self.service.sync(owner,source['sourceId'])
            if source['kind']=='notion' and source['selection'].get('writeEnabled'):self.deliver(owner,source['sourceId'])


def setup_status(root):
    config,revision=companion_setup.settings(root)
    path=config.get('learning_vault_root','')
    return {'revision':revision,'mode':config.get('workspace_mode','existing'),'path':path,'available':bool(path) and Path(path).is_dir()}


def has_history(data):
    # A paired account alone does not prevent choosing its first workspace.
    tables=('study_events_v3','local_activity_events','account_sync_libraries','account_inbox_records','account_outbox_records','note_sources','vault_mapping')
    for path in Path(data).glob('*.db'):
        with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            present={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in tables:
                if table in present and db.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone():return True
    return False
