"""Durable Notion result delivery. Unknown outcomes are reconciled, never blindly repeated."""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from notion_connector import NotionError, page_id


def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


class NotionOutbox:
    def __init__(self,path,*,clock=time.time):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True);self.clock=clock
        with self.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS notion_result_outbox(
              owner TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,core_hash TEXT NOT NULL,parent TEXT NOT NULL,day TEXT NOT NULL,
              content TEXT NOT NULL,marker TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',block_id TEXT,error TEXT,next_attempt REAL NOT NULL DEFAULT 0,
              PRIMARY KEY(owner,source,event_id));
              CREATE TABLE IF NOT EXISTS notion_daily_pages(owner TEXT NOT NULL,source TEXT NOT NULL,parent TEXT NOT NULL,day TEXT NOT NULL,
              title TEXT NOT NULL,marker TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',page_id TEXT,error TEXT,PRIMARY KEY(owner,source,parent,day));''')
            columns={row['name'] for row in db.execute('PRAGMA table_info(notion_result_outbox)')}
            if 'state_version' not in columns:db.execute('ALTER TABLE notion_result_outbox ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0')
            if 'claim_id' not in columns:db.execute('ALTER TABLE notion_result_outbox ADD COLUMN claim_id TEXT')

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()

    def enqueue(self,owner,source,parent,event_id,core_hash,day,content):
        if not re.fullmatch('[a-f0-9]{64}',owner) or not re.fullmatch('[a-f0-9]{64}',core_hash):raise ValueError('notion-result-identity')
        if not isinstance(event_id,str) or not event_id or len(event_id)>160 or not isinstance(source,str) or not source or len(source)>160:raise ValueError('notion-result-identity')
        date.fromisoformat(day);parent=page_id(parent);marker='zx-result-'+digest([owner,source,event_id])[:32]
        if not isinstance(content,str) or len(content)>1650:raise ValueError('notion-result-too-large')
        text=content+'\n\n记录标识：'+marker
        with self.db() as db:
            old=db.execute('SELECT core_hash,parent FROM notion_result_outbox WHERE owner=? AND source=? AND event_id=?',(owner,source,event_id)).fetchone()
            if old:
                if old['core_hash']!=core_hash or old['parent']!=parent:raise ValueError('notion-result-conflict')
                return
            db.execute('INSERT INTO notion_result_outbox(owner,source,event_id,core_hash,parent,day,content,marker) VALUES(?,?,?,?,?,?,?,?)',(owner,source,event_id,core_hash,parent,day,text,marker))

    def _page(self,owner,source,parent,day,label,client):
        scope=(owner,source,parent,day);marker='zx-page-'+digest(scope)[:32]
        title=f'{day} · 知学学习记录 · {label[:70]} · {digest([owner,source])[:8]}'
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO notion_daily_pages(owner,source,parent,day,title,marker) VALUES(?,?,?,?,?,?)',(*scope,title,marker))
            row=dict(db.execute('SELECT * FROM notion_daily_pages WHERE owner=? AND source=? AND parent=? AND day=?',scope).fetchone())
        found=row['page_id'] or client.find_child_page(parent,row['title'])
        if found:
            if not client.verify_results_page(found,marker,parent):raise NotionError('notion-target-conflict')
            with self.db() as db:db.execute("UPDATE notion_daily_pages SET status='ready',page_id=?,error=NULL WHERE owner=? AND source=? AND parent=? AND day=?",(found,*scope))
            return found
        if row['status'] in ('creating','uncertain'):raise NotionError('notion-write-indeterminate',uncertain=True)
        with self.db() as db:
            claimed=db.execute("UPDATE notion_daily_pages SET status='creating' WHERE owner=? AND source=? AND parent=? AND day=? AND status='pending'",scope).rowcount
        if not claimed:raise NotionError('notion-write-indeterminate',uncertain=True)
        try:
            found=client.create_results_page(parent,row['title'],marker)
            with self.db() as db:db.execute("UPDATE notion_daily_pages SET status='ready',page_id=?,error=NULL WHERE owner=? AND source=? AND parent=? AND day=?",(found,*scope))
            if not client.verify_results_page(found,marker,parent):raise NotionError('notion-write-indeterminate',uncertain=True)
            return found
        except NotionError as error:
            with self.db() as db:db.execute('UPDATE notion_daily_pages SET status=?,error=? WHERE owner=? AND source=? AND parent=? AND day=?',('uncertain' if error.uncertain else 'pending',str(error),*scope))
            raise

    def deliver(self,owner,source,parent,label,client,*,limit=20):
        parent=page_id(parent)
        with self.db() as db:rows=[dict(r) for r in db.execute("SELECT * FROM notion_result_outbox WHERE owner=? AND source=? AND parent=? AND status!='written' AND next_attempt<=? ORDER BY day,event_id LIMIT ?",(owner,source,parent,self.clock(),limit))]
        for row in rows:
            identity=(owner,source,row['event_id']);append_started=False;append_confirmed=False;claim=None;expected_version=row['state_version']
            try:
                page=self._page(owner,source,parent,row['day'],label,client)
                block=client.find_result(page,row['marker'],row['content'])
                if not block:
                    if row['status']!='pending':raise NotionError('notion-write-indeterminate',uncertain=True)
                    claim=uuid.uuid4().hex
                    with self.db() as db:claimed=db.execute("UPDATE notion_result_outbox SET status='creating',claim_id=?,state_version=state_version+1 WHERE owner=? AND source=? AND event_id=? AND status='pending' AND state_version=?",(claim,*identity,row['state_version'])).rowcount
                    if not claimed:continue
                    expected_version+=1;append_started=True;client.append_result(page,row['content']);append_confirmed=True
                    block=client.find_result(page,row['marker'],row['content'])
                    if not block:raise NotionError('notion-write-indeterminate',uncertain=True)
                with self.db() as db:db.execute("UPDATE notion_result_outbox SET status='written',block_id=?,error=NULL,next_attempt=0,claim_id=NULL,state_version=state_version+1 WHERE owner=? AND source=? AND event_id=? AND state_version=?",(block,*identity,expected_version))
            except NotionError as error:
                with self.db() as db:
                    if append_started:
                        state='uncertain' if append_confirmed or error.uncertain else 'pending'
                        db.execute('UPDATE notion_result_outbox SET status=?,error=?,next_attempt=?,claim_id=NULL,state_version=state_version+1 WHERE owner=? AND source=? AND event_id=? AND state_version=? AND claim_id=?',(state,str(error),self.clock()+error.retry_after,*identity,expected_version,claim))
                    else:
                        # A reader owns no append claim. Its failure may annotate
                        # the unchanged snapshot, but cannot reopen another writer.
                        db.execute('UPDATE notion_result_outbox SET error=?,next_attempt=? WHERE owner=? AND source=? AND event_id=? AND state_version=?',(str(error),self.clock()+error.retry_after,*identity,row['state_version']))
                if str(error) in ('notion-rate-limit','notion-unauthorized','notion-permission','notion-network','notion-timeout'):break
        return self.summary(owner,source)

    def summary(self,owner,source):
        with self.db() as db:
            rows=db.execute('SELECT status,count(*) AS n FROM notion_result_outbox WHERE owner=? AND source=? GROUP BY status',(owner,source)).fetchall()
            pages=db.execute("SELECT count(*) FROM notion_daily_pages WHERE owner=? AND source=? AND status IN ('creating','uncertain')",(owner,source)).fetchone()[0]
            error=db.execute('SELECT error FROM notion_result_outbox WHERE owner=? AND source=? AND error IS NOT NULL ORDER BY rowid DESC LIMIT 1',(owner,source)).fetchone()
        counts={r['status']:r['n'] for r in rows}
        return {'written':counts.get('written',0),'pending':counts.get('pending',0),'uncertain':counts.get('creating',0)+counts.get('uncertain',0),'uncertainPages':pages,'error':error[0] if error else None}
