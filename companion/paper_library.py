"""Paper sources and explicit reading-note snapshots, separate from study events."""
from __future__ import annotations
import hashlib
import base64
import math
import io
import json
import os
import re
import sqlite3
import threading
from contextlib import closing, nullcontext
from datetime import date
from pathlib import Path
from mapped_source_registry import _safe, _atomic
from academic_vocabulary import process_lock
from notion_connector import NotionError, page_id
import index_gateway

CAPABILITY='paper-library-v1'
LOCK=threading.RLock()
EXCLUDED={'_system','_archive','backups','node_modules','__pycache__'}
GENERATED={'paper-reading-note','zhixue-practice-state','learning-session','task-event','zhixue-assistance-summary'}
MAX_BYTES=450000
class PaperOperationError(ValueError):
    def __init__(self,message,no_write=False):super().__init__(message);self.no_write=no_write
def digest(value):return hashlib.sha256(value if isinstance(value,bytes) else json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def text(value,limit,required=True):
    if not isinstance(value,str) or len(value)>limit or (required and not value.strip()) or any(ord(c)<32 and c not in '\r\n\t' for c in value):raise ValueError('paper-invalid-input')
    return value
def relative(value,*,directory=False):
    text(value,500)
    if value.startswith('/') or re.search(r'[:\\\x00-\x1f]',value) or any(p in ('','.','..') or p.startswith('.') or p.casefold() in EXCLUDED for p in value.split('/')):raise ValueError('paper-path-outside-library')
    if directory and any(c in value for c in '*?<>|'):raise ValueError('paper-invalid-directory')
    return value

class PaperLibrary:
    def __init__(self,vault,database,owner,local_library,external=None,account_library=None):
        self.vault=Path(vault);_safe(self.vault,self.vault);self.database=Path(database);self.owner=owner;self.local_library=local_library;self.external=external;self.account_library=account_library
    def _external(self,source,revision=None,write=False):
        if not self.external:raise ValueError('paper-notion-not-connected')
        row=self.external._row(self.owner,source);selection=json.loads(row['selection_json'])
        if not row['enabled'] or row['kind']!='notion':raise ValueError('paper-notion-not-connected')
        if revision is not None and revision!=row['revision']:raise ValueError('paper-source-changed')
        if write and not selection.get('writeEnabled'):raise ValueError('paper-notion-write-disabled')
        return row,selection
    def catalog(self,query=''):
        text(query,100,False);documents=[];visited=0;limited=False
        for base,dirs,names in os.walk(self.vault,followlinks=False):
            dirs[:]=[d for d in sorted(dirs) if not d.startswith('.') and d.casefold() not in EXCLUDED]
            safe_dirs=[]
            for d in dirs:
                try:_safe(self.vault,Path(base)/d);safe_dirs.append(d)
                except (ValueError,OSError):pass
            dirs[:]=safe_dirs
            for name in sorted(names):
                visited+=1
                if visited>15000 or len(documents)>=200:limited=True;break
                path=Path(base)/name;rel=path.relative_to(self.vault).as_posix()
                if name.startswith('.') or path.suffix.lower() not in ('.md','.markdown','.txt','.pdf'):continue
                if query and query.casefold() not in rel.casefold():continue
                if not query and not re.search(r'论文|研究|paper|research|arxiv',rel,re.I):continue
                try:
                    _safe(self.vault,path)
                    if path.suffix.lower()!='.pdf':
                        with path.open(encoding='utf-8-sig') as stream:head=stream.read(4096)
                        if index_gateway._meta(head).get('type') in GENERATED:continue
                    documents.append({'kind':'vault','path':rel,'title':path.stem,'format':path.suffix[1:]})
                except (ValueError,OSError,UnicodeError):continue
            if limited:break
        destinations=[{'kind':'obsidian','label':'Obsidian / 本机学习库','directory':'02 项目与研究/论文阅读笔记'}]
        if self.external:
            for source in self.external.list(self.owner):
                if source['kind']!='notion' or not source['enabled']:continue
                for i,page in enumerate(source['selection'].get('pages',[])):
                    documents.append({'kind':'notion','sourceId':source['sourceId'],'sourceRevision':source['revision'],'pageId':page,'title':f"{source['label']} · 页面 {i+1}",'url':'https://www.notion.so/'+page.replace('-','')})
                if source['selection'].get('writeEnabled'):destinations.append({'kind':'notion','sourceId':source['sourceId'],'sourceRevision':source['revision'],'label':source['label'],'url':'https://www.notion.so/'+source['selection']['writePage'].replace('-','')})
        return {'localLibraryId':self.local_library,'accountLibraryId':self.account_library,'documents':documents,'destinations':destinations,'limited':limited,'capability':CAPABILITY}
    def read(self,source):
        if not isinstance(source,dict):raise ValueError('paper-invalid-input')
        if source.get('kind')=='notion':
            row,selection=self._external(source.get('sourceId'),source.get('sourceRevision'));page=page_id(source.get('pageId'))
            if page not in selection['pages']:raise ValueError('paper-page-not-selected')
            doc=self.external.client_factory(self.external._key(row)).read_page(page)
            if len(doc['markdown'].encode())>MAX_BYTES:raise ValueError('paper-material-too-large')
            current,_=self._external(source['sourceId'],row['revision'])
            return {'title':doc['title'],'pages':[{'text':doc['markdown']}],'version':digest([doc['version'],doc['markdown']]),'origin':{'kind':'notion','sourceId':source['sourceId'],'sourceRevision':current['revision'],'pageId':page,'url':doc['url']}}
        if source.get('kind')!='vault':raise ValueError('paper-invalid-source')
        rel=relative(source.get('path'));path=_safe(self.vault,self.vault/rel)
        if not path.is_file() or path.suffix.lower() not in ('.md','.markdown','.txt','.pdf'):raise ValueError('paper-source-unavailable')
        if path.stat().st_size>20000000:raise ValueError('paper-material-too-large')
        raw=path.read_bytes();pages=[]
        if path.suffix.lower()=='.pdf':
            from pypdf import PdfReader
            try:
                reader=PdfReader(io.BytesIO(raw))
                if reader.is_encrypted or len(reader.pages)>200:raise ValueError('paper-pdf-unavailable')
                pages=[{'pageNumber':i+1,'text':page.extract_text() or ''} for i,page in enumerate(reader.pages)]
            except Exception as e:raise ValueError('paper-pdf-unavailable') from e
        else:
            decoded=raw.decode('utf-8-sig')
            if index_gateway._meta(decoded).get('type') in GENERATED:raise ValueError('paper-source-is-reading-note')
            pages=[{'text':decoded}]
        if sum(len(p['text'].encode()) for p in pages)>MAX_BYTES:raise ValueError('paper-material-too-large')
        if not any(p['text'].strip() for p in pages):raise ValueError('paper-no-extractable-text')
        result={'title':path.stem,'pages':pages,'version':digest(raw),'origin':{'kind':'vault','path':rel},**({'sourceNote':rel} if path.suffix=='.md' else {})}
        try:
            figures=self._figures(rel,result['version'])
            if figures is not None:result['figures']=[{k:v for k,v in f.items() if k!='path'} for f in figures]
        except (ValueError,OSError,UnicodeError):result['figuresStatus']='unavailable'
        return result
    def _figures(self,rel,version):
        registry=_safe(self.vault,self.vault/(relative(rel)+'.figures.json'))
        if not registry.exists():return None
        if registry.stat().st_size>350000:raise ValueError('paper-figures-unavailable')
        with registry.open('rb') as stream:raw=stream.read(350001)
        if len(raw)>350000:raise ValueError('paper-figures-unavailable')
        data=json.loads(raw)
        if not isinstance(data,dict) or data.get('schemaVersion')!=1 or data.get('sourceVersion')!=version:raise ValueError('paper-source-changed')
        figures=data.get('figures');ids=set();labels=set();result=[]
        if not isinstance(figures,list) or len(figures)>64:raise ValueError('paper-figures-unavailable')
        for figure in figures:
            if not isinstance(figure,dict) or set(figure)-{'assetId','label','title','caption','assetVersion','kind','path','page','region'}:raise ValueError('paper-figures-unavailable')
            f=dict(figure)
            for key,limit in (('assetId',80),('label',80),('title',400),('caption',4000),('assetVersion',64)):text(f.get(key),limit)
            if not re.fullmatch(r'[A-Za-z0-9_-]+',f['assetId']) or f['assetId'] in ids or f['label'].lower() in labels or not re.fullmatch(r'[a-f0-9]{64}',f['assetVersion']):raise ValueError('paper-figures-unavailable')
            ids.add(f['assetId']);labels.add(f['label'].lower())
            if f.get('kind') not in ('pdf','image'):raise ValueError('paper-figures-unavailable')
            asset=relative(f.get('path'));_safe(self.vault,self.vault/asset)
            if f['kind']=='pdf':
                if asset!=rel or not asset.lower().endswith('.pdf') or type(f.get('page')) is not int or not 1<=f['page']<=200 or f['assetVersion']!=version:raise ValueError('paper-figures-unavailable')
            elif not asset.lower().endswith(('.png','.jpg','.jpeg')) or 'page' in f:raise ValueError('paper-figures-unavailable')
            if 'region' in f:
                r=f['region']
                if not isinstance(r,dict) or set(r)!={'x','y','width','height'} or any(type(v) not in (int,float) or not math.isfinite(v) for v in r.values()) or r['x']<0 or r['y']<0 or r['width']<=0 or r['height']<=0 or r['x']+r['width']>1 or r['y']+r['height']>1:raise ValueError('paper-figures-unavailable')
            f['sourceVersion']=version;result.append(f)
        return result
    def figure(self,payload):
        self._scope(payload)
        if set(payload)-{'localLibraryId','accountLibraryId','source','sourceKey','sourceVersion','assetId','assetVersion'}:raise ValueError('paper-invalid-input')
        source=payload.get('source')
        if 'sourceKey' in payload:
            if source is not None or type(payload['sourceKey']) is not str or not re.fullmatch('[a-f0-9]{64}',payload['sourceKey']) or type(payload.get('sourceVersion')) is not str or not re.fullmatch('[a-f0-9]{64}',payload['sourceVersion']):raise ValueError('paper-invalid-input')
            source={'kind':'vault','path':self._registered_source(payload['sourceKey']),'version':payload['sourceVersion']}
        if not isinstance(source,dict) or source.get('kind')!='vault':raise ValueError('paper-figures-unavailable')
        rel=relative(source.get('path'));path=_safe(self.vault,self.vault/rel)
        if path.suffix.lower() not in ('.md','.markdown','.txt','.pdf') or path.stat().st_size>20000000:raise ValueError('paper-source-unavailable')
        with path.open('rb') as stream:source_raw=stream.read(20000001)
        if len(source_raw)>20000000 or digest(source_raw)!=source.get('version'):raise ValueError('paper-source-changed')
        figures=self._figures(rel,source['version']) or []
        f=next((f for f in figures if f['assetId']==payload.get('assetId')),None)
        if not f or f['assetVersion']!=payload.get('assetVersion'):raise ValueError('paper-figures-unavailable')
        asset=_safe(self.vault,self.vault/f['path']);limit=20000000 if f['kind']=='pdf' else 5000000
        if asset.stat().st_size>limit:raise ValueError('paper-material-too-large')
        with asset.open('rb') as stream:raw=stream.read(limit+1)
        if len(raw)>limit or digest(raw)!=f['assetVersion']:raise ValueError('paper-source-changed')
        if f['kind']=='pdf':
            from pypdf import PdfReader
            reader=PdfReader(io.BytesIO(raw))
            if reader.is_encrypted or len(reader.pages)>200 or f['page']>len(reader.pages):raise ValueError('paper-pdf-unavailable')
            mime='application/pdf'
        else:
            if raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw)>=33 and raw[12:16]==b'IHDR':
                width=int.from_bytes(raw[16:20],'big');height=int.from_bytes(raw[20:24],'big');mime='image/png'
            elif raw.startswith(b'\xff\xd8'):
                width=height=0;pos=2;mime='image/jpeg'
                while pos+4<=len(raw):
                    if raw[pos]!=255:break
                    marker=raw[pos+1];pos+=2
                    if marker in (0xD9,0xDA):break
                    length=int.from_bytes(raw[pos:pos+2],'big')
                    if length<2 or pos+length>len(raw):break
                    if marker in (0xC0,0xC1,0xC2) and length>=8:
                        height=int.from_bytes(raw[pos+3:pos+5],'big');width=int.from_bytes(raw[pos+5:pos+7],'big');break
                    pos+=length
            else:raise ValueError('paper-figures-unavailable')
            if not 0<width<=8192 or not 0<height<=8192 or width*height>12000000:raise ValueError('paper-material-too-large')
        return {'assetId':f['assetId'],'sourceVersion':source['version'],'assetVersion':f['assetVersion'],'mime':mime,'data':base64.b64encode(raw).decode('ascii')}
    def _registered_source(self,key):
        """Resolve an opaque identity only among bounded, explicitly registered sources."""
        visited=0
        for base,dirs,names in os.walk(self.vault,followlinks=False):
            safe_dirs=[]
            for name in sorted(dirs):
                if name.startswith('.') or name.casefold() in EXCLUDED:continue
                try:_safe(self.vault,Path(base)/name);safe_dirs.append(name)
                except (ValueError,OSError):pass
            dirs[:]=safe_dirs
            for name in sorted(names):
                visited+=1
                if visited>15000:raise ValueError('paper-source-unavailable')
                if name.startswith('.') or not name.endswith('.figures.json'):continue
                source=Path(base)/name[:-len('.figures.json')];rel=source.relative_to(self.vault).as_posix()
                if digest(rel.encode())==key:
                    relative(rel);_safe(self.vault,source)
                    return rel
        raise ValueError('paper-source-unavailable')
    def _scope(self,payload):
        if not isinstance(payload,dict) or payload.get('localLibraryId')!=self.local_library or (payload.get('accountLibraryId') and payload['accountLibraryId']!=self.account_library):raise ValueError('paper-library-changed')
    def _db(self):
        self.database.parent.mkdir(parents=True,exist_ok=True);db=sqlite3.connect(self.database,timeout=30);db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE IF NOT EXISTS paper_saves(owner TEXT,library TEXT,request TEXT,payload_hash TEXT,status TEXT,receipt TEXT,PRIMARY KEY(owner,library,request))');return db
    def material(self,payload):
        self._scope(payload);paper=payload.get('paper')
        if not isinstance(paper,dict):raise ValueError('paper-invalid-input')
        title=text(paper.get('title'),400);origin=paper.get('origin');current=None
        if origin and origin.get('kind') in ('vault','notion'):
            current=self.read(origin)
            if current['version']!=origin.get('version'):raise ValueError('paper-source-changed')
            if current.get('sourceNote'):return {'sourceNote':current['sourceNote'],'localLibraryId':self.local_library}
        sections=paper.get('sections')
        if not isinstance(sections,list) or not 1<=len(sections)<=50:raise ValueError('paper-invalid-input')
        paragraphs=[]
        for section in sections:
            if not isinstance(section,dict) or not isinstance(section.get('paragraphs'),list) or len(section['paragraphs'])>100:raise ValueError('paper-invalid-input')
            paragraphs.extend(text(p.get('rawEn'),5000) for p in section['paragraphs'] if isinstance(p,dict))
        raw_body='\n\n'.join(paragraphs)
        if not raw_body.strip() or len(raw_body.encode())>MAX_BYTES:raise ValueError('paper-material-too-large')
        # Keep the path short enough for Windows atomic temporary filenames.
        # Any truncated-hash collision is still rejected by the byte comparison.
        snapshot={'title':title,'origin':origin,'text':raw_body};relative_path=f'_System/Integrations/Study Loop/papers/{digest([self.owner,self.local_library])[:12]}/{digest(snapshot)[:20]}.md'
        raw=('---\ntype: paper-source-snapshot\nstatus: source\n---\n\n# '+title.replace('\n',' ')+'\n\n论文文字快照；不代表学习成绩。\n\n'+('来源：'+str((origin or {}).get('url') or (origin or {}).get('path') or (origin or {}).get('filename') or '用户导入材料')+'\n\n')+raw_body+'\n').encode()
        with LOCK,process_lock(self.vault/'_System/Locks/paper-reading.db',self.vault):
            path=_safe(self.vault,self.vault/relative_path)
            if path.exists():
                if path.read_bytes()!=raw:raise ValueError('paper-source-changed')
            else:_atomic(self.vault,path,raw,None)
        return {'sourceNote':relative_path,'localLibraryId':self.local_library}
    def save(self,payload):
        try:return self._save(payload)
        except (ValueError,OSError) as error:
            no_write=getattr(error,'no_write',False)
            if isinstance(payload,dict) and payload.get('localLibraryId')==self.local_library and str(error)!='paper-library-changed':
                if not self.database.exists():no_write=True
                else:
                    try:
                        with closing(sqlite3.connect(self.database.resolve().as_uri()+'?mode=ro',uri=True)) as db:
                            no_write=no_write or not db.execute('SELECT 1 FROM paper_saves WHERE owner=? AND library=? AND request=?',(self.owner,self.local_library,payload.get('requestId'))).fetchone()
                    except sqlite3.Error:pass
            raise PaperOperationError(str(error),no_write) from error
    def _save(self,payload):
        self._scope(payload);request=text(payload.get('requestId'),100)
        if not re.fullmatch(r'[A-Za-z0-9:-]{8,100}',request):raise ValueError('paper-invalid-input')
        title=text(payload.get('title'),400);body=text(payload.get('markdown'),100000);destination=payload.get('destination')
        if not isinstance(destination,dict) or destination.get('kind') not in ('obsidian','notion'):raise ValueError('paper-invalid-destination')
        key=(self.owner,self.local_library,request);stamp=digest(payload)
        with LOCK,process_lock(self.vault/'_System/Locks/paper-reading.db',self.vault),getattr(self.external,'lock',nullcontext()),closing(self._db()) as db:
            prior=db.execute('SELECT * FROM paper_saves WHERE owner=? AND library=? AND request=?',key).fetchone()
            if prior and prior['payload_hash']!=stamp:raise ValueError('paper-request-changed')
            if prior and prior['status']=='written':return json.loads(prior['receipt'])
            def verify_source():
                source=payload.get('source')
                if source is not None and not isinstance(source,dict):raise PaperOperationError('paper-invalid-source',True)
                if source and source.get('kind') in ('vault','notion'):
                    current=self.read(source)
                    if current['version']!=source.get('version'):raise PaperOperationError('paper-source-changed',True)
            safe_title=re.sub(r'[\x00-\x1f<>:"/\\|?*]',' ',title).strip().rstrip('.')[:60] or '论文'
            day=json.loads(prior['receipt']).get('day',date.today().isoformat()) if prior else date.today().isoformat()
            note='---\ntype: paper-reading-note\nstatus: draft\nupdated: '+day+'\n---\n\n'+body
            if destination['kind']=='obsidian':
                directory=relative(destination.get('directory'),directory=True)
                filename=f'{day} {safe_title} {digest(key)[:10]}.md';rel=directory+'/'+filename
                if os.name=='nt':
                    while len(str(self.vault/rel).encode('utf-16-le'))//2+38>250 and len(safe_title)>1:
                        safe_title=safe_title[:-1];filename=f'{day} {safe_title} {digest(key)[:10]}.md';rel=directory+'/'+filename
                    if len(str(self.vault/rel).encode('utf-16-le'))//2+38>250:raise PaperOperationError('paper-path-too-long',True)
                path=_safe(self.vault,self.vault/rel);raw=note.encode()
                if path.exists() and path.read_bytes()!=raw:raise ValueError('paper-note-edited')
                if not path.exists():verify_source()
                receipt={'requestId':request,'localLibraryId':self.local_library,'status':'written','kind':'obsidian','path':rel,'day':day}
                if not prior:db.execute('INSERT INTO paper_saves VALUES(?,?,?,?,?,?)',(*key,stamp,'pending',json.dumps(receipt)));db.commit()
                if not path.exists():_atomic(self.vault,path,raw,None)
                if _safe(self.vault,path).read_bytes()!=raw:raise ValueError('paper-readback-failed')
            else:
                row,selection=self._external(destination.get('sourceId'),destination.get('sourceRevision'),write=True);client=self.external.client_factory(self.external._key(row));parent=selection['writePage'];marker='zx-paper-'+digest([key,stamp]);page_title=f'{safe_title} · 阅读笔记 · {digest(key)[:10]}'
                found=client.find_child_page(parent,page_title)
                if found:
                    if not client.verify_results_page(found,marker,parent):raise ValueError('paper-notion-note-conflict')
                else:
                    if prior and prior['status']=='creating':raise ValueError('paper-notion-write-uncertain')
                    verify_source()
                    _,current_selection=self._external(destination.get('sourceId'),row['revision'],write=True)
                    if current_selection.get('writePage')!=parent:raise ValueError('paper-source-changed')
                    if not prior:db.execute('INSERT INTO paper_saves VALUES(?,?,?,?,?,?)',(*key,stamp,'creating','{}'))
                    else:db.execute("UPDATE paper_saves SET status='creating' WHERE owner=? AND library=? AND request=?",key)
                    db.commit()
                    try:found=client.create_results_page(parent,page_title,marker,markdown=body)
                    except NotionError as error:
                        if not error.uncertain:db.execute("UPDATE paper_saves SET status='pending' WHERE owner=? AND library=? AND request=?",key);db.commit()
                        raise
                    if not client.verify_results_page(found,marker,parent):raise ValueError('paper-notion-write-uncertain')
                receipt={'requestId':request,'localLibraryId':self.local_library,'status':'written','kind':'notion','url':'https://www.notion.so/'+found.replace('-','')}
            db.execute("UPDATE paper_saves SET status='written',receipt=? WHERE owner=? AND library=? AND request=?",(json.dumps(receipt,ensure_ascii=False),*key));db.commit();return receipt
