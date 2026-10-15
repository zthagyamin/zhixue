"""Pure contracts for temporary source captures and controlled formal claims."""
from __future__ import annotations

import json
import math
from datetime import UTC, datetime


def canonical_json(value):
    """Bounded JSON contract; the infrastructure owns digest implementation."""
    def inspect(node, depth=0):
        if depth > 32:
            raise ValueError('source-admission-size')
        if node is None or type(node) in (str, bool, int):
            return
        if type(node) is float and math.isfinite(node):
            return
        if type(node) is list:
            for child in node:
                inspect(child, depth + 1)
            return
        if type(node) is dict and all(type(key) is str for key in node):
            for child in node.values():
                inspect(child, depth + 1)
            return
        raise ValueError('source-admission-json')
    inspect(value)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    if len(raw.encode('utf-8')) > 500000:
        raise ValueError('source-admission-size')
    return raw


def fields(raw, required, optional=()):
    if type(raw) is not dict or set(raw) - set(required) - set(optional) or set(required) - set(raw):
        raise ValueError('source-admission-fields')
    return json.loads(canonical_json(raw))


def identifier(value):
    if type(value) is not str or not value.strip() or value != value.strip() or len(value) > 200:
        raise ValueError('source-admission-identifier')
    if any(ord(part) < 32 or ord(part) == 127 for part in value):
        raise ValueError('source-admission-identifier')
    return value


def digest(value):
    if type(value) is not str or len(value) != 64 or any(part not in '0123456789abcdef' for part in value):
        raise ValueError('source-admission-hash')
    return value


def instant(value, *, formal=False):
    if type(value) is not str or len(value) > 100:
        raise ValueError('source-admission-time')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
    except ValueError as error:
        raise ValueError('source-admission-time') from error
    # Same strict representation as study_event_schema._require_iso_date.
    # Reject noncanonical originals rather than silently rewriting submissions.
    if formal and parsed.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z') != value:
        raise ValueError('source-admission-time')
    return value


def parse_query(raw):
    query = fields(raw, ('itemKey', 'contentHash', 'presentation'), ('sourceItemKey',))
    identifier(query['itemKey'])
    digest(query['contentHash'])
    if 'sourceItemKey' in query:
        identifier(query['sourceItemKey'])
    if type(query['presentation']) is not dict or not query['presentation']:
        raise ValueError('source-admission-presentation')
    return query


def parse_descriptor(raw):
    """Only the injected owner-aware resolver can supply this private descriptor."""
    value = fields(raw, ('sourceKey', 'sourceHash', 'eventKind', 'item', 'route'))
    identifier(value['sourceKey'])
    digest(value['sourceHash'])
    if value['eventKind'] not in ('due', 'python') or type(value['item']) is not dict:
        raise ValueError('source-admission-descriptor')
    if type(value['route']) is not dict:
        raise ValueError('source-admission-route')
    return value


def parse_binding(raw, owner, library):
    binding = fields(raw, ('ownerId', 'libraryId', 'itemKey', 'contentHash', 'captureId'))
    if binding['ownerId'] != owner or binding['libraryId'] != library:
        raise ValueError('source-admission-scope')
    identifier(binding['itemKey'])
    digest(binding['contentHash'])
    identifier(binding['captureId'])
    return binding


def parse_submission(raw, owner, library):
    value = fields(raw, ('attemptId', 'binding', 'answerRevision', 'answer', 'submittedAt'),
                   ('purpose', 'parentAttemptId', 'assistance', 'maxPreHintLevel', 'answerRevealed'))
    identifier(value['attemptId'])
    value['binding'] = parse_binding(value['binding'], owner, library)
    if type(value['answerRevision']) is not int or value['answerRevision'] < 0:
        raise ValueError('source-admission-answer-revision')
    instant(value['submittedAt'], formal=True)
    purpose = value.get('purpose', 'unknown')
    parent = value.get('parentAttemptId')
    if purpose not in ('first', 'guided', 'remediation', 'unknown'):
        raise ValueError('source-admission-purpose')
    if parent is not None:
        identifier(parent)
    if (purpose == 'first' and parent is not None
            or purpose == 'remediation' and parent is None
            or parent == value['attemptId']):
        raise ValueError('source-admission-purpose')
    if value.get('assistance', 'unknown') not in ('independent', 'observed', 'unknown'):
        raise ValueError('source-admission-assistance')
    if ('maxPreHintLevel' in value and (type(value['maxPreHintLevel']) is not int
                                      or not 0 <= value['maxPreHintLevel'] <= 3)
            or 'answerRevealed' in value and type(value['answerRevealed']) is not bool):
        raise ValueError('source-admission-assistance')
    if len(json.dumps(value['answer'], ensure_ascii=False).encode('utf-8')) > 64000:
        raise ValueError('source-admission-answer-size')
    return value



def parse_self_assessment(raw, owner, library):
    value = fields(raw, ('schemaVersion', 'attemptId', 'binding', 'answerRevision', 'submittedAt', 'rating'))
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('source-admission-version')
    identifier(value['attemptId'])
    value['binding'] = parse_binding(value['binding'], owner, library)
    if type(value['answerRevision']) is not int or value['answerRevision'] < 0:
        raise ValueError('source-admission-answer-revision')
    instant(value['submittedAt'], formal=True)
    if value['rating'] not in ('again', 'hard', 'good', 'easy'):
        raise ValueError('source-admission-self-assessment-rating')
    return value


def normalize_evaluation(raw, item):
    """Abstain on unavailable, contradictory or unsupported specialist outputs."""
    mode = item.get('questionType') or item.get('pluginType')
    if mode in ('code', 'flashcard'):
        return {'status': 'pending', 'reason': 'specialist-evaluation-required'}
    if type(raw) is not dict:
        return {'status': 'pending', 'reason': 'evaluation-unavailable'}
    correct = raw.get('correct')
    verdict = raw.get('verdict', raw.get('status'))
    if type(correct) is not bool:
        return {'status': 'pending', 'reason': 'evaluation-undetermined'}
    if verdict not in ('correct', 'partial', 'wrong', 'incorrect', 'resolved'):
        return {'status': 'pending', 'reason': 'evaluation-undetermined'}
    if (verdict == 'correct' and not correct) or (verdict in ('partial', 'wrong', 'incorrect') and correct):
        return {'status': 'pending', 'reason': 'evaluation-contradictory'}
    explanation = raw.get('explanation', '')
    if type(explanation) is not str or len(explanation) > 8000:
        return {'status': 'pending', 'reason': 'evaluation-invalid'}
    return {'status': 'resolved', 'correct': correct, 'explanation': explanation,
            'outcome': 'correct' if correct else 'partial' if verdict == 'partial' else 'incorrect'}
