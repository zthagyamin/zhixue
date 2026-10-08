"""Local-only planning observations bound to immutable V3 events."""
from __future__ import annotations
from study_day import study_day, source_review_due_at

import copy
import base64
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import index_gateway
import plan_area
import planning_catalog
import task_events
from task_plan_schema import _object, _text, _hash, _strings, _integer, valid_plan_day, CAPABILITY

_SNAPSHOTS = {}


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def seal(value, event):
    result = {**copy.deepcopy(value or {}), 'schemaVersion': 1, 'eventId': event['eventId'], 'coreHash': event['coreHash']}
    result.pop('evidenceHash', None)
    result['evidenceHash'] = _digest(result)
    return result


def review_state(card):
    day = card.get('reviewDate', '')
    return {'enabled': bool(card.get('reviewEnabled')), 'dueAt': source_review_due_at(f'{day}T00:00:00+08:00') if valid_plan_day(day) else None}


def validate_evidence(value, event):
    evidence = copy.deepcopy(_object(value, ['schemaVersion', 'eventId', 'coreHash', 'evidenceHash'], ['word', 'itemSource', 'beforeReview', 'afterReview'], 'planning-evidence'))
    if evidence['schemaVersion'] != 1 or type(evidence['schemaVersion']) is not int or evidence['eventId'] != event['eventId'] or evidence['coreHash'] != event['coreHash']:
        raise ValueError('planning-evidence-event-mismatch')
    _hash(evidence['evidenceHash'])
    if 'itemSource' in evidence:
        source = _object(evidence['itemSource'], ['itemKey', 'subjectId', 'sourceHash'], [], 'practice-source-identity')
        _text(source['itemKey'], 'invalid-practice-source-identity')
        _text(source['subjectId'], 'invalid-practice-source-identity')
        _hash(source['sourceHash'])
        if source['itemKey'] != event['item']['key']:
            raise ValueError('planning-source-event-mismatch')
    if 'word' in evidence:
        word = _object(evidence['word'], ['itemKey', 'subjectId', 'word', 'language', 'sourceHash', 'completionRule'], ['legacyKeys'], 'word-identity')
        for key in ('itemKey', 'subjectId', 'word'):
            _text(word[key], 'invalid-word-identity')
        if not isinstance(word['language'], str):
            raise ValueError('invalid-word-identity')
        _hash(word['sourceHash'])
        if word['completionRule'] not in ('three-stage', 'graded-practice'):
            raise ValueError('invalid-word-identity-rule')
        _strings(word.get('legacyKeys', []), 'invalid-word-alias')
        if event['item']['key'] not in [word['itemKey'], *word.get('legacyKeys', [])]:
            raise ValueError('planning-word-event-mismatch')
    for key in ('beforeReview', 'afterReview'):
        if key in evidence:
            state = _object(evidence[key], ['enabled', 'dueAt'], [], 'source-review-state')
            if type(state['enabled']) is not bool:
                raise ValueError('invalid-source-review-state')
            if state['dueAt'] is not None:
                if not isinstance(state['dueAt'], str) or datetime.fromisoformat(state['dueAt'].replace('Z', '+00:00')).tzinfo is None:
                    raise ValueError('invalid-source-review-date')
    if seal(evidence, event)['evidenceHash'] != evidence['evidenceHash']:
        raise ValueError('invalid-planning-evidence-hash')
    return evidence


def observe_before(vault, catalog, binding, event):
    value = {}
    subject = next((s for s in catalog.get('subjects', []) if s['id'] == binding['subjectId']), None)
    definition = next((d for d in catalog.get('planningDefinitions', []) if d['id'] == binding['subjectId']), None)
    item = next((item for item in subject['items'] if item['itemId'] == binding['itemId']), None) if subject else None
    if item and item.get('word') and definition:
        meta = index_gateway._meta(index_gateway._read(index_gateway._path(vault, definition['indexRef'])))
        language = str(meta.get('language') or ('en' if subject.get('identity') == 'legacy' else '')).strip()
        word = {'itemKey': item['abilityId'], 'subjectId': binding['subjectId'], 'word': item['word'], 'language': language,
                'sourceHash': binding['signature'], 'completionRule': 'three-stage' if subject['pluginType'] == 'three-stage' else 'graded-practice'}
        if subject.get('identity') == 'legacy':
            word['legacyKeys'] = sorted({f'word:{item["word"].strip()}', f'word:{item["word"].strip().lower()}'} - {word['itemKey']})
        value['word'] = word
    elif item:
        value['itemSource'] = {'itemKey': event['item']['key'], 'subjectId': binding['subjectId'], 'sourceHash': binding['signature']}
    card = next((card for card in catalog.get('resultCards', []) if card['itemId'] == binding['itemId'] and card['subjectId'] == binding['subjectId']), None)
    if card:
        value['beforeReview'] = review_state(card)
    return validate_evidence(seal(value, event), event)


