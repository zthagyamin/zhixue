"""Confirmed mappings backed by isolated practice files; originals are read-only."""
from __future__ import annotations
import hashlib
import json
import os
import stat
import sqlite3
import uuid
from pathlib import Path
import index_gateway as gateway
import vault_topology as topology
from companion_setup import redirects_path

ROOT = Path('_System/Integrations/Study Loop/mapped')
MARKER = 'zhixue-mapped-derived-v1'

def _hash(raw): return hashlib.sha256(raw).hexdigest()
def _json(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode('utf-8')

def _safe(vault, path):
    """Reject every reparse ancestor, including links back inside this vault."""
    path = Path(path)
    if not path.is_relative_to(vault): raise ValueError('mapping-outside-owned-root')
    for part in (vault, *reversed(path.parents[:len(path.parts)-len(vault.parts)-1]), path):
        if part.exists() or part.is_symlink():
            attributes = part.lstat()
            if redirects_path(attributes):
                raise ValueError('mapping-reparse-path')
    if path.resolve() != path: raise ValueError('mapping-noncanonical-path')
    return path

def _atomic(vault, path, raw, expected):
    _safe(vault, path)
    if (path.read_bytes() if path.exists() else None) != expected: raise ValueError('mapping-edit-conflict')
    path.parent.mkdir(parents=True, exist_ok=True)
    _safe(vault, path)
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        _safe(vault, temp)
        with temp.open('xb') as handle: handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        _safe(vault, path)
        if (path.read_bytes() if path.exists() else None) != expected: raise ValueError('mapping-edit-conflict')
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()

def _register(vault, owner, rules):
    diagnostics = []
    originals = {rel: path.read_bytes() for path, rel in topology.files(vault, diagnostics)
                 if any(topology._matches(rel, rule['pathGlob']) for rule in rules)}
    items = topology.extract(vault, rules, diagnostics=diagnostics)
    if originals != {rel: path.read_bytes() for path, rel in topology.files(vault, diagnostics)
                     if any(topology._matches(rel, rule['pathGlob']) for rule in rules)}:
        raise ValueError('mapping-source-changed')
    identity = {'owner': owner, 'vault': str(vault)}
    scope = ROOT / topology._digest(identity)[:24]
    manifest_path = _safe(vault, vault / scope / 'manifest.json')
    previous = manifest_path.read_bytes() if manifest_path.exists() else None
    if previous is None and not items:
        return [], diagnostics
    manifest = json.loads(previous) if previous else {'marker': MARKER, **identity, 'files': {}, 'subjects': {}}
    if any(manifest.get(key) != value for key, value in {'marker': MARKER, **identity}.items()):
        raise ValueError('mapping-namespace-collision')
    old_files = manifest['files']
    for ref, digest in old_files.items():
        path = _safe(vault, vault / ref)
        if not path.is_relative_to(vault / scope) or not path.is_file() or _hash(path.read_bytes()) != digest:
            raise ValueError('mapping-derived-edit-conflict')
    desired = {}; indexes = []; states = {}; subjects = dict(manifest['subjects'])
    for ref in old_files:
        if Path(ref).name == 'index.md':
            # Empty subjects retain their journal roots for historical evidence.
            desired[ref] = b'\n'.join(line for line in (vault/ref).read_bytes().split(b'\n') if not line.startswith(b'| mapped |'))
            indexes.append(vault/ref)
    grouped = {}
    for item in items: grouped.setdefault(item['subjectId'], []).append(item)
    for sid, rows in sorted(grouped.items()):
        folder = scope / topology._digest(sid)[:24]
        token = folder.name
        if token in subjects and subjects[token] != sid: raise ValueError('mapping-subject-collision')
        subjects[token] = sid
        state_ref = (folder / 'state.md').as_posix()
        state_path = _safe(vault, vault / state_ref)
        state_identity = topology._digest([identity, sid])
        if state_path.exists():
            meta = gateway._meta(gateway._read(state_path))
            if meta.get('type') != 'zhixue-practice-state' or meta.get('mapped_namespace') != state_identity:
                raise ValueError('mapping-state-collision')
        else:
            states[state_ref] = f'---\ntype: zhixue-practice-state\nmapped_namespace: {state_identity}\n---\n# Independent practice records\n'.encode()
        carrier = (folder / 'content.md').as_posix()
        content = []
        for original in rows:
            item = {key: value for key, value in original.items() if key in ITEM_FIELDS}
            item['pluginType'] = {'quiz': 'recall', 'code': 'code', 'vocabulary': 'three-stage'}[item['kind']]
            if item['kind'] == 'quiz' and item.get('options'):
                item['pluginType'] = 'quiz'
            source = _safe(vault, vault / item['sourceNote'])
            item['mappedSourceHash'] = _hash(originals[item['sourceNote']])
            content.append(item)
        desired[carrier] = b'---\ntype: zhixue-mapped-content\nstatus: ready\ngenerated: true\n---\n```mapped-json\n' + _json(content) + b'\n```\n'
        index_ref = (folder / 'index.md').as_posix()
        if vault/index_ref not in indexes: indexes.append(vault/index_ref)
        kind = rows[0]['kind']; plugin = {'quiz':'recall','code':'code','vocabulary':'three-stage'}[kind]
        fields = {'type':'zhixue-subject-index', 'schema_version':1, 'subject_id':sid, 'name':rows[0]['subjectLabel'],
                  'domain':{'quiz':'course','code':'python','vocabulary':'ielts'}[kind], 'plugin':plugin,
                  'content_root':folder.as_posix(), 'progress_ref':state_ref, 'records_root':(folder/'records').as_posix(),
                  'identity':'scoped', 'enabled':'true', 'auto':'false', 'language':'en', 'generated_marker':MARKER}
        desired[index_ref] = ('---\n' + ''.join(f'{key}: {json.dumps(str(value), ensure_ascii=False)}\n' for key,value in fields.items()) +
                              f'---\n| id | content_ref | format |\n|---|---|---|\n| mapped | {carrier} | mapped-json |\n').encode()
    entry_ref = (scope / 'gateway.md').as_posix()
    desired[entry_ref] = b'---\ntype: zhixue-gateway\nschema_version: 1\n---\n'
    # Retired content remains preserved but is never passed as an active index.
    files = {**old_files, **{ref:_hash(raw) for ref,raw in desired.items()}}
    next_manifest = _json({'marker':MARKER, **identity, 'files':files, 'subjects':subjects})
    mutations = []
    for ref, raw in {**states, **desired}.items():
        path = _safe(vault, vault/ref); old = path.read_bytes() if path.exists() else None
        if old is not None and ref not in old_files: raise ValueError('mapping-foreign-file')
        if old != raw: mutations.append((path, raw, old))
    # Publish index files after all content and states; the lock keeps readers atomic.
    mutations.sort(key=lambda row: row[0].name == 'index.md')
    if next_manifest != previous: mutations.append((manifest_path, next_manifest, previous))
    applied = []
    try:
        for ref, raw in originals.items():
            if _safe(vault, vault/ref).read_bytes() != raw: raise ValueError('mapping-source-changed')
        for path, raw, old in mutations:
            _atomic(vault, path, raw, old); applied.append((path, raw, old))
    except Exception:
        for path, raw, old in reversed(applied):
            _safe(vault, path)
            if path.read_bytes() != raw: continue
            if old is None: path.unlink()
            else: _atomic(vault, path, old, raw)
        raise
    return indexes, diagnostics

ITEM_FIELDS = {'id','itemId','abilityId','kind','word','meaning','example','context','phonetic','source','level',
               'distractors','options','topic','prompt','answer','explanation','initialCode','testCode','solutionCode','sourceNote'}

def parse_items(vault, text, subject):
    import re
    match = re.fullmatch(r'---\r?\n.*?\r?\n---\r?\n```mapped-json\r?\n(.*)\r?\n```\r?\n', text, re.S)
    if not match: raise ValueError('invalid-mapped-content')
    rows = json.loads(match[1])
    if type(rows) is not list or not rows: raise ValueError('invalid-mapped-content')
    for item in rows:
        if type(item) is not dict or set(item) - ITEM_FIELDS - {'pluginType','mappedSourceHash'}: raise ValueError('invalid-mapped-item')
        if any((type(value) is not list or any(type(part) is not str for part in value)) if key in ('distractors','options') else type(value) is not str
               for key,value in item.items()): raise ValueError('invalid-mapped-field')
        if any(not re.fullmatch(r'mapped-item:[a-f0-9]{24}', str(item.get(key,''))) for key in ('id','itemId','abilityId')):
            raise ValueError('invalid-mapped-identity')
        if item.get('pluginType') not in ('quiz','recall','code','three-stage'): raise ValueError('invalid-mapped-plugin')
        if item['pluginType'] == 'quiz' and (len(item.get('options', [])) < 2 or item.get('answer') not in item['options']):
            raise ValueError('invalid-mapped-quiz')
        if item.get('kind') not in ('quiz','code','vocabulary'): raise ValueError('invalid-mapped-kind')
        source = _safe(vault, vault / item['sourceNote'])
        if _hash(source.read_bytes()) != item.pop('mappedSourceHash'): raise ValueError('mapping-source-changed')
    return rows

def load_catalog(vault_root, db_path, owner, refresh=False, *, extra_indexes=(), extra_entry_ref=None):
    vault = Path(vault_root).resolve()
    with gateway.LOCK:
        diagnostics = []; indexes = []
        try:
            saved = topology.load(db_path, vault, owner)
            if saved['revision']:
                indexes, diagnostics = _register(vault, owner, saved['rules'])
        except (ValueError, OSError, KeyError, sqlite3.Error) as error:
            diagnostics.append({'code':str(error), 'message':'映射资料登记未完成，请检查来源或生成文件冲突。', 'reference':ROOT.as_posix(), 'path':ROOT.as_posix()})
        entry_ref = None
        if indexes and not (vault/gateway.GATEWAY_ROOT).exists():
            scope = ROOT / topology._digest({'owner':owner, 'vault':str(vault)})[:24]
            entry_ref = (scope/'gateway.md').as_posix()
        if not entry_ref and extra_indexes and not (vault/gateway.GATEWAY_ROOT).exists():entry_ref=extra_entry_ref
        catalog = gateway.load_gateway(vault, refresh=refresh, extra_subject_indexes=[*indexes,*extra_indexes], entry_ref=entry_ref)
        catalog['mappingDiagnostics'] = [*diagnostics, *[row for row in catalog['diagnostics']
            if str(row.get('reference','')).startswith(ROOT.as_posix() + '/')]]
        catalog['diagnostics'].extend(diagnostics)
        return catalog
