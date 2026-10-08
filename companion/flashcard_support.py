"""Versioned flashcards, expanded before source bindings and scheduling identities."""
import copy
import hashlib
import json
import re
JS_WHITESPACE='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

def _object(raw,keys):
    if type(raw) is not dict or set(raw)-set(keys):raise ValueError('invalid-flashcard-support')
    return raw

def _id(raw,maximum=160):
    if type(raw) is not str or not 1<=len(raw)<=maximum or not re.fullmatch(r'[a-zA-Z0-9:_.-]+',raw):raise ValueError('invalid-flashcard-id')
    return raw

def _coordinate(raw):
    if type(raw) is not str or not re.fullmatch(r'(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?',raw):raise ValueError('invalid-flashcard-mask')
    parts=raw.split('.');value=int(parts[0])*100+int((parts[1] if len(parts)>1 else '').ljust(2,'0'))
    if value>10000:raise ValueError('invalid-flashcard-mask')
    return value

def parse_flashcard_support(raw):
    mode=raw.get('mode') if type(raw) is dict else None
    v=_object(raw,['schemaVersion','type','mode','parentId']+(['direction'] if mode=='bidirectional' else ['sourceKey','sourceVersion','assetId','assetVersion','masks','activeMaskId']))
    if type(v.get('schemaVersion')) is not int or v['schemaVersion']!=1 or v.get('type')!='flashcard':raise ValueError('invalid-flashcard-support')
    if 'parentId' in v:
        parent=v['parentId']
        if type(parent) is not str or not parent or len(parent.encode('utf-16-le'))//2>200 or parent!=parent.strip(JS_WHITESPACE) or re.search(r'[\\/\x00-\x1f\x7f]',parent):raise ValueError('invalid-flashcard-parent')
    if mode=='bidirectional':
        if 'direction' in v and v['direction'] not in ('forward','reverse') or bool(v.get('parentId'))!=bool(v.get('direction')):raise ValueError('invalid-flashcard-direction')
    elif mode=='occlusion':
        for key in ('sourceKey','sourceVersion','assetVersion'):
            if type(v.get(key)) is not str or not re.fullmatch('[a-f0-9]{64}',v[key]):raise ValueError('invalid-flashcard-asset')
        _id(v.get('assetId'),80);masks=v.get('masks')
        if type(masks) is not list or not 1<=len(masks)<=24:raise ValueError('invalid-flashcard-masks')
        ids=set()
        for raw_mask in masks:
            m=_object(raw_mask,['id','x','y','width','height','answer']);key=_id(m.get('id'),64)
            if key in ids:raise ValueError('duplicate-flashcard-mask')
            ids.add(key);x,y,w,h=(_coordinate(m.get(k)) for k in ('x','y','width','height'));answer=m.get('answer')
            if w<=0 or h<=0 or x+w>10000 or y+h>10000 or type(answer) is not str or not answer.strip(JS_WHITESPACE) or len(answer.encode('utf-16-le'))//2>2000:raise ValueError('invalid-flashcard-mask')
        if bool(v.get('parentId'))!=bool(v.get('activeMaskId')) or 'activeMaskId' in v and (type(v['activeMaskId']) is not str or v['activeMaskId'] not in ids):raise ValueError('invalid-flashcard-active-mask')
    else:raise ValueError('invalid-flashcard-mode')
    return copy.deepcopy(v)

def child_id(parent,variant):
    raw=json.dumps(['flashcard-child-v1',parent,variant],ensure_ascii=False,separators=(',',':')).encode()
    return 'flashcard:'+hashlib.sha256(raw).hexdigest()

def expand_flashcard(item):
    raw=item.get('learningSupport')
    if not raw or raw.get('type')!='flashcard':return [item]
    support=parse_flashcard_support(raw)
    if support.get('parentId'):return [item]
    parent=item['itemId'];front=item.get('front') or item.get('prompt','');back=item.get('back') or item.get('answer','')
    def card(variant,prompt,answer,metadata):
        value=copy.deepcopy(item);ident=parent if variant=='forward' else child_id(parent,variant)
        value.update(id=ident,itemId=ident,abilityId=item['abilityId'] if variant=='forward' else child_id(parent, 'ability:'+item['abilityId']+':'+variant),front=prompt,prompt=prompt,back=answer,answer=answer,learningSupport={**support,'parentId':parent,**metadata})
        return value
    if support['mode']=='bidirectional':
        if type(back) is not str or not back.strip():raise ValueError('flashcard-missing-back')
        return [card('forward',front,back,{'direction':'forward'}),card('reverse',back,front,{'direction':'reverse'})]
    return [card('mask:'+mask['id'],front,mask['answer'],{'activeMaskId':mask['id']}) for mask in support['masks']]