def with_after(state, evidence, event):
    return validate_evidence(seal({**(evidence or {}), 'afterReview': copy.deepcopy(state)}, event), event)


def merge_evidence(left, right, event):
    if left is None:
        return validate_evidence(right, event)
    if right is None:
        return validate_evidence(left, event)
    left, right = validate_evidence(left, event), validate_evidence(right, event)
    before = lambda value: {key: item for key, item in value.items() if key not in ('afterReview', 'evidenceHash')}
    if before(left) != before(right) or ('afterReview' in left and 'afterReview' in right and left['afterReview'] != right['afterReview']):
        raise ValueError('conflicting-planning-evidence')
    result = {**left, **right}
    if 'afterReview' in left:
        result['afterReview'] = left['afterReview']
    return seal(result, event)


def update_record(vault, binding, account_id, event, evidence):
    """Append the successful writeback observation, preserving all other line bytes."""
    with index_gateway.LOCK:
        path = index_gateway.subject_event_path(vault, binding, event)
        original = path.read_bytes();lines = original.splitlines(keepends=True);found = False
        for index, line in enumerate(lines):
            if not line.strip():
                continue
            row = json.loads(line.decode('utf-8-sig'))
            if row.get('accountId') == account_id and row.get('event', {}).get('eventId') == event['eventId'] and row.get('recordKind', 'study-event-v3') == 'study-event-v3':
                row['planningEvidence'] = merge_evidence(row.get('planningEvidence'), evidence, event)
                newline = b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
                lines[index] = json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + newline
                found = True
        if not found:
            raise ValueError('missing-planning-event-record')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.planning-evidence-', suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name);handle.write(b''.join(lines));handle.flush();os.fsync(handle.fileno())
            if path.read_bytes() != original:
                raise ValueError('stale-subject-record')
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        return path


def _history_stamp(vault, catalog):
    roots, files = {}, []
    for definition in catalog.get('planningDefinitions', []):
        roots.setdefault(definition['recordsRoot'], []).append(definition['id'])
    for root_ref in sorted(roots):
        definition = next(d for d in catalog['planningDefinitions'] if d['recordsRoot'] == root_ref)
        root = index_gateway._records_root(vault, definition)
        if root.exists():
            for path in sorted(root.rglob('*.jsonl')):
                resolved = path.resolve()
                if not resolved.is_relative_to(root):
                    raise ValueError('invalid-planning-record-location')
                stat = resolved.stat()
                files.append([resolved.as_posix(), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns])
    return _digest({'roots': roots, 'files': files})


def _record_snapshot(vault, catalog, account_id, validate_event):
    key = (str(Path(vault).resolve()), account_id, id(validate_event))
    stamp = _history_stamp(vault, catalog)
    cached = _SNAPSHOTS.get(key)
    if cached and cached['stamp'] == stamp:
        return cached
    records = _read_records(vault, catalog, account_id, validate_event)
    if _history_stamp(vault, catalog) != stamp:
        raise ValueError('planning-history-changed')
    snapshot = {'stamp': stamp, 'records': records, 'hash': _digest([[r['event']['eventId'], r['event']['coreHash'], r['subjectId'],
                  r.get('planningEvidence', {}).get('evidenceHash')] for r in records])}
    if key not in _SNAPSHOTS and len(_SNAPSHOTS) >= 4:
        _SNAPSHOTS.pop(next(iter(_SNAPSHOTS)))
    _SNAPSHOTS[key] = snapshot
    return snapshot


def read_records(vault, catalog, account_id, validate_event):
    with index_gateway.LOCK:
        return copy.deepcopy(_record_snapshot(vault, catalog, account_id, validate_event)['records'])


