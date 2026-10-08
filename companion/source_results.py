"""Bounded scans of already persisted practice evidence for external delivery."""
from __future__ import annotations
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from account_sync_schema import validate_record


def read_results(data_directory,owner,validate_event,cursor=None,*,limit=200):
    cursor=cursor or {};result=[];following={}
    for channel,name,table,sequence,query in [
        ('account','account-study.db','account_inbox_records','rowid',"SELECT rowid,record_json,status FROM account_inbox_records WHERE account_id=? AND rowid>? ORDER BY rowid LIMIT ?"),
        ('local','study-loop.db','study_events_v3','rowid',"SELECT rowid,event_json,local_context_json FROM study_events_v3 WHERE account_id=? AND rowid>? ORDER BY rowid LIMIT ?")]:
        path=Path(data_directory)/name;after=int(cursor.get(channel,0));following[channel]=0
        if not path.exists():continue
        with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():continue
            rows=db.execute(query,(owner,after,limit)).fetchall()
            following[channel]=rows[-1][0] if len(rows)==limit else 0
            for row in rows:
                try:
                    if channel=='account':
                        if row[2]!='applied':continue
                        record=validate_record(json.loads(row[1]));event=record['event'];title=''
                    else:
                        event=validate_event(json.loads(row[1]));context=json.loads(row[2]) if row[2] else {};title=context.get('title','')
                        projected=db.execute('SELECT status FROM study_event_projections WHERE account_id=? AND event_id=?',(owner,event['eventId'])).fetchone()
                        if not projected or projected[0]!='applied':continue
                    if event.get('eventType')!='practice-attempt':continue
                    result.append({'event':event,'title':title})
                except (ValueError,KeyError,TypeError):raise ValueError('source-local-history-invalid') from None
    # A bounded rotating scan includes records that became applied after an
    # earlier pass. Durable outbox identities deduplicate revisited evidence.
    return result,following
