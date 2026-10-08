"""Notion 2026-03-11 API. Explicit pages only; no arbitrary URL requests."""
from __future__ import annotations
import json
import re
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

API_VERSION='2026-03-11'
GENERATED_MARKER='zhixue-notion-results-v1'


class NotionError(ValueError):
    def __init__(self,code,*,retry_after=0,uncertain=False):
        super().__init__(code);self.retry_after=retry_after;self.uncertain=uncertain


def page_id(value):
    if not isinstance(value,str):raise NotionError('notion-invalid-page')
    raw=value.strip()
    if '://' in raw:
        url=urlsplit(raw)
        if url.scheme!='https' or not url.hostname or not (url.hostname in ('notion.so','www.notion.so','notion.site') or url.hostname.endswith('.notion.site')):raise NotionError('notion-invalid-page')
        raw=url.path.rstrip('/').split('/')[-1]
    match=re.search(r'([a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$',raw)
    if not match:raise NotionError('notion-invalid-page')
    try:return str(uuid.UUID(match[1]))
    except ValueError:raise NotionError('notion-invalid-page') from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def plain_text(rich):
    if not isinstance(rich,list):return ''
    return ''.join(str(piece.get('plain_text',piece.get('text',{}).get('content',''))) for piece in rich if isinstance(piece,dict))


