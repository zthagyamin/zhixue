"""Independent, subject-owned task evidence. Never writes learning mastery."""
from __future__ import annotations
from study_day import recorded_day_matches

import copy
import base64
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import index_gateway
import planning_catalog
from task_plan_schema import _object, _text, _strings, _hash, _integer, valid_plan_day

FIELDS = ['schemaVersion', 'eventType', 'eventId', 'coreHash', 'taskId', 'subjectId', 'day', 'occurredAt', 'unitIds', 'source', 'evidenceRefs']
EVENT_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{5,127}')


def hash_task_event(event):
    body = {key: value for key, value in event.items() if key != 'coreHash'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


def validate_task_event(value):
    event = copy.deepcopy(_object(value, FIELDS, [], 'task-event'))
    event['schemaVersion'] = _integer(event['schemaVersion'], 1, 'invalid-task-event')
    if event['schemaVersion'] != 1 or event['eventType'] != 'task-completed':
        raise ValueError('invalid-task-event')
    for key in ('eventId', 'taskId', 'subjectId', 'occurredAt'):
        _text(event[key], 'invalid-task-event')
        if any(0xD800 <= ord(character) <= 0xDFFF for character in event[key]):
            raise ValueError('invalid-task-event')
    if not EVENT_ID.fullmatch(event['eventId']) or not valid_plan_day(event['day']):
        raise ValueError('invalid-task-event')
    _hash(event['coreHash'])
    _strings(event['unitIds'], 'invalid-task-unit-ids')
    _strings(event['evidenceRefs'], 'invalid-task-evidence')
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', event['occurredAt']):
        raise ValueError('invalid-task-event-day')
    try:
        occurred = datetime.fromisoformat(event['occurredAt'].replace('Z', '+00:00'))
        if not recorded_day_matches(occurred, event['day']):
            raise ValueError('invalid-task-event-day')
    except (ValueError, OverflowError) as error:
        raise ValueError('invalid-task-event-day') from error
    if event['source'] not in ('self-report', 'evidence') or (event['source'] == 'self-report' and event['evidenceRefs']) or (event['source'] == 'evidence' and (not event['evidenceRefs'] or not event['unitIds'])):
        raise ValueError('invalid-task-evidence')
    if any(not EVENT_ID.fullmatch(ref) for ref in event['evidenceRefs']):
        raise ValueError('invalid-task-evidence')
    if hash_task_event(event) != event['coreHash']:
        raise ValueError('invalid-task-event-hash')
    return event


def read_task_events(vault_root: Path, catalog: dict, account_id: str) -> list[dict]:
    with index_gateway.LOCK:
        return _read_task_events_locked(vault_root, catalog, account_id)


def _read_task_events_locked(vault_root: Path, catalog: dict, account_id: str) -> list[dict]:
    events, roots = {}, set()
    owners = {}
    for definition in catalog.get('planningDefinitions', []):
        owners.setdefault(definition['recordsRoot'], set()).add(definition['id'])
    for definition in catalog.get('planningDefinitions', []):
        if definition['recordsRoot'] in roots:
            continue
        roots.add(definition['recordsRoot'])
        for kind, row in index_gateway.subject_records(vault_root, definition, account_id):
            if kind != 'task-event-v1':
                continue
            event = validate_task_event(row['event'])
            if row.get('subjectId') != event['subjectId'] or event['subjectId'] not in owners[definition['recordsRoot']]:
                raise ValueError('task-record-subject-mismatch')
            previous = events.get(event['eventId'])
            if previous and previous['coreHash'] != event['coreHash']:
                raise ValueError('task-event-conflict')
            events[event['eventId']] = event
    return sorted(events.values(), key=lambda event: (event['occurredAt'], event['eventId']))


def task_event_page(vault_root: Path, catalog: dict, account_id: str, after: str | None = None) -> dict:
    events = read_task_events(vault_root, catalog, account_id)
    snapshot = hashlib.sha256(json.dumps([(e['eventId'], e['coreHash']) for e in events], separators=(',', ':')).encode()).hexdigest()
    offset = 0
    if after is not None:
        try:
            if not isinstance(after, str) or len(after) > 512:
                raise ValueError('invalid-task-cursor')
            cursor = json.loads(base64.urlsafe_b64decode(after).decode('utf-8'))
            _object(cursor, ['snapshotHash', 'offset'], [], 'task-cursor')
            _hash(cursor['snapshotHash'])
            offset = _integer(cursor['offset'], 0, 'invalid-task-cursor')
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError('invalid-task-cursor') from error
        if cursor['snapshotHash'] != snapshot:
            raise ValueError('task-history-changed')
        if offset > len(events):
            raise ValueError('invalid-task-cursor')
    page = events[offset:offset + 100]
    next_offset = offset + len(page)
    cursor = base64.urlsafe_b64encode(json.dumps({'snapshotHash': snapshot, 'offset': next_offset}, separators=(',', ':')).encode()).decode() if next_offset < len(events) else None
    return {'events': page, 'nextCursor': cursor, 'snapshotHash': snapshot}


def append_task_event(vault_root: Path, catalog: dict, account_id: str, value: dict, *, validate_practice_event=None) -> dict:
    event = validate_task_event(value)
    with index_gateway.LOCK:
        previous = next((old for old in read_task_events(vault_root, catalog, account_id) if old['eventId'] == event['eventId']), None)
        if previous:
            if previous['coreHash'] != event['coreHash']:
                raise ValueError('task-event-conflict')
            return {'status': 'duplicate', 'eventId': event['eventId']}
        definition = next((d for d in catalog.get('planningDefinitions', []) if d['id'] == event['subjectId']), None)
        if not definition:
            raise ValueError('unknown-task-subject')
        planning = planning_catalog.load_planning_catalog(vault_root, catalog)
        subject = next((s for s in planning['subjects'] if s['subjectId'] == event['subjectId']), None)
        if not subject:
            raise ValueError('unknown-task-subject')
        units = {unit['unitId']: unit for unit in subject['units']}
        if any(unit not in units for unit in event['unitIds']):
            raise ValueError('unknown-task-unit')
        if event['source'] == 'self-report':
            if any(units[unit]['completionRule'] != 'self-report' for unit in event['unitIds']):
                raise ValueError('task-evidence-required')
        else:
            if not callable(validate_practice_event) or not event['unitIds']:
                raise ValueError('task-evidence-required')
            history = {row['event']['eventId']: row['event'] for row in index_gateway.progress_records(vault_root, catalog, account_id)}
            evidence = []
            for ref in event['evidenceRefs']:
                if ref not in history:
                    raise ValueError('unknown-task-evidence')
                attempt = validate_practice_event(history[ref])
                occurred = datetime.fromisoformat(attempt['occurredAt'].replace('Z', '+00:00'))
                if not recorded_day_matches(occurred, event['day']) or attempt['occurredAt'] > event['occurredAt']:
                    raise ValueError('task-evidence-day-mismatch')
                evidence.append(attempt)
            for unit_id in event['unitIds']:
                unit = units[unit_id]
                if unit['action']['kind'] != 'practice' or unit['completionRule'] not in ('three-stage', 'graded-practice'):
                    raise ValueError('invalid-task-evidence-rule')
                for key in unit['action']['itemKeys']:
                    if not any(item['eventType'] == 'practice-attempt' and item['item']['key'] == key and item['attempt']['correct']
                        and (unit['completionRule'] != 'three-stage' or item['attempt']['stageAfter'] == 3) for item in evidence):
                        raise ValueError('incomplete-task-evidence')
        root = index_gateway._records_root(vault_root, definition)
        path = (root / 'tasks' / event['day'][:4] / f'{event["day"]}.jsonl').resolve()
        if not path.is_relative_to(root):
            raise ValueError('invalid-task-record-location')
        old = path.read_bytes() if path.exists() else b''
        row = {'schemaVersion': 1, 'recordKind': 'task-event-v1', 'accountId': account_id, 'subjectId': event['subjectId'], 'event': event}
        data = old + (b'\n' if old and not old.endswith(b'\n') else b'') + (json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.task-event-', suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        return {'status': 'accepted', 'eventId': event['eventId']}
