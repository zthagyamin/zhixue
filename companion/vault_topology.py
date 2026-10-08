"""Advisory bounded topology and explicitly confirmed, read-only content mappings.
Rules live in local metadata, never in formal learning state. No code is executed.
"""
from __future__ import annotations
from contextlib import closing
import fnmatch
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path, PurePosixPath
import source_area

MAX_SAMPLE = 50
MAX_FILE_BYTES = 1_500_000

def _digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()

def _diagnostic(diagnostics, code, relative):
    if diagnostics is not None and len(diagnostics)<100:
        diagnostics.append({'code':code,'path':relative,'message':'资料无法读取，已跳过；请检查文件编码或读取权限。'})

def _read_document(path, relative, diagnostics):
    try: return path.read_text(encoding='utf-8-sig')
    except UnicodeError: _diagnostic(diagnostics,'mapping-invalid-encoding',relative)
    except OSError: _diagnostic(diagnostics,'mapping-unreadable-file',relative)
    return None

def files(root, diagnostics=None):
    root=Path(root).resolve(strict=True)
    if not root.is_dir(): raise ValueError('vault-root-unavailable')
    def walk_error(error):
        path=Path(error.filename) if error.filename else root
        relative=path.relative_to(root).as_posix() if path.is_relative_to(root) else '.'
        _diagnostic(diagnostics,'mapping-unreadable-directory',relative)
    for base, directories, names in os.walk(root,followlinks=False,onerror=walk_error):
        safe=[]
        for name in sorted(directories):
            path=Path(base)/name
            try:
                if not name.startswith('.') and name!='_System' and not path.is_symlink() and not getattr(path,'is_junction',lambda:False)() and path.resolve().is_relative_to(root): safe.append(name)
            except OSError: _diagnostic(diagnostics,'mapping-unreadable-directory',path.relative_to(root).as_posix())
        directories[:]=safe
        for name in sorted(names):
            path=Path(base)/name
            if path.suffix.lower()!='.md': continue
            relative=path.relative_to(root).as_posix()
            try:
                if not path.is_symlink() and path.resolve().is_relative_to(root) and path.stat().st_size<=MAX_FILE_BYTES: yield path,relative
            except OSError: _diagnostic(diagnostics,'mapping-unreadable-file',relative)

def validate(rules):
    if not isinstance(rules,list) or len(rules)>100: raise ValueError('invalid-mapping-rules')
    result=[]
    for raw in rules:
        if not isinstance(raw,dict): raise ValueError('invalid-mapping-rule')
        if set(raw)-{'pathGlob','subjectId','subjectLabel','contentKind','splitMode','headingLevel'}: raise ValueError('unknown-mapping-field')
        rule=dict(raw)
        glob=rule.get('pathGlob','')
        if not isinstance(glob,str) or not glob or len(glob)>300 or '\\' in glob or ':' in glob or glob.startswith('/') or '..' in glob.split('/'): raise ValueError('invalid-mapping-path')
        if not re.fullmatch(r'mapped:[a-zA-Z0-9_-]{1,80}',str(rule.get('subjectId',''))): raise ValueError('invalid-mapping-subject')
        if not isinstance(rule.get('subjectLabel'),str) or not rule['subjectLabel'].strip() or len(rule['subjectLabel'])>120: raise ValueError('invalid-mapping-label')
        if rule.get('contentKind') not in ('vocabulary','quiz','code') or rule.get('splitMode') not in ('heading','table','callout'): raise ValueError('invalid-mapping-mode')
        if rule['contentKind']=='code' and rule['splitMode']!='table': raise ValueError('code-requires-table-schema')
        level=rule.get('headingLevel',2)
        if type(level)!=int or not 1<=level<=6: raise ValueError('invalid-heading-level')
        rule['headingLevel']=level; result.append(rule)
    kinds={}
    for rule in result:
        prior=kinds.setdefault(rule['subjectId'],rule['contentKind'])
        if prior!=rule['contentKind']: raise ValueError('mixed-subject-content-kind')
    return result

