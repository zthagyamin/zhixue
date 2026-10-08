"""Owner-scoped note sources, preview/commit and independent Notion result delivery."""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import external_source_registry as registry
from note_imports import read_local_documents, learning_items
from notion_connector import NotionClient, NotionError, page_id
from notion_writeback import NotionOutbox

CAPABILITY='note-sources-v1'
KEY_SERVICE='Zhixue Note Sources'
ERRORS={
 'source-code-fields-required':'代码练习需要题干、初始代码和测试代码，请按入门包模板补齐。',
 'source-item-too-large':'单条问题或答案过长，请按章节拆分；未截断或导入。',
 'source-local-history-invalid':'本机学习记录校验未通过，已保留记录，写回等待核对。',
 'source-not-found':'来源不存在，请刷新来源列表。',
 'source-pdf-unavailable':'PDF 已加密、损坏或页数过多，请选择可读取的较小文件。',
 'source-path-unavailable':'来源位置不可用，请检查目录、移动磁盘或云盘下载状态。',
 'source-file-unavailable':'部分文件无法读取，已保留上次完整资料。',
 'source-invalid-encoding':'文件编码无法读取，请选择正确编码或重新导出 UTF-8。',
 'source-unsupported-format':'请选择 Markdown、TXT、HTML、PDF、CSV 或 Notion 导出 ZIP。',
 'source-csv-columns-required':'CSV 需要词汇/释义列或问题/答案列，请调整导出或选择 Markdown 页面。',
 'source-no-documents':'没有找到可读取的原始笔记，学习记录和系统目录不会被重新导入。',
 'source-no-extractable-text':'未读取到文字，请为扫描件先做文字识别或选择文本导出。',
 'source-no-learning-content':'没有可提取的学习内容，请选择包含正文或词汇/问答表的文件。',
 'source-selection-too-large':'所选资料过多，请分成较小的文件夹或导出包。',
 'source-file-too-large':'文件过大，请按章节拆分后导入。',
 'source-too-many-learning-items':'学习条目超过单次上限，请分批选择资料。',
 'source-unsafe-archive':'导出包含不安全路径，未解压或导入。',
 'source-invalid-archive':'导出包无法读取，请重新导出 ZIP。',
 'source-linked-file':'来源含重定向文件，请选择文件实际所在目录。',
 'setup-linked-path':'请选择实际目录；快捷链接和目录联接不作为写入位置。',
 'source-duplicate-document':'资料中出现重复文档标识，请分开选择或修正标识。',
 'source-ambiguous-item':'相同条目标识对应不同内容，请补充唯一 ID 或拆分来源。',
 'source-preview-stale':'资料在预览后发生变化，请重新预览后确认。',
 'source-stale':'来源设置已变化，请重新读取后操作。',
 'source-generated-file-conflict':'知学生成文件被修改，已停止覆盖，请核对或恢复备份。',
 'source-manifest-conflict':'来源登记信息不一致，已保留文件，请核对学习空间。',
 'source-state-conflict':'学习记录位置不一致，已停止覆盖。',
 'source-read-failed':'来源读取未完成，已保留上次完整资料，请重试。',
 'source-is-generated':'知学学习记录不能再次作为原始教材导入。',
 'source-key-store-unavailable':'无法保存到本机凭据库，请从当前用户桌面启动 Companion。',
 'source-parent-change-pending':'仍有记录等待写回原位置，请先完成或核对这些记录。',
 'notion-invalid-page':'请填写 Notion 页面链接或页面 ID；数据库请选具体页面或使用导出文件。',
 'notion-key-required':'请在本机来源设置中填写 Notion 授权令牌。',
 'notion-unauthorized':'Notion 授权失效，请重新授权。',
 'notion-permission':'Notion 权限不足，请检查来源页和记录页的连接权限。',
 'notion-page-unavailable':'Notion 页面不存在或不可访问，请检查是否已授权该页面。',
 'notion-rate-limit':'Notion 暂时限流，稍后会按要求重试。',
 'notion-network':'Companion 无法连接 Notion API。请检查运行 Companion 的电脑能否访问 api.notion.com；浏览器能打开 Notion 不代表本机程序网络可用。若使用代理，请确认代理允许本机程序访问。已有资料和待写回记录均保留。',
 'notion-timeout':'Notion 读取超时，请稍后重试或减少一次选择的页面。',
 'notion-unavailable':'Notion 暂时不可用，已有资料和记录均保留。',
 'notion-incomplete-page':'Notion 页面未完整读取，请选择更小的子页面或使用导出文件。',
 'notion-response-too-large':'Notion 页面过大，请分成子页面同步。',
 'notion-write-indeterminate':'写回结果暂不明确，系统会先核对 Notion，避免重复提交。',
 'notion-result-conflict':'Notion 中的对应记录已变化，请核对后处理，系统不会覆盖。',
 'notion-target-conflict':'Notion 目标页面不是本来源创建的记录页，已停止写入。',
 'notion-duplicate-target':'Notion 中存在多个同名记录页，请核对重复页面。',
}