def _read_records(vault, catalog, account_id, validate_event):
    with index_gateway.LOCK:
        records, owners, definitions = {}, {}, {}
        for definition in catalog.get('planningDefinitions', []):
            root = definition['recordsRoot'];definitions[root] = definition
            owners.setdefault(root, set()).add(definition['id'])
        for root, definition in definitions.items():
            for kind, row in index_gateway.subject_records(vault, definition, account_id):
                if kind != 'study-event-v3':
                    continue
                event = validate_event(row['event'])
                if row.get('subjectId') not in owners[root]:
                    raise ValueError('planning-record-subject-mismatch')
                record = {'event': event, 'subjectId': row['subjectId']}
                if row.get('planningEvidence') is not None:
                    record['planningEvidence'] = validate_evidence(row['planningEvidence'], event)
                    if record['planningEvidence'].get('word', {}).get('subjectId', row['subjectId']) != row['subjectId']:
                        raise ValueError('planning-word-subject-mismatch')
                    if record['planningEvidence'].get('itemSource', {}).get('subjectId', row['subjectId']) != row['subjectId']:
                        raise ValueError('planning-source-subject-mismatch')
                old = records.get(event['eventId'])
                if old:
                    if old['event']['coreHash'] != event['coreHash'] or old['subjectId'] != record['subjectId']:
                        raise ValueError('planning-record-conflict')
                    if old.get('planningEvidence') or record.get('planningEvidence'):
                        record['planningEvidence'] = merge_evidence(old.get('planningEvidence'), record.get('planningEvidence'), event)
                records[event['eventId']] = record
        return sorted(records.values(), key=lambda record: (record['event']['occurredAt'], record['event']['eventId']))


def evidence_page(vault, catalog, account_id, validate_event, *, source_hash, plan_revision, after=None):
    _hash(source_hash);plan_revision = _integer(plan_revision, 0, 'invalid-plan-revision')
    with index_gateway.LOCK:
        stored = _record_snapshot(vault, catalog, account_id, validate_event)
        snapshot = _digest([source_hash, plan_revision, stored['hash']])
        offset = 0
        if after is not None:
            try:
                if not isinstance(after, str) or len(after) > 512:
                    raise ValueError('invalid-planning-cursor')
                cursor = json.loads(base64.urlsafe_b64decode(after).decode('utf-8'))
                _object(cursor, ['snapshotHash', 'offset'], [], 'planning-cursor');_hash(cursor['snapshotHash'])
                offset = _integer(cursor['offset'], 0, 'invalid-planning-cursor')
            except (ValueError, TypeError, UnicodeError) as error:
                raise ValueError('invalid-planning-cursor') from error
            if cursor['snapshotHash'] != snapshot:
                raise ValueError('planning-history-changed')
        records = stored['records']
        if offset > len(records):
            raise ValueError('invalid-planning-cursor')
        page = copy.deepcopy(records[offset:offset + 100]);following = offset + len(page)
        cursor = base64.urlsafe_b64encode(json.dumps({'snapshotHash': snapshot, 'offset': following}, separators=(',', ':')).encode()).decode() if following < len(records) else None
        return {'records': page, 'snapshotHash': snapshot, 'nextCursor': cursor, 'sourceHash': source_hash, 'planRevision': plan_revision}


