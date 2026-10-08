"""Read-only adapters for common note exports and folders."""
from __future__ import annotations
import csv
import hashlib
import io
import json
import os
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import source_area
from companion_setup import checked_path,redirects_path
from notion_connector import GENERATED_MARKER
from practice_candidates import SUFFIX as CANDIDATE_SUFFIX, parse_candidate_document, candidate_learning_rows

SUPPORTED={'.md','.markdown','.txt','.html','.htm','.csv','.pdf'}
EXCLUDED={'.git','.obsidian','node_modules','__pycache__','_system','_archive','backups'}
GENERATED_TYPES={'paper-reading-note','paper-source-snapshot','zhixue-practice-state','zhixue-assistance-summary','learning-session','task-event'}


class SourceError(ValueError):pass


class HtmlText(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.parts=[];self.skip=0;self.rows=None;self.row=None;self.cell=None
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','iframe'):self.skip+=1;return
        if self.skip:return
        if tag=='table':self.rows=[]
        elif tag=='tr' and self.rows is not None:self.row=[]
        elif tag in ('td','th') and self.row is not None:self.cell=[]
        elif tag in ('h1','h2','h3','h4'):self.parts.append('\n'+'#'*int(tag[1])+' ')
        elif tag in ('p','div','section','article','br','details','summary'):self.parts.append('\n')
        elif tag=='li':self.parts.append('\n- ')
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe'):self.skip=max(0,self.skip-1);return
        if self.skip:return
        if tag in ('td','th') and self.cell is not None:
            self.row.append(''.join(self.cell).strip().replace('|','\\|'));self.cell=None
        elif tag=='tr' and self.rows is not None and self.row is not None:self.rows.append(self.row);self.row=None
        elif tag=='table' and self.rows is not None:
            if self.rows:
                self.parts.append('\n|'+'|'.join(self.rows[0])+'|\n|'+'|'.join('---' for _ in self.rows[0])+'|\n')
                self.parts.extend('|'+'|'.join(row)+'|\n' for row in self.rows[1:])
            self.rows=None
        elif tag in ('h1','h2','h3','h4','p','div','section','article','li','summary'):self.parts.append('\n')
    def handle_data(self,data):
        if self.skip:return
        if self.cell is not None:self.cell.append(data)
        else:self.parts.append(data)


def text_from_html(text):
    parser=HtmlText();parser.feed(text);parser.close();return ''.join(parser.parts).strip()


def _decode(raw,encoding):
    try:
        if encoding=='auto':return raw.decode('utf-16' if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8-sig')
        if encoding not in ('utf-8','utf-8-sig','utf-16','gb18030'):raise SourceError('source-invalid-encoding')
        return raw.decode(encoding)
    except UnicodeError:raise SourceError('source-invalid-encoding') from None


def _document(name,raw,encoding):
    suffix=Path(name).suffix.lower()
    if len(raw)>(20_000_000 if suffix=='.pdf' else 2_000_000):raise SourceError('source-file-too-large')
    if suffix=='.pdf':
        from pypdf import PdfReader
        try:
            reader=PdfReader(io.BytesIO(raw))
            if reader.is_encrypted or len(reader.pages)>200:raise SourceError('source-pdf-unavailable')
            text='\n\n'.join(page.extract_text() or '' for page in reader.pages)
        except SourceError:raise
        except Exception:raise SourceError('source-pdf-unavailable') from None
    else:text=_decode(raw,encoding)
    if name.lower().endswith(CANDIDATE_SUFFIX):
        try: artifact=parse_candidate_document(text)
        except (ValueError, TypeError, KeyError, UnicodeError): raise SourceError('source-candidate-invalid') from None
        version=hashlib.sha256(raw).hexdigest()
        return {'key':'candidate-document:'+version,'title':artifact['parent']['title'][:160],'markdown':'','format':'practice-candidates','url':'','version':version,'candidates':artifact}
    meta=source_area.parse_frontmatter(text.replace('\r\n','\n'))
    if meta.get('type') in GENERATED_TYPES or GENERATED_MARKER in text:return None
    if not text.strip():return None
    if suffix in ('.html','.htm'):text=text_from_html(text)
    if not text.strip():raise SourceError('source-no-extractable-text')
    notion=re.search(r'([a-fA-F0-9]{32})(?:\.[^.]+)$',name)
    key='notion-export:'+notion[1].lower()+suffix if notion else str(name).replace('\\','/').casefold()
    stable=meta.get('zhixue_id') or meta.get('id')
    if isinstance(stable,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{3,99}',stable):key='document:'+stable
    title=str(meta.get('title') or re.sub(r' [a-fA-F0-9]{32}$','',Path(name).stem))[:160]
    return {'key':key,'title':title,'markdown':text,'format':'csv' if suffix=='.csv' else 'markdown','url':'','version':hashlib.sha256(raw).hexdigest()}


def read_local_documents(path,*,encoding='auto'):
    path=Path(path).expanduser().absolute()
    if not path.exists():raise SourceError('source-path-unavailable')
    checked_path(str(path if path.is_dir() else path.parent))
    documents=[];total=0
    def add(name,raw):
        nonlocal total
        total+=len(raw)
        if total>50_000_000 or len(documents)>=500:raise SourceError('source-selection-too-large')
        doc=_document(name,raw,encoding)
        if doc:documents.append(doc)
    if path.suffix.lower()=='.zip':
        if path.stat().st_size>200_000_000:raise SourceError('source-selection-too-large')
        try:
            with zipfile.ZipFile(path) as archive:
                if len(archive.infolist())>10000:raise SourceError('source-selection-too-large')
                for info in archive.infolist():
                    relative=PurePosixPath(info.filename)
                    if relative.is_absolute() or '..' in relative.parts or '\\' in info.filename or ':' in info.filename or (info.external_attr>>16)&0o170000==0o120000:raise SourceError('source-unsafe-archive')
                    if info.is_dir() or not (relative.suffix.lower() in SUPPORTED or info.filename.lower().endswith(CANDIDATE_SUFFIX)) or any(part.startswith('.') or part.lower() in EXCLUDED for part in relative.parts):continue
                    if info.file_size>20_000_000 or info.file_size>max(1,info.compress_size)*200:raise SourceError('source-selection-too-large')
                    add(info.filename,archive.read(info))
        except (zipfile.BadZipFile,RuntimeError):raise SourceError('source-invalid-archive') from None
    elif path.is_dir():
        def unreadable(_error):raise SourceError('source-file-unavailable')
        for base,dirs,names in os.walk(path,followlinks=False,onerror=unreadable):
            dirs[:]=sorted(d for d in dirs if not d.startswith('.') and d.lower() not in EXCLUDED)
            for directory in dirs:
                if redirects_path((Path(base)/directory).lstat()):raise SourceError('source-linked-file')
            for name in sorted(names):
                file=Path(base)/name
                if name.startswith('.') or not (file.suffix.lower() in SUPPORTED or name.lower().endswith(CANDIDATE_SUFFIX)):continue
                if redirects_path(file.lstat()) or not file.resolve().is_relative_to(path.resolve()):raise SourceError('source-linked-file')
                if file.stat().st_size>20_000_000:raise SourceError('source-file-too-large')
                add(file.relative_to(path).as_posix(),file.read_bytes())
    elif path.suffix.lower() in SUPPORTED or path.name.lower().endswith(CANDIDATE_SUFFIX):
        if redirects_path(path.lstat()):raise SourceError('source-linked-file')
        if path.stat().st_size>20_000_000:raise SourceError('source-file-too-large')
        add(path.name,path.read_bytes())
    else:raise SourceError('source-unsupported-format')
    if not documents:raise SourceError('source-no-documents')
    if len({doc['key'] for doc in documents})!=len(documents):raise SourceError('source-duplicate-document')
    return documents


def _tables(document):
    if document.get('format')=='csv':
        rows=list(csv.reader(io.StringIO(document['markdown'])))
        return [(rows[0],rows[1:])] if rows else []
    return [(headers,rows) for _,headers,rows in source_area._parse_table_blocks(document['markdown'],vocabulary_gaps=True)]


def _sections(text,title):
    text=re.sub(r'^---\r?\n.*?\r?\n---\r?\n','',text,flags=re.S)
    if re.search(r'<(?:table|details|callout|column_list)\b',text):
        # Treat fenced source examples literally when converting enhanced HTML.
        protected={}
        def protect(match):
            key='ZHIXUEFENCE'+hashlib.sha256(match[0].encode()).hexdigest()
            protected[key]=match[0];return key
        text=re.sub(r'(?ms)^(`{3,}|~{3,})[^\n]*\n.*?^\1\s*$',protect,text)
        text=text_from_html(text)
        for key,value in protected.items():text=text.replace(key,value)
    heading=title;lines=[];fenced=False
    for line in text.splitlines():
        if line.strip().startswith('```'):fenced=not fenced
        match=re.match(r'^#{1,3}\s+(.+)$',line) if not fenced else None
        if match:
            if '\n'.join(lines).strip():yield heading,'\n'.join(lines).strip()
            heading=match[1].strip();lines=[]
        else:lines.append(line)
    if '\n'.join(lines).strip():yield heading,'\n'.join(lines).strip()


def learning_items(documents,source_id):
    items=[];identities={}
    def add(doc,identity,fields,material):
        key=hashlib.sha256(json.dumps([source_id,doc['key'],identity],ensure_ascii=False).encode()).hexdigest()[:24]
        value={'identity':'mapped-item:'+key,'documentKey':doc['key'],'documentTitle':doc['title'],'originalUrl':doc.get('url',''),'material':material,**fields}
        if key in identities:
            if identities[key]!=value:raise SourceError('source-ambiguous-item')
            return
        identities[key]=value;items.append(value)
        if len(items)>500:raise SourceError('source-too-many-learning-items')
    for doc in documents:
        if doc.get('format')=='practice-candidates':
            for identity,fields,material in candidate_learning_rows(doc['candidates']):
                add(doc,'candidate:'+identity,fields,material)
            continue
        parsed=False
        for headers,rows in _tables(doc):
            normalized=[re.sub(r'\s+','',cell).lower() for cell in headers]
            def column(row,*names):
                for name in names:
                    if name in normalized:
                        i=normalized.index(name)
                        if i<len(row) and row[i].strip():return row[i].strip()
                return ''
            for row in rows:
                if 'initialcode' in normalized or '初始代码' in normalized:
                    from vault_topology import _code_item
                    code=_code_item(headers,row)
                    if not code:raise SourceError('source-code-fields-required')
                    if any(len(str(value))>16000 for value in code.values()):raise SourceError('source-item-too-large')
                    identity=column(row,'id','item_id','条目id') or code['prompt']
                    material=f"# {code['topic']}\n\n{code['prompt']}\n\n```python\n{code['initialCode']}\n```\n\n参考实现（练习后核对）：\n```python\n{code['solutionCode']}\n```"
                    add(doc,'code:'+identity,code,material);parsed=True;continue
                word=column(row,'word','term','单词','单词/词组','词组','术语');meaning=column(row,'meaning','definition','释义','解释')
                if word and meaning:
                    example=column(row,'example','context','原文语境(context)','原文语境','语境','例句')
                    add(doc,'word:'+' '.join(word.casefold().split()),{'kind':'vocabulary','pluginType':'three-stage' if example else 'recall','word':word,'meaning':meaning,'context':example,'example':example},f'# {word}\n\n{meaning}\n\n{example}');parsed=True;continue
                question=column(row,'question','prompt','问题','题目','题干','front','正面');answer=column(row,'answer','答案','参考答案','back','背面')
                if question and answer:
                    identity=column(row,'id','item_id','条目id') or question
                    if len(question)>1000 or len(answer)>8000:raise SourceError('source-item-too-large')
                    add(doc,'question:'+identity,{'kind':'quiz','pluginType':'recall','prompt':question,'answer':answer,'topic':question[:160]},f'# {question}\n\n{answer}');parsed=True
        if parsed:continue
        if doc.get('format')=='csv':raise SourceError('source-csv-columns-required')
        occurrences={}
        for title,body in _sections(doc['markdown'],doc['title']):
            if not re.sub(r'[#\s*`|_-]','',body):continue
            occurrence=occurrences.get(title,0);occurrences[title]=occurrence+1
            for number,start in enumerate(range(0,len(body),6000)):
                chunk=body[start:start+6000];label=title if number==0 else f'{title}（续 {number+1}）'
                add(doc,f'section:{title}:{occurrence}:{number}',{'kind':'quiz','pluginType':'recall','prompt':f'请回忆「{label}」的主要内容，再对照原文。'[:1000],'answer':chunk,'topic':label[:160]},f'# {label}\n\n{chunk}')
    if not items:raise SourceError('source-no-learning-content')
    return items