def safe_error(error):return str(error) if str(error) in ERRORS else 'source-read-failed'
def fingerprint(documents):return registry.sha(registry.encoded([{k:doc.get(k,'') for k in ('key','title','markdown','format','url')} for doc in documents]))


class ExternalSources:
    def __init__(self,data_directory,vault_resolver,keys,*,verify_owner,client_factory=NotionClient,clock=time.time):
        self.data=Path(data_directory);self.data.mkdir(parents=True,exist_ok=True);self.path=self.data/'note-sources.db';self.vault_resolver=vault_resolver;self.keys=keys;self.verify_owner=verify_owner;self.client_factory=client_factory;self.clock=clock;self.lock=threading.RLock();self.previews={}
        with self.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS note_sources(owner TEXT NOT NULL,source_id TEXT NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,
              selection_json TEXT NOT NULL,credential_ref TEXT,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,manifest_json TEXT,last_read TEXT,error TEXT,next_read REAL NOT NULL DEFAULT 0,
              PRIMARY KEY(owner,source_id))''')
            db.execute('CREATE TABLE IF NOT EXISTS source_item_history(owner TEXT,source TEXT,item_key TEXT,metadata_json TEXT,PRIMARY KEY(owner,source,item_key))')
            for row in db.execute('SELECT owner,source_id,manifest_json FROM note_sources WHERE manifest_json IS NOT NULL').fetchall():
                self._remember_items(db,row['owner'],row['source_id'],json.loads(row['manifest_json']))
        self.outbox=NotionOutbox(self.path,clock=clock)

    @staticmethod
    def _remember_items(db,owner,source,manifest):
        for key,value in manifest['items'].items():
            db.execute('INSERT OR IGNORE INTO source_item_history VALUES(?,?,?,?)',(owner,source,key,json.dumps(value,ensure_ascii=False)))

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()

    def _owner(self,owner):
        if not isinstance(owner,str) or not re.fullmatch('[a-f0-9]{64}',owner) or not self.verify_owner(owner):raise ValueError('source-owner-required')
    def _row(self,owner,source):
        self._owner(owner)
        with self.db() as db:row=db.execute('SELECT * FROM note_sources WHERE owner=? AND source_id=?',(owner,source)).fetchone()
        if not row:raise ValueError('source-not-found')
        return dict(row)
    def _public(self,row):
        manifest=json.loads(row['manifest_json']) if row['manifest_json'] else None;selection=json.loads(row['selection_json'])
        writeback=self.outbox.summary(row['owner'],row['source_id']) if selection.get('writeEnabled') else None
        if writeback is not None:
            with self.db() as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_scan_cursor'").fetchone():
                    scan=db.execute('SELECT error FROM source_scan_cursor WHERE owner=? AND source=?',(row['owner'],row['source_id'])).fetchone()
                    if scan and scan[0]:writeback['error']=scan[0]
        if writeback is not None:writeback['message']=ERRORS.get(writeback['error'],'写回未完成，请核对授权与目标页。') if writeback['error'] else ''
        return {'sourceId':row['source_id'],'label':row['label'],'kind':row['kind'],'revision':row['revision'],'enabled':bool(row['enabled']),
                'configured':bool(row['credential_ref']) if row['kind']=='notion' else True,'selection':selection,'lastRead':row['last_read'],
                'itemCount':len(manifest['items']) if manifest else 0,'error':row['error'],'message':ERRORS.get(row['error'],''),
                'writeback':writeback}
    def list(self,owner):
        self._owner(owner)
        with self.db() as db:rows=[dict(row) for row in db.execute('SELECT * FROM note_sources WHERE owner=? ORDER BY rowid',(owner,))]
        return [self._public(row) for row in rows]
    def _key(self,row):
        if not row['credential_ref']:raise NotionError('notion-key-required')
        try:key=self.keys.get_password(KEY_SERVICE,row['credential_ref'])
        except Exception:raise ValueError('source-key-store-unavailable') from None
        if not key:raise NotionError('notion-key-required')
        return key

    def _selection(self,owner,raw):
        if not isinstance(raw,dict) or set(raw)-{'sourceId','expectedRevision','kind','label','path','pages','token','writeEnabled','writePage','encoding','language'}:raise ValueError('source-invalid-request')
        kind=raw.get('kind');label=raw.get('label','')
        if kind not in ('folder','file','notion-export','notion') or not isinstance(label,str) or not 1<=len(label.strip())<=120:raise ValueError('source-invalid-request')
        source=raw.get('sourceId');old=self._row(owner,source) if source else None
        if old and (raw.get('expectedRevision')!=old['revision'] or kind!=old['kind']):raise ValueError('source-stale')
        source=source or str(uuid.uuid4());selection={'kind':kind,'label':label.strip(),'encoding':raw.get('encoding','auto'),'language':raw.get('language','')}
        if selection['encoding'] not in ('auto','utf-8','utf-8-sig','utf-16','gb18030') or not re.fullmatch(r'[A-Za-z-]{0,16}',str(selection['language'])):raise ValueError('source-invalid-request')
        key=None
        if kind=='notion':
            pages=raw.get('pages')
            if not isinstance(pages,list) or not 1<=len(pages)<=10:raise ValueError('notion-invalid-page')
            selection['pages']=list(dict.fromkeys(page_id(value) for value in pages));selection['writeEnabled']=raw.get('writeEnabled',False)
            if type(selection['writeEnabled']) is not bool:raise ValueError('source-invalid-request')
            if selection['writeEnabled']:
                selection['writePage']=page_id(raw.get('writePage'))
                if selection['writePage'] in selection['pages']:raise ValueError('source-is-generated')
            supplied=raw.get('token')
            if supplied is not None and (not isinstance(supplied,str) or len(supplied)>512):raise NotionError('notion-key-required')
            key=supplied.strip() if supplied and supplied.strip() else self._key(old) if old else None
            if not key:raise NotionError('notion-key-required')
            if old:
                before=json.loads(old['selection_json']);pending=self.outbox.summary(owner,source)
                if before.get('writePage')!=selection.get('writePage') and (pending['pending'] or pending['uncertain'] or pending['uncertainPages']):raise ValueError('source-parent-change-pending')
        else:
            path=raw.get('path')
            if not isinstance(path,str) or not path.strip() or len(path)>2000:raise ValueError('source-path-unavailable')
            selection['path']=str(Path(path.strip().strip('"')).expanduser().absolute())
        return source,selection,key,old

    def _capture(self,selection,key):
        if selection['kind']=='notion':
            client=self.client_factory(key);docs=[client.read_page(identifier) for identifier in selection['pages']]
            if selection.get('writeEnabled'):client.request('GET','/pages/'+selection['writePage'])
        else:docs=read_local_documents(Path(selection['path']),encoding=selection['encoding'])
        return docs

    def preview(self,owner,raw):
        self._owner(owner);source,selection,key,old=self._selection(owner,raw);vault=Path(self.vault_resolver()).resolve()
        documents=self._capture(selection,key);items=learning_items(documents,source);self._owner(owner)
        token=str(uuid.uuid4())
        with self.lock:
            self.previews={k:v for k,v in self.previews.items() if v['expires']>self.clock()}
            if len(self.previews)>=8:self.previews.pop(next(iter(self.previews)))
            self.previews[token]={'owner':owner,'source':source,'selection':selection,'key':key,'revision':old['revision'] if old else 0,'fingerprint':fingerprint(documents),'vault':str(vault),'expires':self.clock()+600}
        return {'previewId':token,'documentCount':len(documents),'itemCount':len(items),'samples':[{'title':item.get('word') or item.get('topic'),'kind':item['kind'],'reference':(item.get('meaning') or item.get('answer',''))[:600]} for item in items[:3]],'writeEnabled':selection.get('writeEnabled',False),'readComplete':True}

    def commit(self,owner,preview_id):
        self._owner(owner)
        with self.lock:preview=self.previews.get(preview_id)
        if not preview or preview['owner']!=owner or preview['expires']<=self.clock():raise ValueError('source-preview-stale')
        selection=preview['selection'];documents=self._capture(selection,preview['key'])
        if fingerprint(documents)!=preview['fingerprint']:raise ValueError('source-preview-stale')
        items=learning_items(documents,preview['source'])
        with self.lock:
            self._owner(owner);vault=Path(self.vault_resolver()).resolve()
            if str(vault)!=preview['vault']:raise ValueError('source-preview-stale')
            with self.db() as db:old=db.execute('SELECT * FROM note_sources WHERE owner=? AND source_id=?',(owner,preview['source'])).fetchone()
            if (old['revision'] if old else 0)!=preview['revision']:raise ValueError('source-stale')
            if old and selection['kind']=='notion':
                before=json.loads(old['selection_json']);pending=self.outbox.summary(owner,preview['source'])
                if before.get('writePage')!=selection.get('writePage') and (pending['pending'] or pending['uncertain'] or pending['uncertainPages']):raise ValueError('source-parent-change-pending')
            manifest=registry.publish(vault,owner,preview['source'],documents,items,selection['label'],selection['language'],json.loads(old['manifest_json']) if old and old['manifest_json'] else None)
            credential=old['credential_ref'] if old else None
            if selection['kind']=='notion':
                credential=owner+':'+preview['source']+':'+uuid.uuid4().hex
                try:self.keys.set_password(KEY_SERVICE,credential,preview['key'])
                except Exception:raise ValueError('source-key-store-unavailable') from None
            with self.db() as db:
                changed=db.execute('INSERT INTO note_sources(owner,source_id,label,kind,selection_json,credential_ref,revision,enabled,manifest_json,last_read,error,next_read) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(owner,source_id) DO UPDATE SET label=excluded.label,selection_json=excluded.selection_json,credential_ref=excluded.credential_ref,revision=excluded.revision,enabled=1,manifest_json=excluded.manifest_json,last_read=excluded.last_read,error=NULL,next_read=excluded.next_read WHERE note_sources.revision=?',
                    (owner,preview['source'],selection['label'],selection['kind'],json.dumps(selection,ensure_ascii=False),credential,preview['revision']+1,1,json.dumps(manifest,ensure_ascii=False),datetime.now(timezone.utc).isoformat(),self.clock()+(300 if selection['kind']=='notion' else 60),preview['revision'])).rowcount
                if changed!=1:raise ValueError('source-stale')
                self._remember_items(db,owner,preview['source'],manifest)
            self.previews.pop(preview_id,None)
        return self._public(self._row(owner,preview['source']))

    def set_enabled(self,owner,source,revision,enabled):
        if type(enabled) is not bool:raise ValueError('source-invalid-request')
        with self.lock:
            row=self._row(owner,source)
            if row['revision']!=revision:raise ValueError('source-stale')
            with self.db() as db:db.execute('UPDATE note_sources SET enabled=?,revision=revision+1,next_read=0 WHERE owner=? AND source_id=? AND revision=?',(int(enabled),owner,source,revision))
        return self._public(self._row(owner,source))

    def sync(self,owner,source):
        row=self._row(owner,source)
        if not row['enabled']:return self._public(row)
        selection=json.loads(row['selection_json']);vault=Path(self.vault_resolver()).resolve()
        try:
            documents=self._capture(selection,self._key(row) if row['kind']=='notion' else None);items=learning_items(documents,source)
            with self.lock:
                current=self._row(owner,source)
                if current['revision']!=row['revision'] or not current['enabled'] or Path(self.vault_resolver()).resolve()!=vault:raise ValueError('source-stale')
                manifest=registry.publish(vault,owner,source,documents,items,row['label'],selection['language'],json.loads(row['manifest_json']) if row['manifest_json'] else None)
                with self.db() as db:
                    changed=db.execute('UPDATE note_sources SET manifest_json=?,last_read=?,error=NULL,next_read=? WHERE owner=? AND source_id=? AND revision=?',(json.dumps(manifest,ensure_ascii=False),datetime.now(timezone.utc).isoformat(),self.clock()+(300 if row['kind']=='notion' else 60),owner,source,row['revision'])).rowcount
                    if changed!=1:raise ValueError('source-stale')
                    self._remember_items(db,owner,source,manifest)
        except (ValueError,OSError,sqlite3.Error) as error:
            with self.db() as db:db.execute('UPDATE note_sources SET error=?,next_read=? WHERE owner=? AND source_id=? AND revision=?',(safe_error(error),self.clock()+max(60,getattr(error,'retry_after',0)),owner,source,row['revision']))
        return self._public(self._row(owner,source))

    def catalog_refs(self,owner):
        self._owner(owner);vault=Path(self.vault_resolver()).resolve();indexes=[];entry=None
        with self.db() as db:rows=[dict(r) for r in db.execute('SELECT * FROM note_sources WHERE owner=? AND enabled=1 AND manifest_json IS NOT NULL',(owner,))]
        for row in rows:
            manifest=registry.verify(vault,owner,row['source_id'],json.loads(row['manifest_json']));indexes.extend(vault/ref for ref in manifest['indexes']);entry=entry or manifest['entry']
        return indexes,entry

    def deliver_results(self,owner,source,records):
        with self.lock:return self._deliver_results(owner,source,records)

    def _deliver_results(self,owner,source,records):
        row=self._row(owner,source);selection=json.loads(row['selection_json'])
        if not row['enabled'] or row['kind']!='notion' or not selection.get('writeEnabled'):return None
        with self.db() as db:known={r['item_key']:json.loads(r['metadata_json']) for r in db.execute('SELECT item_key,metadata_json FROM source_item_history WHERE owner=? AND source=?',(owner,source))}
        for value in records:
            event=value['event'];key=event.get('item',{}).get('key','').removeprefix('practice:')
            if key not in known or event.get('eventType')!='practice-attempt':continue
            occurred=datetime.fromisoformat(event['occurredAt'].replace('Z','+00:00')).astimezone();attempt=event['attempt']
            title=str(value.get('title') or known[key]['title'])[:160]
            text=f"{occurred:%H:%M} · {title}\n本次结果：{'正确' if attempt['correct'] else '需要再练'}\n练习阶段：{attempt['stageBefore']} → {attempt['stageAfter']}\n这是本次练习证据，不代表长期掌握。"
            if known[key]['url']:text+='\n原笔记：'+known[key]['url']
            with self.db() as db:existing=db.execute('SELECT parent FROM notion_result_outbox WHERE owner=? AND source=? AND event_id=?',(owner,source,event['eventId'])).fetchone()
            self.outbox.enqueue(owner,source,existing['parent'] if existing else selection['writePage'],event['eventId'],event['coreHash'],occurred.date().isoformat(),text)
        return self.outbox.deliver(owner,source,selection['writePage'],row['label'],self.client_factory(self._key(row)))
