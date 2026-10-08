"""Explicit user-selected vocabulary ingestion. No learning events or stage writes."""
from __future__ import annotations
import hashlib
import html
import json
import os
import re
import sqlite3
import threading
import unicodedata
import uuid
from contextlib import closing, contextmanager
from datetime import date
from pathlib import Path
from mapped_source_registry import _safe, _atomic
import index_gateway
import source_area

AREA = '01 学习/学术英语词库'
TARGET = AREA + '/00 学术阅读词卡库.md'
BACKUPS = '_System/Backups/词库直接收词'
HEADER = '| 单词 / 词组 | 释义 | 来源论文 | 原文语境 (Context) | 添加时间 |\n|---|---|---|---|---|'
LOCK = threading.RLock()
@contextmanager
def process_lock(journal, vault):
    _safe(vault,journal.with_suffix('.lock'))
    journal.parent.mkdir(parents=True,exist_ok=True)
    _safe(vault,journal.with_suffix('.lock'))
    with journal.with_suffix('.lock').open('a+b') as handle:
        handle.seek(0,os.SEEK_END)
        if handle.tell()==0:handle.write(b'0');handle.flush()
        handle.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(handle.fileno(),msvcrt.LK_LOCK,1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(),fcntl.LOCK_EX)
        try:yield
        finally:
            handle.seek(0)
            if os.name=='nt':msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(handle.fileno(),fcntl.LOCK_UN)
def digest(raw): return hashlib.sha256(raw).hexdigest()
def packed(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def norm(value): return ' '.join(unicodedata.normalize('NFKC',value).casefold().replace('’',"'").replace('‘',"'").replace('‑','-').replace('‐','-').replace('–','-').split())
def meaning_key(value): return ''.join(c for c in norm(html.unescape(value)) if not unicodedata.category(c).startswith(('P','Z')))
def cell(value): return value.replace('<','&lt;').replace('>','&gt;').replace('|','&#124;').replace('\r',' ').replace('\n',' ').strip()
def source_path(vault,relative):
    if not isinstance(relative,str) or not relative.endswith('.md') or re.search(r'[:\[\]|#\\\x00-\x1f]',relative) or relative.startswith('/') or any(x in ('','.','..') for x in relative.split('/')): raise ValueError('vocabulary-source-path')
    path=_safe(vault,vault/relative)
    if not path.is_file(): raise ValueError('vocabulary-source-missing')
    return path

def account_library_for_root(database, owner, vault):
    from account_sync_schema import study_hash
    if not Path(database).is_file():return None
    try:
        with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True)) as db:
            row=db.execute('SELECT library_id,metadata_hash FROM account_sync_libraries WHERE owner_id=? AND vault_ref=?',(owner,str(vault))).fetchone()
            return row[0] if row and row[1]==study_hash([owner,row[0],str(vault)]) else None
    except sqlite3.Error:return None

class Table:
    def __init__(self,raw):
        self.raw=raw;self.bom=raw.startswith(b'\xef\xbb\xbf');self.text=raw.decode('utf-8-sig');self.newline='\r\n' if '\r\n' in self.text else '\n';self.lines=self.text.splitlines(keepends=True)
        meta=source_area._frontmatter(self.text) if hasattr(source_area,'_frontmatter') else index_gateway._meta(self.text)
        if meta.get('type')!='vocabulary-database' or meta.get('status','active') in ('draft','inactive','archived','retired') or meta.get('quality_status')=='draft' or 'migration' in meta.get('type',''):raise ValueError('vocabulary-target-inactive')
        headers=source_area._split_cells(HEADER.splitlines()[0]);matches=[i for i,line in enumerate(self.lines) if source_area._split_cells(line)==headers]
        if len(matches)!=1:raise ValueError('vocabulary-table-header')
        self.index=matches[0]+2
        if self.index>len(self.lines) or len(source_area._split_cells(self.lines[self.index-1]))!=5 or any(not re.fullmatch(r':?-{3,}:?',s) for s in source_area._split_cells(self.lines[self.index-1])):raise ValueError('vocabulary-table-separator')
        self.rows=[]
        for line in self.lines[self.index:]:
            if not line.strip():continue
            if not line.lstrip().startswith('|'):break
            cells=source_area._split_cells(line)
            if len(cells)!=5 or not cells[0] or not cells[1]:raise ValueError('vocabulary-table-row')
            self.rows.append([html.unescape(x) for x in cells])
    def render(self,entries):
        rows=[]
        for e in entries:
            location=f"PDF 第 {e['page']} 页" if e['page'] else e['locator']
            cite=f"[[{e['sourceNote'][:-3]}]]（{e['paperTitle']}；{e['section']}；{location}）"
            rows.append('| '+' | '.join(cell(x) for x in (e['term'],e['meaning'],cite,e['context'],date.today().isoformat()))+' |'+self.newline)
        lines=list(self.lines)
        if not lines[self.index-1].endswith(('\n','\r')):lines[self.index-1]+=self.newline
        lines[self.index:self.index]=rows;text=''.join(lines)
        front=re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)',text,re.S)
        if not front:raise ValueError('vocabulary-frontmatter')
        body=front.group(1);updated='updated: '+date.today().isoformat()
        body=re.sub(r'^updated:[^\r\n]*',updated,body,flags=re.M) if re.search(r'^updated:',body,re.M) else body+self.newline+updated
        text=text[:front.start(1)]+body+text[front.end(1):]
        return (b'\xef\xbb\xbf' if self.bom else b'')+text.encode()

