"""Pure replay/rendering for the new channel; legacy projection is unchanged."""
from __future__ import annotations

import base64
import copy
import json
import re
from datetime import datetime, timedelta, timezone

import learning_result
import review_queue
import state_projection
from managed_markdown import replace_managed_block
from account_sync_schema import study_digest, study_hash, study_iso, study_object, study_text, validate_record

ACCOUNT_EVIDENCE_BEGIN = '%% ZHIXUE:ACCOUNT-LEARNING-EVIDENCE:BEGIN %%'
ACCOUNT_EVIDENCE_END = '%% ZHIXUE:ACCOUNT-LEARNING-EVIDENCE:END %%'
INTERVALS = {'again': 1, 'hard': 3, 'good': 7, 'easy': 14}


def managed_body(text, begin, end):
    if begin not in text and end not in text:
        return None
    if text.count(begin) != 1 or text.count(end) != 1 or text.index(begin) >= text.index(end):
        raise ValueError('conflicting-managed-block')
    return text[text.index(begin) + len(begin):text.index(end)]


def _review_state(text):
    meta = learning_result._parse_frontmatter(text.removeprefix('\ufeff'))
    if meta.get('type') != 'learning-result':
        raise ValueError('invalid-review-card')
    body = managed_body(text, review_queue.REVIEW_QUEUE_BEGIN, review_queue.REVIEW_QUEUE_END)
    entries, event_ids, names = [], [], set()
    seen_journal = False
    if body is not None:
        for line in body.splitlines():
            line = line.strip()
            if not line or line == '（暂无待复习项）':
                continue
            journal = re.fullmatch(r'<!-- ZHIXUE:REVIEW-EVENTS ([A-Za-z0-9_=-]+) -->', line)
            if journal:
                if seen_journal:
                    raise ValueError('duplicate-review-journal')
                seen_journal = True
                try:
                    event_ids = json.loads(base64.b64decode(journal[1], altchars=b'-_', validate=True))
                except (ValueError, UnicodeError):
                    raise ValueError('invalid-review-journal') from None
                if type(event_ids) is not list or any(type(value) is not str for value in event_ids) or len(set(event_ids)) != len(event_ids):
                    raise ValueError('invalid-review-journal')
                continue
            entry = review_queue.parse_queue_line(line)
            if not entry or entry['name'] in names:
                raise ValueError('invalid-review-queue')
            names.add(entry['name']); entries.append(entry)
    frontmatter = re.match(r'^(?:\ufeff)?---\r?\n(?P<yaml>.*?)\r?\n---(?:\r?\n|$)', text, flags=re.DOTALL)
    if not frontmatter:
        raise ValueError('invalid-review-frontmatter')
    properties = {}
    for key in ('review_date', 'review_enabled'):
        matches = re.findall(rf'^{key}:[ \t]*([^\r\n]*)', frontmatter['yaml'], flags=re.MULTILINE)
        if len(matches) > 1:
            raise ValueError('duplicate-review-property')
        if matches:
            scalar = re.sub(r'[ \t]+#.*$', '', matches[0]).strip().strip('\"\'')
            properties[key] = scalar
    enabled = properties.get('review_enabled', 'true').lower()
    if enabled not in ('true', 'false'):
        raise ValueError('invalid-review-enabled')
    return {'entries': entries, 'eventIds': event_ids, 'reviewDate': properties.get('review_date', ''),
            'reviewEnabled': enabled == 'true'}


def review_fingerprint(text):
    return study_hash(_review_state(text))


def capture_review_baseline(text, known_event_hashes, captured_at):
    study_iso(captured_at)
    state = _review_state(text)
    if type(known_event_hashes) is not dict or any(type(key) is not str for key in known_event_hashes):
        raise ValueError('invalid-review-baseline')
    for value in known_event_hashes.values():
        study_digest(value)
    if any(event_id not in known_event_hashes for event_id in state['eventIds']):
        raise ValueError('review-baseline-unverified')
    body = {'schemaVersion': 1, 'capturedAt': captured_at, **state,
            'includedRecords': {event_id: known_event_hashes[event_id] for event_id in state['eventIds']}}
    return {**body, 'baselineHash': study_hash(body)}


def effective_events(records):
    """Caller must have admitted ancestry/membership; preserve original cores."""
    events = {}
    for raw in records:
        record = validate_record(raw)
        if record['provenanceMode'] == 'task':
            continue
        event = record['event']; attempt = event['attempt']
        if (not attempt['correct'] and attempt['rating'] in ('good', 'easy')) or (attempt['correct'] and attempt['rating'] == 'again'):
            raise ValueError('inconsistent-study-rating')
        if record['practiceMode'] == 'three-stage' and attempt['correct'] and attempt['stageAfter'] != 3:
            continue
        old = events.get(event['eventId'])
        if old and old != event:
            raise ValueError('projection-event-conflict')
        events[event['eventId']] = event
    return sorted(events.values(), key=lambda e: (e['occurredAt'], e['eventId']))


