"""Portable account-study v1 contract. Pure: no config, keyring, server or I/O.

The original V3/TaskV1 core is immutable. New causal associations are signed
separately; accepting an envelope never means its learning state is applicable.
Shared TypeScript-generated vectors pin the cross-runtime representation.
"""
from __future__ import annotations
from study_day import recorded_day_matches

import copy
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone

SCHEDULER_VERSION = 'ts-fsrs-5.4.1-default-v1'
SAFE_INTEGER = 9007199254740991
JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def _canonical(value, depth=0):
    if depth > 64:
        raise ValueError('study-json-too-deep')
    if value is None or type(value) in (str, bool):
        return value
    if type(value) in (int, float) and abs(value) <= SAFE_INTEGER and math.isfinite(value) and value == int(value):
        return int(value)
    if type(value) is list:
        return [_canonical(child, depth + 1) for child in value]
    if type(value) is dict and all(type(key) is str for key in value):
        return {key: _canonical(child, depth + 1) for key, child in value.items()}
    raise ValueError('non-canonical-json-value')


def canonical_json(value):
    text = json.dumps(_canonical(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    # JSON.stringify escapes lone UTF-16 surrogates. Valid portable text rejects
    # them, but old core strings must retain their original hash representation.
    return ''.join(f'\\u{ord(c):04x}' if 0xD800 <= ord(c) <= 0xDFFF else c for c in text)


def study_hash(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def study_object(value, required, optional=()):
    if type(value) is not dict:
        raise ValueError('invalid-study-object')
    if set(value) - set(required) - set(optional):
        raise ValueError('unknown-study-field')
    if set(required) - set(value):
        raise ValueError('missing-study-field')
    return value


def study_text(value, label='text', maximum=4000, empty=False):
    if type(value) is not str or (not empty and not value.strip(JS_WHITESPACE)):
        raise ValueError(f'invalid-{label}')
    if len(value.encode('utf-16-le', errors='surrogatepass')) // 2 > maximum:
        raise ValueError(f'too-long-{label}')
    if any((ord(c) < 32 and c not in '\t\n\r') or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError(f'invalid-{label}')
    return value


def study_id(value, label='identifier'):
    study_text(value, label, 200)
    if value != value.strip(JS_WHITESPACE) or '/' in value or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f'invalid-{label}')
    return value


def study_digest(value):
    if type(value) is not str or not re.fullmatch('[a-f0-9]{64}', value):
        raise ValueError('invalid-study-hash')
    return value


def study_count(value, label='count', minimum=0):
    if type(value) not in (int, float) or not minimum <= value <= SAFE_INTEGER or not math.isfinite(value) or value != int(value):
        raise ValueError(f'invalid-{label}')
    return int(value)


def study_iso(value, extended=False):
    pattern = r'([+-][0-9]{6}|[0-9]{4})' if extended else r'([0-9]{4})'
    match = re.fullmatch(pattern + r'-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z', value) if type(value) is str else None
    if not match:
        raise ValueError('invalid-study-time')
    year, month, day, hour, minute, second, _ = map(int, match.groups())
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if (not 1 <= month <= 12 or not 1 <= day <= days[month - 1] or hour > 23 or minute > 59 or second > 59
            or (len(match[1]) > 4 and 0 <= year <= 9999)):
        raise ValueError('invalid-study-time')
    if year < -271821 or year > 275760 or (year == -271821 and value[7:] < '-04-20T00:00:00.000Z') or (year == 275760 and value[7:] > '-09-13T00:00:00.000Z'):
        raise ValueError('invalid-study-time')
    return value


def study_size(value, maximum):
    if len(canonical_json(value).encode('utf-8')) > maximum:
        raise ValueError('study-payload-too-large')


def _strings(value, label, maximum, minimum=0):
    if type(value) is not list or not minimum <= len(value) <= maximum:
        raise ValueError(f'invalid-{label}')
    for child in value:
        study_text(child, label)


def _item_body(raw, has_hash):
    common = ['schemaVersion', 'kind', 'itemKey', 'eventKind', 'subjectId', 'title', 'sourceHash', 'completionRule']
    obj = study_object(raw, common, ['word', 'language', 'recommendedPlugin', 'practice', 'learningSupport'] + (['contentHash'] if has_hash else []))
    if study_count(obj['schemaVersion'], 'version') not in (1,2) or obj['schemaVersion']==2 and 'learningSupport' not in obj:
        raise ValueError('unsupported-study-version')
    if obj['schemaVersion']==1 and 'learningSupport' in obj:raise ValueError('unknown-study-field')
    for key in ('itemKey', 'subjectId'):
        study_id(obj[key], key)
    study_text(obj['title'], 'title'); study_digest(obj['sourceHash'])
    if obj['eventKind'] not in ('word', 'python', 'due'):
        raise ValueError('invalid-event-kind')
    if has_hash:
        study_digest(obj.get('contentHash'))
    if obj['kind'] == 'word':
        if 'practice' in obj:
            raise ValueError('unknown-study-field')
        if obj['eventKind'] != 'word' or obj['completionRule'] not in ('three-stage', 'graded-practice'):
            raise ValueError('invalid-word-rule')
        if obj.get('recommendedPlugin') not in ('three-stage', 'recall', 'flashcard', 'spelling'):
            raise ValueError('invalid-word-plugin')
        study_text(obj.get('language'), 'language', 64)
        if not re.fullmatch(r'[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*', obj['language']):
            raise ValueError('invalid-language')
        word = study_object(obj.get('word'), ['word', 'phonetic', 'meaning', 'context', 'example', 'source', 'level', 'distractors'])
        for key in ('word', 'meaning'):
            study_text(word[key], key)
        for key in ('phonetic', 'context', 'example', 'source', 'level'):
            study_text(word[key], key, empty=True)
        _strings(word['distractors'], 'distractors', 32)
        rule = 'three-stage' if obj['recommendedPlugin'] == 'three-stage' and word['example'].strip(JS_WHITESPACE) else 'graded-practice'
        if obj['completionRule'] != rule:
            raise ValueError('invalid-word-rule')
    elif obj['kind'] == 'practice':
        if 'word' in obj or 'language' in obj or 'recommendedPlugin' in obj:
            raise ValueError('unknown-study-field')
        if obj['completionRule'] != 'graded-practice':
            raise ValueError('invalid-practice-rule')
        practice = study_object(obj.get('practice'), ['itemId', 'abilityId', 'domain', 'questionType', 'prompt', 'sourceLabel'],
                                ['options', 'answer', 'explanation', 'reviewPoint', 'initialCode', 'testCode', 'solutionCode'])
        for key in ('itemId', 'abilityId', 'domain'):
            study_id(practice[key], key)
        study_text(practice['prompt'], 'prompt', 32000); study_text(practice['sourceLabel'], 'source-label')
        kind = practice['questionType']
        if kind not in ('quiz', 'recall', 'calculation', 'code', 'flashcard'):
            raise ValueError('invalid-question-type')
        for key in ('explanation', 'reviewPoint', 'initialCode', 'testCode', 'solutionCode'):
            if key in practice:
                study_text(practice[key], key, 32000, True)
        if 'options' in practice:
            _strings(practice['options'], 'options', 32, 2)
        if kind == 'quiz':
            if obj['schemaVersion']==2 and type(obj.get('learningSupport')) is dict and obj['learningSupport'].get('type')=='quiz':
                if 'options' in practice or 'answer' in practice:raise ValueError('duplicate-quiz-answer-source')
            else:
                _strings(practice.get('options'), 'options', 32, 2)
                if study_count(practice.get('answer'), 'answer') >= len(practice['options']):
                    raise ValueError('invalid-answer')
        else:
            if 'options' in practice:
                raise ValueError('invalid-practice-options')
            if 'answer' in practice:
                study_text(practice['answer'], 'answer', 32000, True)
        structured_code = obj['schemaVersion'] == 2 and isinstance(obj.get('learningSupport'), dict) and obj['learningSupport'].get('type') == 'code'
        code_fields = ('initialCode',) if structured_code else ('initialCode', 'testCode')
        if kind == 'code' and any(not isinstance(practice.get(key), str) or not practice[key].strip(JS_WHITESPACE) for key in code_fields):
            raise ValueError('incomplete-code-item')
        support=obj.get('learningSupport')
        course_recall=kind=='recall' and type(support) is dict and support.get('schemaVersion')==2 and support.get('type')=='recall'
        if course_recall and any(key in practice for key in ('answer','explanation','reviewPoint')):
            raise ValueError('duplicate-course-reference')
        if not course_recall and kind in ('recall', 'calculation', 'flashcard') and not any(type(practice.get(key)) is str and practice[key].strip(JS_WHITESPACE) for key in ('answer', 'explanation', 'reviewPoint')):
            raise ValueError('missing-reference-material')
    else:
        raise ValueError('invalid-study-item-kind')
    if obj['schemaVersion']==2:
        from learning_support import parse_learning_support
        support=parse_learning_support(obj['learningSupport'],obj.get('recommendedPlugin') if obj['kind']=='word' else obj['practice']['questionType'])
        if obj['kind']=='word' and support['schemaVersion']==2:raise ValueError('course-task-word')
        if support['type']=='spelling' and (obj['kind']!='word' or support['word']!=obj['word']['word']):raise ValueError('spelling-mapping-mismatch')
        if support['type']=='flashcard' and (obj['kind']!='practice' or not support.get('parentId')):raise ValueError('flashcard-expansion-required')
    study_size(obj, 64 * 1024)
    return copy.deepcopy({key: value for key, value in obj.items() if key != 'contentHash'})


def seal_item(raw):
    body = _item_body(raw, False)
    item = {**body, 'contentHash': study_hash(body)}
    study_size(item, 64 * 1024)
    return item


def validate_item(raw):
    body = _item_body(raw, True)
    if study_hash(body) != raw['contentHash']:
        raise ValueError('study-item-integrity')
    return {**body, 'contentHash': raw['contentHash']}


def _snapshot_body(raw, has_hash):
    obj = study_object(raw, ['schemaVersion', 'libraryId', 'snapshotId', 'revision', 'generatedAt', 'sourceHash', 'eventCursor', 'taskCursor', 'items'], ['snapshotHash'] if has_hash else [])
    if study_count(obj['schemaVersion'], 'version') != 1:
        raise ValueError('unsupported-study-version')
    study_id(obj['libraryId'], 'library'); study_id(obj['snapshotId'], 'snapshot')
    study_count(obj['revision'], 'revision', 1)
    study_count(obj['eventCursor'], 'event-cursor'); study_count(obj['taskCursor'], 'task-cursor')
    study_iso(obj['generatedAt']); study_digest(obj['sourceHash'])
    if has_hash:
        study_digest(obj.get('snapshotHash'))
    if type(obj['items']) is not list or len(obj['items']) > 10000:
        raise ValueError('invalid-snapshot-items')
    seen = set()
    for item in obj['items']:
        study_object(item, ['itemKey', 'contentHash']); study_id(item['itemKey'], 'item-key'); study_digest(item['contentHash'])
        if item['itemKey'] in seen:
            raise ValueError('duplicate-snapshot-item')
        seen.add(item['itemKey'])
    study_size(obj, 2 * 1024 * 1024)
    return copy.deepcopy({key: value for key, value in obj.items() if key != 'snapshotHash'})


def seal_snapshot(raw):
    body = _snapshot_body(raw, False)
    snapshot = {**body, 'snapshotHash': study_hash(body)}
    study_size(snapshot, 2 * 1024 * 1024)
    return snapshot


def validate_snapshot(raw):
    body = _snapshot_body(raw, True)
    if study_hash(body) != raw['snapshotHash']:
        raise ValueError('study-snapshot-integrity')
    return {**body, 'snapshotHash': raw['snapshotHash']}


def validate_bundle(raw):
    study_object(raw, ['snapshot', 'items']); study_size(raw, 8 * 1024 * 1024)
    snapshot = validate_snapshot(raw['snapshot'])
    if type(raw['items']) is not list or len(raw['items']) != len(snapshot['items']):
        raise ValueError('incomplete-study-bundle')
    by_key = {}
    members = {item['itemKey']: item['contentHash'] for item in snapshot['items']}
    for raw_item in raw['items']:
        item = validate_item(raw_item)
        if item['itemKey'] in by_key:
            raise ValueError('duplicate-bundle-item')
        if members.get(item['itemKey']) != item['contentHash']:
            raise ValueError('study-bundle-membership')
        by_key[item['itemKey']] = item
    return {'snapshot': snapshot, 'items': [by_key[item['itemKey']] for item in snapshot['items']]}


def _old_string(value, maximum=None):
    if type(value) is not str or (maximum is not None and len(value) > maximum):
        raise ValueError('invalid-study-event-v3')


def _practice_core(raw):
    study_size(raw, 32 * 1024)
    study_object(raw, ['schemaVersion', 'eventId', 'coreHash', 'occurredAt', 'domain', 'eventType', 'item', 'attempt'], ['scheduling'])
    if study_count(raw['schemaVersion']) != 3 or raw['eventType'] != 'practice-attempt':
        raise ValueError('study-record-requires-attempt')
    _old_string(raw['eventId'], 200); study_digest(raw['coreHash']); study_iso(raw['occurredAt'], extended=True)
    if raw['domain'] not in ('ielts', 'python', 'differential-review'):
        raise ValueError('invalid-study-event-v3')
    item = study_object(raw['item'], ['kind', 'key'], ['stateHandle'])
    if item['kind'] not in ('word', 'python', 'due'):
        raise ValueError('invalid-study-event-v3')
    _old_string(item['key'], 200)
    if 'stateHandle' in item:
        _old_string(item['stateHandle'])
    attempt = study_object(raw['attempt'], ['rating', 'correct', 'stageBefore', 'stageAfter'])
    if attempt['rating'] not in ('again', 'hard', 'good', 'easy') or type(attempt['correct']) is not bool:
        raise ValueError('invalid-study-event-v3')
    for key in ('stageBefore', 'stageAfter'):
        if study_count(attempt[key]) > 3:
            raise ValueError('invalid-study-stage')
    if 'scheduling' in raw:
        scheduling = study_object(raw['scheduling'], ['reviewedAt', 'schedulerVersion'])
        study_iso(scheduling['reviewedAt'], extended=True)
        if scheduling['schedulerVersion'] != SCHEDULER_VERSION:
            raise ValueError('invalid-study-event-v3')
    if study_hash({key: value for key, value in raw.items() if key != 'coreHash'}) != raw['coreHash']:
        raise ValueError('invalid-study-event-core-hash')


def _task_core(raw):
    study_object(raw, ['schemaVersion', 'eventType', 'eventId', 'coreHash', 'taskId', 'subjectId', 'day', 'occurredAt', 'unitIds', 'source', 'evidenceRefs'])
    if study_count(raw['schemaVersion']) != 1 or raw['eventType'] != 'task-completed':
        raise ValueError('invalid-task-event')
    identifier = r'[A-Za-z0-9][A-Za-z0-9._:-]{5,127}'
    if type(raw['eventId']) is not str or not re.fullmatch(identifier, raw['eventId']):
        raise ValueError('invalid-task-event')
    for key in ('taskId', 'subjectId'):
        study_text(raw[key])
        if any(ord(c) < 32 for c in raw[key]):
            raise ValueError('invalid-task-event')
    for key in ('unitIds', 'evidenceRefs'):
        _strings(raw[key], key, SAFE_INTEGER)
        if len(set(raw[key])) != len(raw[key]) or any(any(ord(c) < 32 for c in child) for child in raw[key]):
            raise ValueError('invalid-task-event')
    study_iso(raw['occurredAt']); study_digest(raw['coreHash'])
    if type(raw['day']) is not str or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', raw['day']) or raw['day'].startswith('0000'):
        raise ValueError('invalid-task-event-day')
    try:
        occurred = datetime.fromisoformat(raw['occurredAt'].replace('Z', '+00:00'))
        if not recorded_day_matches(occurred, raw['day']):
            raise ValueError('invalid-task-event-day')
    except (ValueError, OverflowError) as error:
        raise ValueError('invalid-task-event-day') from error
    if raw['source'] not in ('self-report', 'evidence') or (raw['source'] == 'self-report' and raw['evidenceRefs']) or (raw['source'] == 'evidence' and (not raw['evidenceRefs'] or not raw['unitIds'])) or any(not re.fullmatch(identifier, ref) for ref in raw['evidenceRefs']):
        raise ValueError('invalid-task-evidence')
    if study_hash({key: value for key, value in raw.items() if key != 'coreHash'}) != raw['coreHash']:
        raise ValueError('invalid-task-event-hash')


def validate_record(raw):
    study_size(raw, 64 * 1024)
    common = ['schemaVersion', 'libraryId', 'snapshotId', 'originDeviceId', 'provenanceMode', 'event', 'envelopeHash']
    practice = ['contentHash', 'practiceMode', 'attemptId', 'parentEventId']
    legacy = ['resumeId', 'resumeStateHash', 'legacyStage', 'legacyAnchorEventId']
    task = ['planHash', 'assignmentId', 'completionKey']
    obj = study_object(raw, common, practice + legacy + task + ['roundId'])
    if study_count(obj['schemaVersion']) != 1:
        raise ValueError('unsupported-study-version')
    for key in ('libraryId', 'snapshotId', 'originDeviceId'):
        study_id(obj[key], key)
    study_digest(obj['envelopeHash'])
    mode = obj['provenanceMode']
    if mode == 'task':
        study_object(obj, common + task)
        study_digest(obj['planHash']); study_id(obj['assignmentId']); study_id(obj['completionKey'])
        _task_core(obj['event'])
    elif mode in ('verified-round', 'legacy-continuation'):
        study_object(obj, common + practice + (['roundId'] if mode == 'verified-round' else legacy))
        study_digest(obj['contentHash']); study_id(obj['attemptId'])
        if obj['practiceMode'] not in ('three-stage', 'quiz', 'recall', 'calculation', 'code', 'flashcard', 'spelling'):
            raise ValueError('invalid-practice-mode')
        if obj['parentEventId'] is not None:
            study_id(obj['parentEventId'])
        if mode == 'verified-round':
            study_id(obj['roundId'])
        else:
            study_id(obj['resumeId']); study_digest(obj['resumeStateHash'])
            if study_count(obj['legacyStage'], 'legacy-stage', 1) > 2:
                raise ValueError('invalid-legacy-stage')
            if obj['legacyAnchorEventId'] is not None:
                study_id(obj['legacyAnchorEventId'])
        _practice_core(obj['event'])
    else:
        raise ValueError('invalid-study-provenance')
    if study_hash({key: value for key, value in obj.items() if key != 'envelopeHash'}) != obj['envelopeHash']:
        raise ValueError('study-record-integrity')
    return copy.deepcopy(obj)


def compatible_modes(item):
    if item.get('learningSupport'):
        return [item['learningSupport']['type']]
    if item['kind'] == 'word':
        return (['three-stage'] if item['word']['example'].strip(JS_WHITESPACE) else []) + ['recall', 'flashcard', 'spelling']
    p = item['practice']; modes = ['recall']
    answer = p['options'][p['answer']] if p['questionType'] == 'quiz' else p.get('answer', '')
    if p['questionType'] == 'quiz':
        modes.insert(0, 'quiz')
    if (type(answer) is str and answer.strip(JS_WHITESPACE)) or p['questionType'] == 'calculation':
        modes.append('calculation')
    if all(type(p.get(key)) is str and p[key].strip(JS_WHITESPACE) for key in ('initialCode', 'testCode')):
        modes.append('code')
    if p['questionType'] == 'flashcard' or answer.strip(JS_WHITESPACE) or p.get('solutionCode', '').strip(JS_WHITESPACE):
        modes.append('flashcard')
    return modes


def _check_item(record, item):
    support=item.get('learningSupport')
    if type(support) is dict and support.get('schemaVersion')==2 and support.get('type') in ('recall','quiz'):
        from course_task_support import course_task_readiness
        issues=course_task_readiness(support['task'],item.get('practice',{}).get('prompt',''),item['kind']=='word')
        if issues:raise ValueError(issues[0])
    if record['contentHash'] != item['contentHash'] or record['event']['item']['key'] != item['itemKey'] or record['event']['item']['kind'] != item['eventKind']:
        raise ValueError('study-record-item-binding')
    attempt = record['event']['attempt']; three_stage = record['practiceMode'] == 'three-stage'
    if (not attempt['correct'] and attempt['rating'] in ('good', 'easy')) or (attempt['correct'] and attempt['rating'] == 'again'):
        raise ValueError('inconsistent-study-rating')
    if record['provenanceMode'] == 'legacy-continuation' and (item['kind'] != 'word' or not three_stage):
        raise ValueError('invalid-legacy-content')
    if record['practiceMode'] not in compatible_modes(item):
        raise ValueError('invalid-study-practice-mode')
    if three_stage:
        if attempt['stageBefore'] >= 3 or attempt['stageAfter'] != (attempt['stageBefore'] + 1 if attempt['correct'] else 0):
            raise ValueError('invalid-word-stage-transition')
    elif attempt['stageAfter'] != (3 if attempt['correct'] else 0):
        raise ValueError('invalid-practice-stage-transition')
    scheduled = not three_stage or not attempt['correct'] or attempt['stageAfter'] == 3
    if ('scheduling' in record['event']) != scheduled:
        raise ValueError('invalid-study-scheduling')
    if scheduled and record['event']['scheduling']['reviewedAt'] != record['event']['occurredAt']:
        raise ValueError('invalid-study-scheduling-time')


def _check_parent(child, parent):
    mode = child['provenanceMode']
    fields = ['provenanceMode', 'libraryId', 'snapshotId', 'contentHash', 'originDeviceId', 'practiceMode']
    fields += ['roundId'] if mode == 'verified-round' else ['resumeId', 'resumeStateHash', 'legacyStage', 'legacyAnchorEventId']
    if any(parent.get(key) != child[key] for key in fields) or any(parent['event']['item'][key] != child['event']['item'][key] for key in ('key', 'kind')):
        raise ValueError('study-record-parent-binding')
    if parent['event']['occurredAt'] > child['event']['occurredAt']:
        raise ValueError('study-record-parent-time')
    if parent['attemptId'] == child['attemptId']:
        raise ValueError('duplicate-study-attempt')
    before = parent['event']['attempt']; after = child['event']['attempt']
    if before['stageAfter'] == 3 or (mode == 'legacy-continuation' and not before['correct']):
        raise ValueError('terminal-study-round')
    if before['stageAfter'] != after['stageBefore']:
        raise ValueError('study-record-parent-stage')


def check_record_binding(record, item, ancestors=()):
    """Inputs must already be validated. This does not approve Vault projection."""
    if record['provenanceMode'] == 'task':
        raise ValueError('task-plan-binding-required')
    if len(ancestors) > 10000:
        raise ValueError('study-ancestry-too-large')
    by_id = {}
    for entry in [record, *ancestors]:
        event_id = entry['event']['eventId']; old = by_id.get(event_id)
        if old and any(old[key] != entry[key] for key in ('libraryId', 'envelopeHash')):
            raise ValueError('study-parent-conflict')
        by_id[event_id] = entry
    children, attempts = {}, set()
    for entry in by_id.values():
        if entry['provenanceMode'] == 'task' or entry['libraryId'] != record['libraryId'] or entry['originDeviceId'] != record['originDeviceId']:
            continue
        identity = 'roundId' if record['provenanceMode'] == 'verified-round' else 'resumeId'
        if entry['provenanceMode'] != record['provenanceMode'] or entry[identity] != record[identity]:
            continue
        if entry['snapshotId'] != record['snapshotId'] or entry['contentHash'] != record['contentHash'] or entry['practiceMode'] != record['practiceMode']:
            raise ValueError('study-record-round-binding')
        sibling = children.get(entry['parentEventId'])
        if sibling is not None and sibling != entry['event']['eventId']:
            raise ValueError('study-round-fork')
        children[entry['parentEventId']] = entry['event']['eventId']
        if entry['attemptId'] in attempts:
            raise ValueError('duplicate-study-attempt')
        attempts.add(entry['attemptId'])
    seen, current = set(), record
    while True:
        if current['event']['eventId'] in seen:
            raise ValueError('study-parent-cycle')
        seen.add(current['event']['eventId']); _check_item(current, item)
        if current['parentEventId'] is None:
            start = current['legacyStage'] if current['provenanceMode'] == 'legacy-continuation' else 0
            if current['practiceMode'] == 'three-stage' and current['event']['attempt']['stageBefore'] != start:
                raise ValueError('invalid-study-start-stage')
            return 'ready'
        parent = by_id.get(current['parentEventId'])
        if parent is None:
            return 'pending-parent'
        _check_parent(current, parent); current = parent


def validate_receipt(raw):
    study_object(raw, ['schemaVersion', 'receiptId', 'eventId', 'envelopeHash', 'status'], ['reason', 'proof'])
    if study_count(raw['schemaVersion']) != 1:
        raise ValueError('unsupported-writeback-receipt-version')
    study_id(raw['receiptId']); study_id(raw['eventId']); study_digest(raw['envelopeHash'])
    if raw['status'] not in ('received', 'blocked', 'applied'):
        raise ValueError('invalid-writeback-status')
    if raw['status'] == 'applied':
        proof = study_object(raw.get('proof'), ['coreHash', 'proofHash', 'targetCount'])
        study_digest(proof['coreHash']); study_digest(proof['proofHash'])
        if study_count(proof['targetCount'], 'writeback-proof-targets', 1) > 16:
            raise ValueError('invalid-writeback-proof-targets')
    elif 'proof' in raw:
        raise ValueError('invalid-writeback-proof')
    if raw['status'] == 'blocked':
        if raw.get('reason') not in ('source-changed', 'source-missing', 'mapping-missing', 'dependency-pending', 'write-conflict', 'storage-unavailable', 'writeback-failed', 'baseline-unverified'):
            raise ValueError('invalid-writeback-reason')
    elif 'reason' in raw:
        raise ValueError('invalid-writeback-reason')
    study_size(raw, 4096)
    return copy.deepcopy(raw)