class VocabularyWriter:
    def __init__(self,vault,journal,owner,library,catalog_loader,account_library=None):
        self.vault=Path(vault);_safe(self.vault,self.vault)
        self.journal=Path(journal);self.owner=owner;self.library=library;self.catalog_loader=catalog_loader;self.account_library=account_library
    def _snapshot(self,source):
        path=source_path(self.vault,TARGET);raw=path.read_bytes();table=Table(raw);src=source_path(self.vault,source)
        catalog=self.catalog_loader();refs=[]
        for ref in catalog.get('references',[]):
            relative,fragment=index_gateway._link(ref.get('contentRef',''))
            if relative==TARGET and not fragment:refs.append(ref)
        if not catalog.get('active') or len(refs)!=1 or not any(d['id']==refs[0]['subjectId'] and d['contentRoot']==AREA for d in catalog.get('planningDefinitions',[])):raise ValueError('vocabulary-target-not-registered')
        words=[(r[0],r[1]) for r in table.rows]
        academic={d['id'] for d in catalog.get('planningDefinitions',[]) if d['contentRoot']==AREA}
        for s in catalog.get('subjects',[]):
            if s['id'] in academic and s.get('pluginType') in ('three-stage','spelling'):
                words.extend((x['word'],x['meaning']) for x in s.get('items',[]) if x.get('word') and x.get('meaning'))
        revision=digest(packed([digest(raw),digest(src.read_bytes()),words,catalog.get('references'),catalog.get('planningDefinitions'),self.library,self.account_library]))
        return table,words,revision
    def target(self,source):
        with LOCK,index_gateway.LOCK:
            _,_,revision=self._snapshot(source)
            return {'localLibraryId':self.library,'accountLibraryId':self.account_library,'revision':revision,'target':TARGET}
    def _db(self):
        self.journal.parent.mkdir(parents=True,exist_ok=True)
        db=sqlite3.connect(self.journal,timeout=30);db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE IF NOT EXISTS vocabulary_requests(owner TEXT, library TEXT, request TEXT, payload TEXT, before_hash TEXT, after_hash TEXT, output BLOB, receipt TEXT, complete INTEGER, PRIMARY KEY(owner,library,request))')
        return db
    def _complete(self,db,key,receipt):
        db.execute('UPDATE vocabulary_requests SET complete=1 WHERE owner=? AND library=? AND request=?',key);db.commit();return receipt
    def append(self,payload):
        if not isinstance(payload,dict) or payload.get('localLibraryId')!=self.library or (payload.get('accountLibraryId') and payload['accountLibraryId']!=self.account_library):raise ValueError('vocabulary-library-changed')
        request=payload.get('requestId');entries=payload.get('entries')
        if not isinstance(request,str) or not re.fullmatch(r'[A-Za-z0-9:-]{8,100}',request) or not isinstance(entries,list) or not 1<=len(entries)<=32:raise ValueError('vocabulary-request-invalid')
        key=(self.owner,self.library,request);payload_hash=digest(packed(payload))
        with LOCK,index_gateway.LOCK,process_lock(self.vault/'_System/Locks/academic-vocabulary.db',self.vault),closing(self._db()) as db:
            # SQLite transaction serializes writers across server instances/processes.
            db.execute('BEGIN IMMEDIATE')
            prior=db.execute('SELECT * FROM vocabulary_requests WHERE owner=? AND library=? AND request=?',key).fetchone()
            if prior:
                if prior['payload']!=payload_hash:raise ValueError('vocabulary-request-reused')
                receipt=json.loads(prior['receipt'])
                if prior['complete']:return receipt
                current=source_path(self.vault,TARGET).read_bytes()
                if digest(current)==prior['after_hash']:return self._complete(db,key,receipt)
                if digest(current)!=prior['before_hash']:raise ValueError('vocabulary-uncertain-external-edit')
                _,_,revision=self._snapshot(entries[0]['sourceNote'])
                if revision!=payload.get('expectedRevision'):raise ValueError('vocabulary-stale-revision')
                if receipt.get('backupRelative'):
                    backup=_safe(self.vault,self.vault/receipt['backupRelative'])
                    if digest(backup.read_bytes())!=prior['before_hash']:raise ValueError('vocabulary-backup-changed')
                _atomic(self.vault,self.vault/TARGET,prior['output'],current)
                if source_path(self.vault,TARGET).read_bytes()!=prior['output']:raise OSError('vocabulary-readback-failed')
                return self._complete(db,key,receipt)
            ids=set();sources=set()
            for e in entries:
                if not isinstance(e,dict):raise ValueError('vocabulary-entry')
                for field,limit in [('id',240),('term',160),('meaning',1000),('context',5000),('sourceNote',500),('paperTitle',400),('section',400)]:
                    v=e.get(field)
                    if not isinstance(v,str) or not v.strip() or len(v)>limit or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',v):raise ValueError('vocabulary-entry-'+field)
                if e['id'] in ids:raise ValueError('vocabulary-duplicate-id')
                ids.add(e['id']);sources.add(e['sourceNote']);source_path(self.vault,e['sourceNote'])
                term=norm(e['term'])
                if not re.fullmatch(r"[a-z][a-z0-9]*(?:[-'][a-z0-9]+)*(?: [a-z][a-z0-9]*(?:[-'][a-z0-9]+)*){0,7}",term) or not re.search(r"(?<![a-z0-9'-])"+re.escape(term)+r"(?![a-z0-9'-])",norm(e['context'])):raise ValueError('vocabulary-context-mismatch')
                if type(e.get('page')) is not int or not 0<=e['page']<=5000:raise ValueError('vocabulary-page')
                if e['page']==0 and (not isinstance(e.get('locator'),str) or not e['locator'].strip() or len(e['locator'])>160 or re.search(r'[\x00-\x1f]',e['locator'])):raise ValueError('vocabulary-page')
                # Direct indexing preserves exact user text. Unsupported table syntax can be exported.
                if any(re.search(r'[|<>]|&(?:#\d+|\w+);',e[k]) for k in ('term','meaning','context')):raise ValueError('vocabulary-table-syntax-use-export')
            if len(sources)!=1:raise ValueError('vocabulary-one-source-required')
            table,words,revision=self._snapshot(next(iter(sources)))
            if payload.get('expectedRevision')!=revision:raise ValueError('vocabulary-stale-revision')
            known={}
            for term,meaning in words:known.setdefault(norm(term),set()).add(meaning_key(meaning))
            grouped={}
            for e in entries:grouped.setdefault(norm(e['term']),set()).add(meaning_key(e['meaning']))
            added=[];results=[]
            for e in entries:
                term=norm(e['term']);meaning=meaning_key(e['meaning']);existing=known.get(term,set())
                status='conflict' if len(grouped[term])>1 or (existing and existing!={meaning}) else 'existing' if existing else 'added'
                if status=='added':added.append(e);known[term]={meaning}
                results.append({'id':e['id'],'status':status})
            output=table.render(added) if added else table.raw
            backup=f'{BACKUPS}/{uuid.uuid4().hex}.md' if added else None
            receipt={'requestId':request,'localLibraryId':self.library,'results':results,'gatewayRecognized':False,**({'backupRelative':backup} if backup else {})}
            if backup:
                bp=_safe(self.vault,self.vault/backup);bp.parent.mkdir(parents=True,exist_ok=True);_safe(self.vault,bp)
                with bp.open('xb') as handle:handle.write(table.raw);handle.flush();os.fsync(handle.fileno())
            db.execute('INSERT INTO vocabulary_requests VALUES(?,?,?,?,?,?,?,?,0)',(*key,payload_hash,digest(table.raw),digest(output),output,json.dumps(receipt,ensure_ascii=False)));db.commit()
            # Keep the process lock; reacquire the journal lock before replacing the target.
            db.execute('BEGIN IMMEDIATE')
            if added:
                _atomic(self.vault,self.vault/TARGET,output,table.raw)
                if source_path(self.vault,TARGET).read_bytes()!=output:raise OSError('vocabulary-readback-failed')
            try:
                catalog=self.catalog_loader();recognized={(norm(x.get('word','')),meaning_key(x.get('meaning',''))) for s in catalog.get('subjects',[]) for x in s.get('items',[]) if any(b.get('subjectId')==s['id'] and b.get('documentPath')==TARGET for b in catalog.get('bindings',{}).values())}
                receipt['gatewayRecognized']=all((norm(e['term']),meaning_key(e['meaning'])) in recognized for e,r in zip(entries,results) if r['status']!='conflict') and any(r['status']!='conflict' for r in results)
            except (ValueError,OSError):pass
            db.execute('UPDATE vocabulary_requests SET receipt=? WHERE owner=? AND library=? AND request=?',(json.dumps(receipt,ensure_ascii=False),*key))
            return self._complete(db,key,receipt)