def inspect(root):
    samples=[]; shapes=set(); suggestions=[]; diagnostics=[]
    for path,rel in files(root,diagnostics):
        if len(samples)==MAX_SAMPLE: break
        samples.append(rel)
        text=_read_document(path,rel,diagnostics)
        if text is None: continue
        meta=source_area.parse_frontmatter(text)
        parts=PurePosixPath(rel).parts
        if len(parts)>1: shapes.add('folder')
        if parts[0].lower() in ('projects','areas','resources','archives'): shapes.add('para')
        if meta.get('subject') or meta.get('course_id'): shapes.add('metadata')
        if re.search(r'^## ',text,re.M): shapes.add('headings')
        label=str(meta.get('subject') or meta.get('course_id') or (parts[-2] if len(parts)>1 else Path(rel).stem))
        kind='code' if 'initialCode' in text or '初始代码' in text else 'vocabulary' if re.search(r'\|\s*(word|单词)',text) else 'quiz'
        mode='table' if re.search(r'^\s*\|',text,re.M) else 'callout' if '> [!' in text else 'heading'
        rule=dict(pathGlob=rel,subjectId='mapped:'+_digest([label,kind])[:16],subjectLabel=label,contentKind=kind,splitMode=mode,headingLevel=2)
        suggestions.append(rule)
    ambiguous=len(shapes)>1
    return dict(sampledFiles=len(samples),sampleLimit=MAX_SAMPLE,shapes=sorted(shapes),confidence=0.55 if ambiguous else 0.8 if suggestions else 0,ambiguous=ambiguous,active=False,suggestions=suggestions,diagnostics=diagnostics)

def _matches(rel,glob):
    def match(parts,pattern):
        if not pattern: return not parts
        if pattern[0]=='**': return match(parts,pattern[1:]) or (bool(parts) and match(parts[1:],pattern))
        return bool(parts) and fnmatch.fnmatchcase(parts[0],pattern[0]) and match(parts[1:],pattern[1:])
    return match(rel.split('/'),glob.split('/'))

def _heading_blocks(text, level):
    blocks=[]; title=None; body=[]; fence=None
    for line in text.splitlines():
        marker=re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$',line)
        if fence:
            if title is not None: body.append(line)
            if marker and marker[1][0]==fence[0] and len(marker[1])>=len(fence) and not marker[2].strip(): fence=None
            continue
        if marker:
            fence=marker[1]
            if title is not None: body.append(line)
            continue
        heading=re.match(r'^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$',line)
        if heading and len(heading[1])<=level:
            if title is not None: blocks.append((title,'\n'.join(body)))
            title=heading[2] if len(heading[1])==level else None
            body=[]
        elif title is not None: body.append(line)
    if title is not None: blocks.append((title,'\n'.join(body)))
    return blocks

def _code_item(headers, cells):
    """Mapped code needs content, not an invented original mastery reference.

    JSON string cells unambiguously preserve literal backslashes and newlines;
    legacy plain cells retain the existing escaped-newline convention.
    """
    def col(*names):
        return next((cells[headers.index(name)] for name in names if name in headers and headers.index(name)<len(cells)), '')
    prompt = col('题干','问题','prompt')
    def code(*names):
        value = col(*names)
        if value.startswith('"'):
            try: decoded = json.loads(value)
            except ValueError: return value.replace('\\n','\n')
            if type(decoded) is str: return decoded
        return value.replace('\\n','\n')
    initial, tests = code('初始代码','initialCode'), code('测试代码','testCode')
    if not prompt or not initial or not tests: return None
    return dict(kind='code', pluginType='code', domain='python', prompt=prompt,
                topic=col('主题','topic') or prompt[:40], initialCode=initial, testCode=tests,
                solutionCode=code('参考代码','solutionCode'), explanation=col('解析','explanation'))