def _capture_demands(vault, gateway):
    demands = []
    for record in plan_area.read_revisions(plan_area.plan_area_root(vault)):
        item = record.get('reviewItem')
        if not isinstance(item, dict) or record.get('decision') != 'applied':
            continue
        observed = record.get('appliedAt')
        if not isinstance(observed, str):
            raise ValueError('invalid-capture-observation')
        timestamp = datetime.fromisoformat(observed.replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            raise ValueError('invalid-capture-observation')
        day = item.get('due') if valid_plan_day(item.get('due')) else study_day(timestamp).isoformat()
        before_ids = {task['taskId'] for task in (record.get('before') or {}).get('tasks', [])}
        added = [task for task in record.get('after', {}).get('tasks', []) if task.get('category') == 'review'
                 and task.get('taskId', '').startswith('capture:') and task['taskId'] not in before_ids]
        if len(added) > 1:
            raise ValueError('ambiguous-capture-observation')
        task = added[0] if added else None
        binding = index_gateway.lookup_binding(gateway, str(item.get('itemId', '')))
        if binding and binding['abilityId'] != item.get('abilityId'):
            binding = None
        key = task['action']['itemKeys'][0] if task else next((key for key, value in gateway.get('bindings', {}).items() if value is binding), 'unmapped:' + _digest([item.get('itemId'), item.get('abilityId')]))
        demand = {'roundId': task['reviewRoundId'] if task else 'capture:' + _digest([record.get('captureId'), record['revision'], item.get('itemId'), observed]),
                  'itemKey': key, 'subjectId': task['subjectId'] if task else binding['subjectId'] if binding else 'unmapped', 'dueAt': source_review_due_at(f'{day}T00:00:00+08:00'),
                  'observedAt': timestamp.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                  'completionRule': task['completionRule'] if task else 'graded-practice'}
        if not binding:
            demand['blockedReason'] = '捕获的复习来源尚未登记或已经移除，请核对学习索引。'
        demands.append(demand)
    return demands


def verify_catalog_snapshot(vault, gateway, catalog, *, catalog_loader=None):
    fresh = (catalog_loader or index_gateway.load_gateway)(vault)
    if _digest(fresh) != _digest(gateway) or planning_catalog.load_planning_catalog(vault, fresh)['sourceHash'] != catalog['sourceHash']:
        raise ValueError('planning-source-changed')


def _plan_stamp(vault):
    paths = [Path(vault) / plan_area.plan_authority.PLAN_RELATIVE_PATH, plan_area.plan_area_root(vault) / plan_area.REVISIONS_FILE]
    return [(path.as_posix(), (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) if (stat := path.stat() if path.exists() else None) else None) for path in paths]


def build_context(vault, gateway, account_id, validate_event, *, catalog_loader=None):
    # Same lock order as website plan apply: plan authority, then subject journals.
    with plan_area.PLAN_LOCK, index_gateway.LOCK:
        gateway = (catalog_loader or index_gateway.load_gateway)(vault)
        if not gateway['active']:
            raise ValueError('planning-source-changed')
        plan_stamp = _plan_stamp(vault)
        revision = plan_area.current_revision(plan_area.plan_area_root(vault))
        catalog = planning_catalog.load_planning_catalog(vault, gateway)
        history = _record_snapshot(vault, gateway, account_id, validate_event)
        records = history['records']
        reports = task_events.read_task_events(vault, gateway, account_id)
        completed_units = {unit for report in reports if report['source'] == 'self-report' for unit in report['unitIds']}
        completed_items = {row['event']['item']['key'] for row in records if row['event']['eventType'] == 'practice-attempt'
                           and row['event']['attempt']['correct'] and row['event']['attempt']['stageAfter'] == 3}
        latest = {}
        for subject_id, occurred in [(row['subjectId'], row['event']['occurredAt']) for row in records if row['event']['eventType'] == 'practice-attempt'] + [(report['subjectId'], report['occurredAt']) for report in reports]:
            latest[subject_id] = max(latest.get(subject_id, ''), occurred)
        for subject in catalog['subjects']:
            if subject['subjectId'] in latest:
                subject['lastProgressAt'] = latest[subject['subjectId']]
            for unit in subject['units']:
                unit['taskComplete'] = (unit['completionRule'] == 'self-report' and unit['unitId'] in completed_units) or (unit['completionRule'] in ('three-stage', 'graded-practice') and unit['action']['kind'] == 'practice'
                    and all(key in completed_items for key in unit['action']['itemKeys']))
        sources = []
        for card in gateway.get('resultCards', []):
            key = f'practice:{card["itemId"]}'
            binding = index_gateway.lookup_binding(gateway, key)
            if binding:
                sources.append({'itemKey': key, 'subjectId': binding['subjectId'], 'completionRule': 'graded-practice',
                                'sourceHash': binding['signature'], 'state': review_state(card)})
        captures = _capture_demands(vault, gateway)
        verify_catalog_snapshot(vault, gateway, catalog, catalog_loader=catalog_loader)
        if _history_stamp(vault, gateway) != history['stamp'] or _plan_stamp(vault) != plan_stamp:
            raise ValueError('planning-history-changed')
        return {'catalog': catalog, 'sourceReviews': sources, 'captureReviews': captures,
                'observedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                'planRevision': revision, 'capabilities': [CAPABILITY]}
