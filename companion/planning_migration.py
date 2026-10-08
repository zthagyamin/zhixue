"""Explicit, preview-first adoption of subject-owned planning metadata."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

import index_gateway as gateway
import planning_catalog
from managed_markdown import render_managed_block, replace_managed_block
from plan_area import PLAN_LOCK

BEGIN = '%% ZHIXUE:SUBJECT-PLANNING:BEGIN %%'
END = '%% ZHIXUE:SUBJECT-PLANNING:END %%'


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def _bytes_hash(value):
    return hashlib.sha256(value).hexdigest() if value is not None else None


def _read(path):
    return path.read_bytes() if path.exists() else None


def _definitions(vault):
    catalog = gateway.load_gateway(vault)
    if not catalog['active']:
        raise ValueError('planning-migration-requires-gateway')
    return catalog, {row['id']: row for row in catalog.get('planningDefinitions', [])}


def resolve_migration_target(vault_root: Path, relative_path: str) -> Path:
    vault = Path(vault_root).resolve(strict=True)
    if not isinstance(relative_path, str) or not relative_path or '\\' in relative_path or ':' in relative_path:
        raise ValueError('unsafe-migration-target')
    relative = Path(relative_path)
    if relative.is_absolute() or '..' in relative.parts or relative.suffix != '.md':
        raise ValueError('unsafe-migration-target')
    path = (vault / relative).resolve()
    if not path.is_relative_to(vault):
        raise ValueError('unsafe-migration-target')
    _, definitions = _definitions(vault)
    for definition in definitions.values():
        if path.is_relative_to((vault / definition['recordsRoot']).resolve()) or path == (vault / definition['progressRef']).resolve():
            raise ValueError('protected-migration-target')
    for definition in definitions.values():
        if relative_path == definition['indexRef']:
            return path
        root = (vault / definition['contentRoot']).resolve()
        records = (vault / definition['recordsRoot']).resolve()
        if path.is_relative_to(root) and not path.is_relative_to(records) and path != (vault / definition['progressRef']).resolve():
            return path
    raise ValueError('outside-registered-migration-targets')


def _set_field(text, field, value):
    if gateway._meta(text).get(field) == str(value):
        return text
    newline = '\r\n' if '\r\n' in text else '\n'
    match = re.match(r'^(\ufeff?---\r?\n)(.*?)(\r?\n---(?:\r?\n|$))', text, re.S)
    line = f'{field}: {json.dumps(value, ensure_ascii=False)}'
    if match:
        middle = match[2]
        existing = list(re.finditer(rf'(?m)^{re.escape(field)}:[^\r\n]*', middle))
        if len(existing) > 1:
            raise ValueError('ambiguous-migration-frontmatter')
        if existing:
            found = existing[0]
            middle = middle[:found.start()] + line + middle[found.end():]
        else:
            middle += newline + line
        return match[1] + middle + match[3] + text[match.end():]
    if text.lstrip('\ufeff').startswith('---'):
        raise ValueError('invalid-migration-frontmatter')
    bom = '\ufeff' if text.startswith('\ufeff') else ''
    return bom + newline.join(('---', line, '---', '')) + text.removeprefix('\ufeff')


def _planning_text(original, content):
    text = _set_field(original or '# 学科目标与学习单元\n', 'planning_schema_version', 1)
    if BEGIN in text or END in text:
        return replace_managed_block(text, BEGIN, END, content)
    newline = '\r\n' if '\r\n' in text else '\n'
    return text + (newline if text.endswith(('\r', '\n')) else newline * 2) + render_managed_block(BEGIN, END, content, newline) + newline


def _validate_shadow(vault, catalog, definitions, proposals, targets):
    """Validate with the real catalog reader, copying only registered/referenced Markdown."""
    affected = {proposal['subjectId'] for proposal in proposals if 'planningContent' in proposal}
    paths = {gateway.GATEWAY_ROOT / 'index.md'}
    for definition in definitions.values():
        paths.update(Path(definition[key]) for key in ('indexRef', 'progressRef'))
    refs = [(row['contentRef'], None) for row in catalog.get('references', [])]
    for binding in catalog.get('bindings', {}).values():
        refs += [(binding[key], None) for key in ('sourceNote', 'stateRef') if binding.get(key)]
    existing = planning_catalog.load_planning_catalog(vault, catalog)
    for subject in existing['subjects']:
        for unit in subject['units']:
            if unit['action']['kind'] == 'open-note':
                refs.append((unit['action']['contentRef'], vault / definitions[subject['subjectId']]['contentRoot']))
            if unit.get('stateRef'):
                refs.append((unit['stateRef'], vault / definitions[subject['subjectId']]['contentRoot']))
    texts = [(proposal.get('planningContent', ''), vault / definitions[proposal['subjectId']]['contentRoot']) for proposal in proposals]
    for definition in definitions.values():
        text = (vault / definition['indexRef']).read_text(encoding='utf-8')
        root = vault / definition['contentRoot']
        texts.append((text, root))
        planning_ref = gateway._meta(text).get('planning_ref')
        if planning_ref:
            refs.append((planning_ref, root))
    for text, root in texts:
        refs += [('[[%s]]' % match, root) for match in re.findall(r'\[\[([^\]]+)\]\]', text)]
        for headers, rows in planning_catalog._tables(text):
            for cells in rows:
                row = dict(zip(headers, cells))
                refs += [(row[key], root) for key in ('content_ref', 'state_ref') if row.get(key)]
    roots = [(vault / definition['contentRoot']).resolve() for definition in definitions.values()]
    for ref, relative_to in refs:
        try:
            raw, _ = gateway._link(ref)
            path = gateway._path(vault, raw, must_exist=False)
            if not path.exists() and relative_to is not None:
                path = gateway._path(vault, (relative_to.relative_to(vault) / raw).as_posix())
            if path.is_file() and path.suffix == '.md' and (any(path.is_relative_to(root) for root in roots) or path.is_relative_to(vault / gateway.GATEWAY_ROOT)):
                paths.add(path.relative_to(vault))
        except (OSError, ValueError):
            pass  # The real reader below reports unresolved references; no inferred content.
    originals = {}
    for relative in paths:
        original = gateway._path(vault, relative.as_posix())
        if original.is_file():
            originals[relative.as_posix()] = original.read_bytes()
    source_hashes = {relative: _bytes_hash(data) for relative, data in originals.items()}
    with tempfile.TemporaryDirectory(prefix='zhixue-plan-preview-') as temporary:
        shadow = Path(temporary).resolve()
        if shadow.parent != Path(tempfile.gettempdir()).resolve() or not shadow.name.startswith('zhixue-plan-preview-'):
            raise ValueError('invalid-preview-scratch')
        for relative, data in originals.items():
            destination = shadow / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        for definition in definitions.values():
            (shadow / definition['contentRoot']).mkdir(parents=True, exist_ok=True)
        for target in targets:
            path = shadow / target['relativePath']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(target['content'].encode('utf-8'))
        result = planning_catalog.load_planning_catalog(shadow, gateway.load_gateway(shadow))
        for subject_id in affected:
            subject = next((row for row in result['subjects'] if row['subjectId'] == subject_id), None)
            if not subject or subject.get('planningStatus') == 'invalid' or not (subject['units'] or subject['goals']):
                raise ValueError('invalid-planning-proposal')
        previously_valid = {row['subjectId'] for row in existing['subjects'] if row['planningStatus'] != 'invalid'}
        if any(row['subjectId'] in previously_valid and row['planningStatus'] == 'invalid' for row in result['subjects']):
            raise ValueError('invalid-planning-proposal-dependency')
    if any(_bytes_hash(_read(vault / relative)) != digest for relative, digest in source_hashes.items()):
        raise ValueError('source-changed-during-preview')
    return source_hashes


def preview_planning_migration(vault_root: Path, proposals: list[dict]) -> dict:
    vault = Path(vault_root).resolve(strict=True)
    if not isinstance(proposals, list) or not proposals or len(proposals) > 100:
        raise ValueError('invalid-planning-proposals')
    catalog, definitions = _definitions(vault)
    targets, clean, seen = [], [], set()
    for proposal in proposals:
        if not isinstance(proposal, dict) or set(proposal) - {'subjectId', 'planningPath', 'planningContent', 'language'}:
            raise ValueError('invalid-planning-proposal')
        subject_id = proposal.get('subjectId')
        if subject_id not in definitions or subject_id in seen:
            raise ValueError('unknown-or-duplicate-migration-subject')
        seen.add(subject_id)
        definition = definitions[subject_id]
        index = resolve_migration_target(vault, definition['indexRef'])
        original_index = index.read_bytes()
        index_text = original_index.decode('utf-8')
        if ('planningPath' in proposal) != ('planningContent' in proposal) or not ({'language', 'planningPath'} & proposal.keys()):
            raise ValueError('invalid-planning-proposal')
        if 'language' in proposal:
            language = proposal['language']
            if not isinstance(language, str) or not re.fullmatch(r'[a-z]{2,3}(?:-[a-z0-9]{2,8})*', language):
                raise ValueError('invalid-planning-language')
            index_text = _set_field(index_text, 'language', language)
        if 'planningPath' in proposal:
            relative, content = proposal['planningPath'], proposal['planningContent']
            if not isinstance(content, str) or not content.strip() or len(content) > 1_000_000 or BEGIN in content or END in content:
                raise ValueError('invalid-planning-content')
            path = resolve_migration_target(vault, relative)
            if not path.is_relative_to((vault / definition['contentRoot']).resolve()):
                raise ValueError('outside-migration-subject')
            owner_root = (vault / definition['contentRoot']).resolve()
            if any(other['id'] != subject_id and (vault / other['contentRoot']).resolve().is_relative_to(owner_root)
                   and path.is_relative_to((vault / other['contentRoot']).resolve()) for other in definitions.values()):
                raise ValueError('outside-migration-subject')
            before = _read(path)
            previous = (before or b'').decode('utf-8')
            planning_ref = gateway._meta(index_text).get('planning_ref')
            declared = gateway._link(planning_ref)[0] if planning_ref else ''
            if before is not None and gateway._meta(previous).get('planning_schema_version') != '1' and declared not in {relative, relative.removesuffix('.md')}:
                raise ValueError('existing-non-planning-target')
            after = _planning_text(previous, content)
            if before != after.encode('utf-8'):
                targets.append({'relativePath': relative, 'beforeHash': _bytes_hash(before), 'afterHash': _bytes_hash(after.encode('utf-8')), 'content': after})
            index_text = _set_field(index_text, 'planning_ref', f'[[{relative.removesuffix(".md")}]]')
        if index_text.encode('utf-8') != original_index:
            targets.append({'relativePath': definition['indexRef'], 'beforeHash': _bytes_hash(original_index), 'afterHash': _bytes_hash(index_text.encode('utf-8')), 'content': index_text})
        clean.append(copy.deepcopy(proposal))
    source_hashes = _validate_shadow(vault, catalog, definitions, clean, targets)
    body = {'schemaVersion': 1, 'proposals': clean, 'targets': targets, 'sourceHashes': source_hashes, 'diagnostics': []}
    return {**body, 'manifestHash': _hash(body)}


def _check_manifest(manifest):
    if not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'proposals', 'targets', 'sourceHashes', 'diagnostics', 'manifestHash'} or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1:
        raise ValueError('invalid-planning-manifest')
    if _hash({key: value for key, value in manifest.items() if key != 'manifestHash'}) != manifest['manifestHash']:
        raise ValueError('planning-manifest-integrity')


def _atomic_write(path, data):
    _atomic_file_write(path, data)


def _atomic_file_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_receipt(path, receipt):
    _atomic_file_write(path, json.dumps(receipt, ensure_ascii=False, indent=2).encode('utf-8'))


def apply_planning_migration(vault_root: Path, manifest: dict, backup_root: Path) -> dict:
    vault = Path(vault_root).resolve(strict=True)
    _check_manifest(manifest)
    with PLAN_LOCK, gateway.LOCK:
        paths = [resolve_migration_target(vault, target['relativePath']) for target in manifest['targets']]
        if all(_bytes_hash(_read(path)) == target['afterHash'] for path, target in zip(paths, manifest['targets'])):
            return {'status': 'already-applied', 'written': [], 'backupRoot': None}
        if any(_bytes_hash(_read(path)) != target['beforeHash'] for path, target in zip(paths, manifest['targets'])):
            raise ValueError('stale-migration-source')
        try:
            refreshed = preview_planning_migration(vault, manifest['proposals'])
        except (ValueError, OSError) as error:
            raise ValueError('stale-migration-source') from error
        if refreshed != manifest:
            raise ValueError('stale-migration-source')
        backup_parent = Path(backup_root).resolve()
        if backup_parent.is_relative_to(vault):
            raise ValueError('backup-must-be-outside-vault')
        backup = backup_parent / ('planning-' + uuid.uuid4().hex)
        backup.mkdir(parents=True, exist_ok=False)
        originals = [_read(path) for path in paths]
        for original, target in zip(originals, manifest['targets']):
            if original is not None:
                saved = backup / target['relativePath']
                saved.parent.mkdir(parents=True, exist_ok=True)
                saved.write_bytes(original)
        receipt = {'schemaVersion': 1, 'vaultRoot': str(vault), 'manifest': manifest, 'status': 'prepared'}
        receipt_path = backup / 'receipt.json'
        _write_receipt(receipt_path, receipt)
        written = []
        try:
            for index, (path, target) in enumerate(zip(paths, manifest['targets'])):
                if _bytes_hash(_read(path)) != target['beforeHash']:
                    raise ValueError('stale-migration-source')
                written.append(index)
                _atomic_write(path, target['content'].encode('utf-8'))
            receipt['status'] = 'applied'
            _write_receipt(receipt_path, receipt)
        except Exception:
            conflicts = []
            for index in reversed(written):
                path, target, original = paths[index], manifest['targets'][index], originals[index]
                try:
                    actual = _bytes_hash(_read(path))
                    if actual == target['beforeHash']:
                        continue
                    if actual != target['afterHash']:
                        conflicts.append(target['relativePath'])
                    else:
                        if original is None:
                            path.unlink()
                        else:
                            _atomic_write(path, original)
                except OSError:
                    conflicts.append(target['relativePath'])
            receipt.update(status='rollback-conflict' if conflicts else 'rolled-back', conflicts=conflicts)
            try:
                _write_receipt(receipt_path, receipt)
            except OSError:
                pass  # Original backup/manifest remains available even if receipt storage is unavailable.
            raise
        return {'status': 'applied', 'written': [target['relativePath'] for target in manifest['targets']], 'backupRoot': str(backup)}


def rollback_planning_migration(vault_root: Path, backup_root: Path) -> dict:
    vault, backup = Path(vault_root).resolve(strict=True), Path(backup_root).resolve(strict=True)
    receipt = json.loads((backup / 'receipt.json').read_text(encoding='utf-8'))
    if Path(receipt['vaultRoot']).resolve() != vault or receipt.get('status') not in {'applied', 'prepared', 'rollback-conflict', 'rolled-back'}:
        raise ValueError('invalid-migration-receipt')
    manifest = receipt['manifest']
    _check_manifest(manifest)
    with PLAN_LOCK, gateway.LOCK:
        pairs = [(resolve_migration_target(vault, target['relativePath']), target) for target in manifest['targets']]
        originals, initial = [], []
        previous_status = receipt['status']
        for path, target in pairs:
            current = _read(path)
            if _bytes_hash(current) not in {target['beforeHash'], target['afterHash']}:
                raise ValueError('stale-migration-source')
            initial.append(current)
            saved = (backup / target['relativePath']).resolve()
            if not saved.is_relative_to(backup):
                raise ValueError('invalid-migration-backup')
            original = saved.read_bytes() if target['beforeHash'] is not None else None
            if _bytes_hash(original) != target['beforeHash']:
                raise ValueError('migration-backup-integrity')
            originals.append(original)
        touched = []
        try:
            for index in reversed(range(len(pairs))):
                path, target = pairs[index]
                if _bytes_hash(_read(path)) != _bytes_hash(initial[index]):
                    raise ValueError('stale-migration-source')
                if _bytes_hash(initial[index]) == target['beforeHash']:
                    continue
                touched.append(index)
                if originals[index] is None:
                    path.unlink()
                else:
                    _atomic_write(path, originals[index])
            receipt['status'] = 'rolled-back'
            _write_receipt(backup / 'receipt.json', receipt)
        except Exception:
            conflicts = []
            for index in reversed(touched):
                path, target = pairs[index]
                try:
                    actual = _bytes_hash(_read(path))
                    if actual == _bytes_hash(initial[index]):
                        continue
                    if actual != target['beforeHash']:
                        conflicts.append(target['relativePath'])
                    else:
                        if initial[index] is None:
                            path.unlink(missing_ok=True)
                        else:
                            _atomic_write(path, initial[index])
                except OSError:
                    conflicts.append(target['relativePath'])
            receipt.update(status='rollback-conflict' if conflicts else previous_status, conflicts=conflicts)
            try:
                _write_receipt(backup / 'receipt.json', receipt)
            except OSError:
                pass
            raise
        return {'status': 'rolled-back', 'restored': [target['relativePath'] for _, target in pairs]}