def extract(root,rules,*,diagnostics=None):
    rules=validate(rules)
    if not rules: return []
    items=[]; seen=set()
    for path,rel in files(root,diagnostics):
        for rule in rules:
            if not _matches(rel,rule['pathGlob']): continue
            text=_read_document(path,rel,diagnostics)
            if text is None: break
            meta=source_area.parse_frontmatter(text)
            if str(meta.get('status','')).lower()=='inactive': continue
            candidates=[]
            if rule['splitMode']=='table':
                parser={'vocabulary':source_area._vocabulary_item,'quiz':source_area._quiz_item,'code':_code_item}[rule['contentKind']]
                for _,headers,rows in source_area._parse_table_blocks(text):
                    candidates.extend(item for cells in rows if (item:=parser(headers,cells)))
            else:
                if rule['splitMode']=='heading':
                    blocks=_heading_blocks(text,rule['headingLevel'])
                else:
                    blocks=[]
                    for match in re.finditer(r'^>\s*\[![^\]]+\][+-]?\s*(.*)\n((?:>.*(?:\n|$))*)',text,re.M):
                        blocks.append((match[1],re.sub(r'^>\s?','',match[2],flags=re.M)))
                for title,body in blocks:
                    if not title.strip() or not body.strip(): continue
                    if rule['contentKind']=='vocabulary': candidates.append(dict(kind='vocabulary',word=title.strip(),meaning=body.strip(),example='',context=''))
                    else: candidates.append(dict(kind='quiz',topic=title.strip(),prompt=title.strip(),answer=body.strip()))
            occurrences={}
            for item in candidates:
                if item['kind']=='quiz':
                    item['explanation']='\n\n'.join(dict.fromkeys(str(value).strip() for value in (item.get('answer'),item.get('explanation')) if value and str(value).strip()))
                label=item.get('word') or item.get('prompt',''); ordinal=occurrences.get(label,0); occurrences[label]=ordinal+1
                identity='mapped-item:'+_digest([rel,rule['subjectId'],label,ordinal])[:24]
                if identity in seen: continue
                seen.add(identity)
                # A path is provenance only, not evidence of an ability or mastered state.
                item.update(id=identity,itemId=identity,abilityId=identity,sourceNote=rel,sourceFile=rel,subjectId=rule['subjectId'],subjectLabel=rule['subjectLabel'],generated=meta.get('generated')=='true')
                item.pop('stateRef',None)
                item['contentHash']=source_area.content_hash(item); items.append(item)
            break # first confirmed rule wins; overlapping rules never duplicate a source
    return items

def _key(root,owner): return _digest([str(Path(root).resolve()),owner])
def load(db_path,root,owner):
    if not owner or not Path(db_path).exists(): return dict(revision=0,rules=[])
    with closing(sqlite3.connect(db_path)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_mapping'").fetchone():
            return dict(revision=0,rules=[])
        row=db.execute('SELECT revision,rules FROM vault_mapping WHERE identity=?',(_key(root,owner),)).fetchone()
    return dict(revision=row[0],rules=json.loads(row[1])) if row else dict(revision=0,rules=[])

def save(db_path,root,owner,rules,revision):
    if not owner: raise ValueError('mapping-owner-required')
    rules=validate(rules)
    if type(revision)!=int or revision<0: raise ValueError('invalid-mapping-revision')
    with closing(sqlite3.connect(db_path)) as db:
        db.execute('CREATE TABLE IF NOT EXISTS vault_mapping(identity TEXT PRIMARY KEY,revision INTEGER NOT NULL,rules TEXT NOT NULL)')
        db.execute('BEGIN IMMEDIATE')
        key=_key(root,owner); row=db.execute('SELECT revision FROM vault_mapping WHERE identity=?',(key,)).fetchone()
        if (row[0] if row else 0)!=revision: raise ValueError('stale-mapping')
        db.execute('INSERT INTO vault_mapping VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET revision=excluded.revision,rules=excluded.rules',(key,revision+1,json.dumps(rules)))
        db.commit()
    return dict(revision=revision+1,rules=rules)

def merge(payload,root,db_path,owner):
    rules=load(db_path,root,owner)['rules']
    if not rules: return payload
    subjects=list(payload.get('subjects',[])); by_id={s['id']:s for s in subjects}
    diagnostics=[]
    for item in extract(root,rules,diagnostics=diagnostics):
        sid=item['subjectId']
        if sid not in by_id:
            subject=dict(id=sid,name=item['subjectLabel'],pluginType={'quiz':'recall','code':'code','vocabulary':'three-stage'}[item['kind']],domain={'code':'python','quiz':'course','vocabulary':'ielts'}[item['kind']],items=[])
            by_id[sid]=subject; subjects.append(subject)
        elif not sid.startswith('mapped:'): continue
        subject=by_id[sid]
        if not any(row.get('id')==item['id'] for row in subject['items']): subject['items'].append(item)
    return {**payload,'subjects':subjects,'mappingDiagnostics':diagnostics,'diagnostics':[*payload.get('diagnostics',[]),*diagnostics]}
