"""Immutable source carriers, atomically selected by a source manifest."""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path
from mapped_source_registry import _safe, _atomic

ROOT=Path('_System/Integrations/Study Loop/external')
MARKER='zhixue-external-source-v1'


def sha(raw):return hashlib.sha256(raw).hexdigest()
def encoded(value):return (json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode('utf-8')


def _immutable(vault,path,raw):
    _safe(vault,path)
    if path.exists():
        if path.read_bytes()!=raw:raise ValueError('source-generated-file-conflict')
        return
    _atomic(vault,path,raw,None)
    if path.read_bytes()!=raw:raise ValueError('source-write-readback')


def verify(vault,owner,source,manifest):
    vault=Path(vault).resolve()
    if not manifest or any(manifest.get(k)!=v for k,v in {'marker':MARKER,'owner':owner,'source':source,'vault':str(vault)}.items()):raise ValueError('source-manifest-conflict')
    scope=ROOT/owner[:12]/source.replace('-','')[:12]
    for ref,digest in manifest['files'].items():
        path=_safe(vault,vault/ref)
        if not path.is_relative_to(vault/scope) or not path.is_file() or sha(path.read_bytes())!=digest:raise ValueError('source-generated-file-conflict')
    for ref,identity in manifest.get('states',{}).items():
        import index_gateway
        path=_safe(vault,vault/ref)
        if not path.is_relative_to(vault/scope) or not path.is_file():raise ValueError('source-state-unavailable')
        meta=index_gateway._meta(path.read_text(encoding='utf-8-sig'))
        if meta.get('type')!='zhixue-practice-state' or meta.get('external_namespace')!=identity:raise ValueError('source-state-conflict')
    return manifest


def publish(vault,owner,source,documents,items,label,language='',previous=None):
    if not re.fullmatch('[a-f0-9]{64}',owner) or not re.fullmatch('[a-f0-9-]{36}',source):raise ValueError('source-identity-invalid')
    vault=Path(vault).resolve()
    if previous:verify(vault,owner,source,previous)
    scope=ROOT/owner[:12]/source.replace('-','')[:12];files={};states={};indexes=[];item_map={}
    def put(relative,raw):
        _immutable(vault,vault/relative,raw);files[relative.as_posix()]=sha(raw)
    put(scope/'owner.json',encoded({'marker':MARKER,'owner':owner,'source':source}))
    entry=scope/'gateway.md';put(entry,b'---\ntype: zhixue-gateway\nschema_version: 1\nenabled: true\n---\n')
    for doc in documents:
        raw=doc['markdown'].encode('utf-8');name=sha(doc['key'].encode())[:16]+'-'+sha(raw)[:16]+'.md'
        put(scope/'documents'/name,raw)
    grouped={}
    for item in items:grouped.setdefault(item['kind'],[]).append(item)
    for kind,rows in grouped.items():
        folder=scope/kind;subject='mapped:ext-'+source.replace('-','')[:20]+'-'+kind
        state=folder/'state.md';identity=sha(encoded([owner,source,kind]));states[state.as_posix()]=identity
        state_path=_safe(vault,vault/state)
        if not state_path.exists():_immutable(vault,state_path,f'---\ntype: zhixue-practice-state\nexternal_namespace: {identity}\n---\n# 学习记录\n'.encode('utf-8'))
        import index_gateway
        if index_gateway._meta(state_path.read_text(encoding='utf-8-sig')).get('external_namespace')!=identity:raise ValueError('source-state-conflict')
        refs=[]
        for item in rows:
            identity=item['identity'];short=identity.split(':',1)[1];raw=(item['material']+'\n').encode('utf-8');material=folder/f'{short}-m-{sha(raw)[:16]}.md';put(material,raw)
            fields={k:item[k] for k in ('kind','pluginType','word','meaning','context','example','prompt','answer','topic','initialCode','testCode','solutionCode','explanation') if k in item}
            row={**fields,'id':identity,'itemId':identity,'abilityId':identity,'sourceNote':material.as_posix(),'mappedSourceHash':sha(raw)}
            carrier_raw=b'---\ntype: zhixue-mapped-source\n---\n```mapped-json\n'+encoded([row]).rstrip()+b'\n```\n'
            carrier=folder/f'{short}-c-{sha(carrier_raw)[:16]}.md';put(carrier,carrier_raw);refs.append(carrier.as_posix())
            item_map[identity]={'subjectId':subject,'documentKey':item['documentKey'],'title':item.get('word') or item.get('topic') or item['documentTitle'],'url':item['originalUrl']}
        fields={'type':'zhixue-subject-index','schema_version':1,'subject_id':subject,'name':label if len(grouped)==1 else label+({'vocabulary':' · 词汇','code':' · Python'}.get(kind,' · 回忆')),
                'domain':{'vocabulary':'ielts','code':'python'}.get(kind,'course'),'plugin':{'vocabulary':'three-stage','code':'code'}.get(kind,'recall'),'content_root':folder.as_posix(),
                'progress_ref':state.as_posix(),'records_root':(folder/'records').as_posix(),'identity':'scoped','enabled':'true','auto':'false','language':language}
        raw=('---\n'+''.join(f'{key}: {json.dumps(str(value),ensure_ascii=False)}\n' for key,value in fields.items())+'---\n| id | content_ref | format |\n|---|---|---|\n'+''.join(f'| external | [[{ref}]] | mapped-json |\n' for ref in refs)).encode('utf-8')
        index=folder/f'index-{sha(raw)[:16]}.md';put(index,raw);indexes.append(index.as_posix())
    manifest={'marker':MARKER,'owner':owner,'source':source,'vault':str(vault),'entry':entry.as_posix(),'indexes':indexes,'files':files,'states':states,'items':item_map}
    return verify(vault,owner,source,manifest)