class NotionClient:
    def __init__(self,token,*,transport=None,opener=None,clock=time.monotonic,sleep=time.sleep):
        if not isinstance(token,str) or not token.strip() or len(token)>512 or any(ord(c)<32 for c in token):raise NotionError('notion-key-required')
        self.token=token.strip();self.transport=transport;self.opener=opener or build_opener(_NoRedirect());self.clock=clock;self.sleep=sleep;self.last_request=None;self.deadline=self.clock()+45

    def request(self,method,path,body=None):
        if not re.fullmatch(r'/(?:pages(?:/[0-9a-f-]{36}(?:/markdown)?)?|blocks/[0-9a-f-]{36}/children)(?:\?[^\r\n]*)?',path):raise NotionError('notion-invalid-request')
        if self.transport:return self.transport(method,path,body)
        left=self.deadline-self.clock()
        if left<=0:raise NotionError('notion-timeout')
        if self.last_request is not None:
            pause=max(0,.36-(self.clock()-self.last_request))
            if pause:self.sleep(pause)
        self.last_request=self.clock()
        data=None if body is None else json.dumps(body,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        if data is not None and len(data)>450000:raise NotionError('notion-result-too-large')
        request=Request('https://api.notion.com/v1'+path,data=data,method=method,headers={'Authorization':'Bearer '+self.token,'Notion-Version':API_VERSION,'Content-Type':'application/json','Accept':'application/json'})
        try:
            with self.opener.open(request,timeout=min(15,max(1,left))) as response:
                if response.geturl()!=request.full_url:raise NotionError('notion-redirect')
                raw=response.read(2_000_001)
                if len(raw)>2_000_000:raise NotionError('notion-response-too-large')
                value=json.loads(raw.decode('utf-8'))
        except HTTPError as error:
            with error:
                status=error.code
                retry=error.headers.get('Retry-After','0') if error.headers else '0'
                delay=min(3600,int(retry)) if retry.isdigit() else 30
            code={401:'notion-unauthorized',403:'notion-permission',404:'notion-page-unavailable',409:'notion-conflict',429:'notion-rate-limit'}.get(status,'notion-unavailable' if status>=500 else 'notion-invalid-request')
            raise NotionError(code,retry_after=delay if status==429 else 0,uncertain=method!='GET' and status>=500) from None
        except (OSError,URLError,TimeoutError):raise NotionError('notion-network',uncertain=method!='GET') from None
        except (ValueError,UnicodeError) as error:
            if isinstance(error,NotionError):raise
            raise NotionError('notion-invalid-response',uncertain=method!='GET') from None
        if not isinstance(value,dict):raise NotionError('notion-invalid-response',uncertain=method!='GET')
        return value

    def read_page(self,identifier):
        identifier=page_id(identifier);metadata=self.request('GET',f'/pages/{identifier}')
        if page_id(metadata.get('id',''))!=identifier:raise NotionError('notion-incomplete-page')
        if metadata.get('in_trash') or metadata.get('archived') or metadata.get('is_archived'):raise NotionError('notion-page-unavailable')
        title='Notion 页面'
        for prop in metadata.get('properties',{}).values():
            if isinstance(prop,dict) and prop.get('type')=='title':title=plain_text(prop.get('title')) or title;break
        cache={};visiting=set();total=0
        unknown_tag=re.compile(r"<unknown\b(?:[^\"'>]|\"[^\"]*\"|'[^']*')*/?>",re.I)
        def expand(block):
            nonlocal total
            if block in visiting:raise NotionError('notion-incomplete-page')
            if block in cache:return cache[block]
            if len(cache)+len(visiting)>=30:raise NotionError('notion-incomplete-page')
            visiting.add(block);value=self.request('GET',f'/pages/{block}/markdown')
            if page_id(value.get('id',''))!=block:raise NotionError('notion-incomplete-page')
            text=value.get('markdown');unknown=value.get('unknown_block_ids',[])
            if not isinstance(text,str) or not isinstance(unknown,list) or len(unknown)>100:raise NotionError('notion-incomplete-page')
            if GENERATED_MARKER in text:raise NotionError('source-is-generated')
            identifiers={page_id(item) for item in unknown};used=set()
            if value.get('truncated') and not identifiers:raise NotionError('notion-incomplete-page')
            total+=len(text.encode('utf-8'))
            if total>2_000_000:raise NotionError('notion-response-too-large')
            def replace(match):
                from html import unescape
                from urllib.parse import unquote
                candidates={str(uuid.UUID(raw)) for raw in re.findall(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}',unquote(unescape(match[0])))} & identifiers
                if len(candidates)!=1:raise NotionError('notion-incomplete-page')
                child=candidates.pop();used.add(child);return expand(child)
            complete=unknown_tag.sub(replace,text)
            if used!=identifiers or '<unknown' in complete:raise NotionError('notion-incomplete-page')
            if len(complete.encode('utf-8'))>2_000_000:raise NotionError('notion-response-too-large')
            visiting.remove(block);cache[block]=complete;return complete
        return {'key':identifier,'title':title[:160],'markdown':expand(identifier),'url':'https://www.notion.so/'+identifier.replace('-',''),'version':metadata.get('last_edited_time','')}

    def children(self,identifier):
        identifier=page_id(identifier);result=[];cursor=None;seen=set()
        for _ in range(100):
            query={'page_size':100}
            if cursor:query['start_cursor']=cursor
            value=self.request('GET',f'/blocks/{identifier}/children?'+urlencode(query));rows=value.get('results')
            if not isinstance(rows,list) or len(rows)>100:raise NotionError('notion-incomplete-page')
            result.extend(rows)
            if not value.get('has_more'):return result
            cursor=value.get('next_cursor')
            if not isinstance(cursor,str) or not cursor or len(cursor)>1000 or cursor in seen:raise NotionError('notion-incomplete-page')
            seen.add(cursor)
        raise NotionError('notion-incomplete-page')

    def find_child_page(self,parent,title):
        found=[page_id(row['id']) for row in self.children(parent) if row.get('type')=='child_page' and row.get('child_page',{}).get('title')==title]
        if len(found)>1:raise NotionError('notion-duplicate-target')
        return found[0] if found else None

    def create_results_page(self,parent,title,marker,*,markdown=None):
        parent=page_id(parent)
        body={'parent':{'page_id':parent},'properties':{'title':{'title':[{'type':'text','text':{'content':title[:160]}}]}},
              'children':[{'object':'block','type':'paragraph','paragraph':{'rich_text':[{'type':'text','text':{'content':GENERATED_MARKER+'\n'+marker}}]}}]}
        if markdown is not None:
            if not isinstance(markdown,str) or not markdown.strip() or len(markdown)>100000:raise NotionError('notion-result-too-large')
            body.pop('children')
            body['markdown']=markdown+'\n\n---\n\n同步标识（用于防止重复保存）：\n'+GENERATED_MARKER+'\n'+marker
        value=self.request('POST','/pages',body)
        try:
            if page_id(value['parent']['page_id'])!=parent:raise ValueError('wrong-parent')
            return page_id(value['id'])
        except (ValueError,KeyError,TypeError):raise NotionError('notion-write-indeterminate',uncertain=True) from None

    def verify_results_page(self,page,marker,parent):
        page=page_id(page);parent=page_id(parent);metadata=self.request('GET',f'/pages/{page}')
        try:
            if page_id(metadata['id'])!=page or page_id(metadata['parent']['page_id'])!=parent:return False
        except (ValueError,KeyError,TypeError):return False
        if metadata.get('in_trash') or metadata.get('archived') or metadata.get('is_archived'):return False
        value=self.request('GET',f'/pages/{page_id(page)}/markdown')
        text=value.get('markdown','')
        return isinstance(text,str) and GENERATED_MARKER in text and marker in text

    def find_result(self,page,marker,expected):
        matches=[]
        for row in self.children(page):
            text=plain_text(row.get('paragraph',{}).get('rich_text')) if row.get('type')=='paragraph' else ''
            if marker in text:
                if text!=expected:raise NotionError('notion-result-conflict')
                matches.append(page_id(row['id']))
        if len(matches)>1:raise NotionError('notion-result-conflict')
        return matches[0] if matches else None

    def append_result(self,page,text):
        if not isinstance(text,str) or len(text)>1900:raise NotionError('notion-result-too-large')
        value=self.request('PATCH',f'/blocks/{page_id(page)}/children',{'children':[{'object':'block','type':'paragraph','paragraph':{'rich_text':[{'type':'text','text':{'content':text}}]}}]})
        try:return page_id(value['results'][0]['id'])
        except (ValueError,KeyError,IndexError,TypeError):raise NotionError('notion-write-indeterminate',uncertain=True) from None
