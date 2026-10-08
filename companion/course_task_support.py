"""Closed course-task V2 metadata; parsing makes no semantic or grading claim."""
import copy
import math
import re
import unicodedata

from account_sync_schema import JS_WHITESPACE
from recall_quality import needs_concrete_recall_question

TASK_KINDS = ('definition', 'steps', 'comparison', 'conditions', 'application')
REVIEW_STATES = ('candidate', 'verified', 'disputed')
TASK_FIELDS = ('taskId', 'kind', 'prompt', 'scope', 'conditions')
SOURCE_FIELDS = ('sourceId', 'label', 'locator', 'excerpt', 'version')
REMEDIATION_FIELDS = TASK_FIELDS + ('criteria', 'answer', 'targetPointIds', 'wrongOptionIds', 'missingOptionIds')
JS_SPACE_PATTERN = re.compile('[' + re.escape(JS_WHITESPACE) + ']+')


def _closed(value, required, optional=()):
    if type(value) is not dict or set(value) - set(required + optional) or set(required) - set(value):
        raise ValueError('invalid-course-task-object')
    return value


def _text(value, maximum):
    if (type(value) is not str or not value.strip(JS_WHITESPACE)
            or len(value.encode('utf-16-le', errors='surrogatepass')) // 2 > maximum
            or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', value)):
        raise ValueError('invalid-course-task-text')
    return value


def _identifier(value):
    value = _text(value, 64)
    if not re.fullmatch(r'[a-zA-Z0-9:_.-]+', value):
        raise ValueError('invalid-course-task-id')
    return value


def _array(value, minimum, maximum):
    if type(value) is not list or not minimum <= len(value) <= maximum:
        raise ValueError('invalid-course-task-array')
    return value


def _integer(value, minimum, maximum):
    """JSON numbers follow JS integer semantics; booleans never count as numbers."""
    if type(value) is int:
        return minimum <= value <= maximum
    return (type(value) is float and math.isfinite(value) and value.is_integer()
            and minimum <= value <= maximum)


def _references(value, known, minimum, maximum):
    refs = _array(value, minimum, maximum)
    seen = set()
    for ident in refs:
        if type(ident) is not str or ident not in known or ident in seen:
            raise ValueError('invalid-course-task-reference')
        seen.add(ident)
    return seen


def _criteria(value, source_ids):
    seen = set()
    for point in _array(value, 1, 24):
        point = _closed(point, ('id', 'text', 'sourceIds'), ('weight', 'mandatory'))
        ident = _identifier(point['id'])
        if ident in seen:
            raise ValueError('duplicate-course-task-criterion')
        seen.add(ident)
        _text(point['text'], 1500)
        _references(point['sourceIds'], source_ids, 1, 12)
        if 'weight' in point and not _integer(point['weight'], 1, 1000):
            raise ValueError('invalid-course-task-weight')
        if 'mandatory' in point and type(point['mandatory']) is not bool:
            raise ValueError('invalid-course-task-mandatory')
    return seen


def _task_fields(value):
    ident = _identifier(value['taskId'])
    if type(value['kind']) is not str or value['kind'] not in TASK_KINDS:
        raise ValueError('invalid-course-task-kind')
    _text(value['prompt'], 4000)
    _text(value['scope'], 1500)
    for condition in _array(value['conditions'], 0, 16):
        _text(condition, 1500)
    return ident


def _sources(value):
    seen = set()
    for source in _array(value, 1, 12):
        source = _closed(source, SOURCE_FIELDS)
        ident = _identifier(source['sourceId'])
        if ident in seen:
            raise ValueError('duplicate-course-task-source')
        seen.add(ident)
        _text(source['label'], 300)
        locator = _text(source['locator'], 1000)
        if re.match(r'^(?:[a-zA-Z]:[\\/]|[\\/]|file:)', locator.strip(JS_WHITESPACE), re.IGNORECASE):
            raise ValueError('absolute-course-task-locator')
        _text(source['excerpt'], 16000)
        if type(source['version']) is not str or not re.fullmatch(r'[a-f0-9]{64}', source['version']):
            raise ValueError('invalid-course-task-source-version')
    return seen


def _remediations(value, parent_id, source_ids, point_ids, option_ids):
    task_ids = {parent_id}
    for remediation in _array(value, 0, 12):
        remediation = _closed(remediation, REMEDIATION_FIELDS)
        ident = _task_fields(remediation)
        if ident in task_ids:
            raise ValueError('duplicate-course-remediation-task')
        task_ids.add(ident)
        _criteria(remediation['criteria'], source_ids)
        _text(remediation['answer'], 8000)
        targets = _references(remediation['targetPointIds'], point_ids, 0, 24)
        wrong = _references(remediation['wrongOptionIds'], option_ids, 0, 32)
        missing = _references(remediation['missingOptionIds'], option_ids, 0, 32)
        if not targets and not wrong and not missing:
            raise ValueError('empty-course-remediation-trigger')


def _task_and_criteria(value, option_ids):
    task = _closed(value['task'], TASK_FIELDS + ('sources', 'reviewStatus', 'remediations'))
    parent_id = _task_fields(task)
    if type(task['reviewStatus']) is not str or task['reviewStatus'] not in REVIEW_STATES:
        raise ValueError('invalid-course-task-review-status')
    source_ids = _sources(task['sources'])
    point_ids = _criteria(value['criteria'], source_ids)
    _remediations(task['remediations'], parent_id, source_ids, point_ids, option_ids)
    return source_ids


def _normalized_option_text(value):
    return JS_SPACE_PATTERN.sub(' ', unicodedata.normalize('NFC', value)).strip(' ')


def course_task_readiness(task, prompt, word=False):
    """Return ordered blockers for an already structurally validated V2 task."""
    codes = []
    if word:
        codes.append('course-task-word')
    if task['reviewStatus'] != 'verified':
        codes.append('course-task-unreviewed')
    if _normalized_option_text(prompt) != _normalized_option_text(task['prompt']):
        codes.append('course-task-prompt-mismatch')
    if task['kind'] in ('conditions', 'application') and not task['conditions']:
        codes.append('course-task-missing-conditions')
    if needs_concrete_recall_question({'prompt': _normalized_option_text(task['prompt'])}):
        codes.append('unfocused-recall-question')
    return codes


def parse_recall_support_v2(raw):
    value = _closed(raw, ('schemaVersion', 'type', 'criteria', 'task'), ('hints',))
    if not _integer(value['schemaVersion'], 2, 2) or value['type'] != 'recall':
        raise ValueError('unsupported-course-task-support')
    _task_and_criteria(value, set())
    if 'hints' in value:
        for hint in _array(value['hints'], 3, 3):
            _text(hint, 2000)
    return copy.deepcopy(value)


def parse_quiz_support_v2(raw):
    from quiz_support import parse_quiz_support

    base_fields = ('schemaVersion', 'type', 'selection', 'options', 'correctOptionIds')
    value = _closed(raw, base_fields + ('criteria', 'task'))
    if not _integer(value['schemaVersion'], 2, 2):
        raise ValueError('unsupported-course-task-support')
    base = {key: value[key] for key in base_fields}
    base['schemaVersion'] = 1
    base_options = []
    for option in _array(value['options'], 2, 32):
        option = _closed(option, ('optionId', 'text', 'explanation', 'sourceIds'), ('trapType', 'trapExplanation'))
        base_options.append({key: option[key] for key in ('optionId', 'text', 'trapType', 'trapExplanation') if key in option})
    base['options'] = base_options
    # Reuse the authoritative V1 option/correct-set/trap rules without mutating V1.
    parse_quiz_support(base)
    option_ids = {option['optionId'] for option in value['options']}
    source_ids = _task_and_criteria(value, option_ids)
    texts = set()
    for option in value['options']:
        _text(option['explanation'], 2000)
        _references(option['sourceIds'], source_ids, 1, 12)
        normalized = _normalized_option_text(option['text'])
        if normalized in texts:
            raise ValueError('duplicate-course-quiz-option-text')
        texts.add(normalized)
    return copy.deepcopy(value)