def replay_review_queue(baseline, evidence):
    study_object(baseline, ['schemaVersion', 'capturedAt', 'entries', 'eventIds', 'reviewDate', 'reviewEnabled', 'includedRecords', 'baselineHash'])
    if baseline['schemaVersion'] != 1 or study_hash({key: value for key, value in baseline.items() if key != 'baselineHash'}) != baseline['baselineHash']:
        raise ValueError('review-baseline-integrity')
    state = copy.deepcopy({key: baseline[key] for key in ('entries', 'eventIds', 'reviewDate', 'reviewEnabled')})
    seen = {}
    for entry in evidence:
        study_object(entry, ['record', 'entryName']); study_text(entry['entryName'])
        if '\n' in entry['entryName'] or '\r' in entry['entryName']:
            raise ValueError('invalid-review-entry-name')
        record = validate_record(entry['record']); event = record['event']; event_id = event['eventId']
        old = seen.get(event_id)
        if old and old != entry:
            raise ValueError('projection-event-conflict')
        seen[event_id] = entry
    ordered = sorted(seen.values(), key=lambda e: (e['record']['event']['occurredAt'], e['record']['event']['eventId']))
    for entry in ordered:
        record = entry['record']; event = record['event']; event_id = event['eventId']
        if not effective_events([record]):
            continue
        if event_id in baseline['includedRecords']:
            if baseline['includedRecords'][event_id] != event['coreHash']:
                raise ValueError('review-baseline-event-conflict')
            continue
        if event['occurredAt'] < baseline['capturedAt']:
            raise ValueError('review-baseline-unverified')
        rating = event['attempt']['rating']; good = rating in ('good', 'easy')
        day = datetime.fromisoformat(event['occurredAt'].replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8))).date()
        due = (day + timedelta(days=INTERVALS[rating])).isoformat()
        item = next((item for item in state['entries'] if item['name'] == entry['entryName']), None)
        if item is None:
            item = {'done': False, 'name': entry['entryName'], 'due': due, 'attempts': 0, 'last': '', 'note': '', 'chain': 0}
            state['entries'].append(item)
        item['attempts'] += int(good); item['chain'] = item['chain'] + 1 if good else 0
        item['due'] = due; item['last'] = 'good' if good else 'partial' if rating == 'hard' else 'wrong'
        item['done'] = good and item['chain'] >= 2
        state['entries'] = [item for item in state['entries'] if not item['done']]
        state['eventIds'].append(event_id); state['reviewDate'] = due; state['reviewEnabled'] = bool(state['entries'])
    return state


def _replace_block(text, begin, end, body):
    result = replace_managed_block(text, begin, end, body)
    # Legacy helper preserves outside text but leaves LF within a multiline
    # body. Normalize only this newly rendered block, not the user's document.
    if '\r\n' in text:
        start, finish = result.index(begin), result.index(end) + len(end)
        block = result[start:finish].replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
        result = result[:start] + block + result[finish:]
    return result


def render_review_queue(text, state):
    current = _review_state(text)  # Never discard malformed user edits inside the block.
    if state == current:
        return text
    block = review_queue._render_queue(state['entries'], state['eventIds'])
    body = managed_body(block, review_queue.REVIEW_QUEUE_BEGIN, review_queue.REVIEW_QUEUE_END).strip('\n')
    result = _replace_block(text, review_queue.REVIEW_QUEUE_BEGIN, review_queue.REVIEW_QUEUE_END, body)
    frontmatter = re.match(r'^(?:\ufeff)?---\r?\n(?P<yaml>.*?)\r?\n---(?:\r?\n|$)', result, flags=re.DOTALL)
    if not frontmatter:
        raise ValueError('invalid-review-frontmatter')
    yaml = frontmatter['yaml']; newline = '\r\n' if '\r\n' in result else '\n'
    for key, value in (('review_date', state['reviewDate']), ('review_enabled', 'true' if state['reviewEnabled'] else 'false')):
        state_key = 'reviewDate' if key == 'review_date' else 'reviewEnabled'
        if current[state_key] == state[state_key]:
            continue
        pattern = re.compile(rf'^{key}:([ \t]*)([^\r\n]*)(\r?)$', flags=re.MULTILINE)
        if len(pattern.findall(yaml)) > 1:
            raise ValueError('duplicate-review-property')
        def replacement(match):
            comment = re.search(r'[ \t]+#[^\r\n]*$', match[2])
            return f'{key}:{match[1]}{value}' + (comment[0] if comment else '') + match[3]
        yaml = pattern.sub(replacement, yaml) if pattern.search(yaml) else yaml + newline + f'{key}: {value}'
    return result[:frontmatter.start('yaml')] + yaml + result[frontmatter.end('yaml'):]


def render_account_evidence(text, ability_events):
    meta = learning_result._parse_frontmatter(text.removeprefix('\ufeff'))
    if meta.get('type') not in ('learning-state', 'paper-note', 'project', 'review', 'zhixue-practice-state'):
        raise ValueError('invalid-account-state-target')
    managed_body(text, ACCOUNT_EVIDENCE_BEGIN, ACCOUNT_EVIDENCE_END)
    groups = {key: sorted(values, key=lambda e: (e['occurredAt'], e['eventId'])) for key, values in ability_events.items() if values}
    return _replace_block(text, ACCOUNT_EVIDENCE_BEGIN, ACCOUNT_EVIDENCE_END, state_projection._render(groups))
