"""Pure CourseStudy V1 task/diagnostic rules, matching the TypeScript domain.

The resolver consumes a canonical StudyItem envelope. Native cleanup and its
identity remain the responsibility of the native adapter, outside these rules.
"""
import copy
import json
import re

from account_sync_schema import (
    study_digest, study_hash, study_object, study_size, study_text,
)
from course_task_support import (
    _integer, course_task_readiness, parse_quiz_support_v2, parse_recall_support_v2,
)

ALIGNMENT_KEYS = ('matchedPointIds', 'missedPointIds', 'errorPointIds',
                  'wrongOptionIds', 'missingOptionIds')
POINT_KEYS = ALIGNMENT_KEYS[:3]
UNKNOWN_REASONS = ('unavailable', 'offline', 'cancelled', 'source-insufficient',
                   'source-conflict', 'uncertain', 'invalid-result')
RATINGS = {'correct': 'good', 'partial': 'hard', 'incorrect': 'again'}


def resolve_course_support_v2(item):
    """Resolve only ready original V2 course material, with no legacy fallback."""
    practice = item.get('practice') if type(item) is dict else None
    if (type(item) is not dict or not _integer(item.get('schemaVersion'), 2, 2)
            or item.get('kind') != 'practice' or item.get('eventKind') == 'word'
            or type(practice) is not dict or practice.get('questionType') not in ('recall', 'quiz')):
        raise ValueError('unsupported-course-item')
    if any(key in practice for key in ('answer', 'explanation', 'reviewPoint', 'options')):
        raise ValueError('duplicate-course-reference')
    parser = parse_recall_support_v2 if practice['questionType'] == 'recall' else parse_quiz_support_v2
    support = parser(item.get('learningSupport'))
    issues = course_task_readiness(support['task'], practice.get('prompt'))
    if issues:
        raise ValueError(issues[0])
    return support


resolve_course_support = resolve_course_support_v2


def resolve_course_task(item, task_id=None):
    support = resolve_course_support_v2(item)
    parent = support['task']
    child = None
    if task_id and task_id != parent['taskId']:
        child = next((row for row in parent['remediations'] if row['taskId'] == task_id), None)
        if child is None:
            raise ValueError('course-task-not-found')
        issues = course_task_readiness({**parent, **child}, child['prompt'])
        if issues:
            raise ValueError(issues[0])
    task = child if child is not None else parent
    result = {'schemaVersion': 1, 'taskId': task['taskId'],
              'mode': 'recall' if child is not None else support['type'],
              'kind': task['kind'], 'prompt': task['prompt'], 'scope': task['scope'],
              'conditions': task['conditions'], 'sources': parent['sources'],
              'criteria': child['criteria'] if child is not None else support['criteria'],
              'answer': child['answer'] if child is not None else '\n'.join(
                  point['text'] for point in support['criteria'])}
    if child is None and support['type'] == 'quiz':
        result.update({key: support[key] for key in ('options', 'selection', 'correctOptionIds')})
    return copy.deepcopy(result)


def course_task_hash(task):
    return study_hash(task)


def course_identifier(raw, maximum=64):
    study_text(raw, 'course-id', maximum)
    if re.search(r'[^a-zA-Z0-9:_.-]', raw):
        raise ValueError('invalid-course-id')
    return raw


def _ids(raw, maximum):
    if type(raw) is not list or len(raw) > maximum:
        raise ValueError('invalid-course-diagnostic-ids')
    values = [course_identifier(value) for value in raw]
    if len(set(values)) != len(values):
        raise ValueError('duplicate-course-diagnostic-id')
    return values


def _text(raw, maximum, empty=False):
    return study_text(raw, 'course-diagnostic-text', maximum, empty)


def parse_course_diagnostic(raw):
    """Closed structure only; validation also binds task and original answer."""
    study_size(raw, 65536)
    unknown = type(raw) is dict and raw.get('status') == 'undetermined'
    fields = ('schemaVersion', 'status', 'source', 'feedback') + ALIGNMENT_KEYS + ('pointEvidence',)
    row = study_object(raw, fields + (('reason',) if unknown else ()))
    sources = ('model', 'deterministic', 'self-assess') + (('none',) if unknown else ())
    if (not _integer(row['schemaVersion'], 1, 1) or type(row['status']) is not str
            or row['status'] not in (*RATINGS, 'undetermined')
            or type(row['source']) is not str or row['source'] not in sources):
        raise ValueError('invalid-course-diagnostic-status')
    alignments = {key: _ids(row[key], 32 if 'Option' in key else 24) for key in ALIGNMENT_KEYS}
    partition = [ident for key in POINT_KEYS for ident in alignments[key]]
    if len(set(partition)) != len(partition):
        raise ValueError('overlapping-course-point-partition')
    if set(alignments['wrongOptionIds']) & set(alignments['missingOptionIds']):
        raise ValueError('overlapping-course-option-gaps')
    if type(row['pointEvidence']) is not list or len(row['pointEvidence']) > 24:
        raise ValueError('invalid-course-point-evidence')
    evidence_ids, point_evidence = set(), []
    for entry in row['pointEvidence']:
        evidence = study_object(entry, ('pointId', 'sourceId', 'sourceQuote', 'answerQuote', 'reason'))
        point_id = course_identifier(evidence['pointId'])
        if point_id in evidence_ids or point_id not in partition:
            raise ValueError('invalid-course-evidence-point')
        evidence_ids.add(point_id)
        point_evidence.append({
            'pointId': point_id, 'sourceId': course_identifier(evidence['sourceId']),
            'sourceQuote': _text(evidence['sourceQuote'], 1000),
            'answerQuote': _text(evidence['answerQuote'], 1000, point_id in alignments['missedPointIds']),
            'reason': _text(evidence['reason'], 1000),
        })
    if unknown:
        if (type(row['reason']) is not str or row['reason'] not in UNKNOWN_REASONS
                or any(alignments.values()) or point_evidence):
            raise ValueError('invalid-course-unknown-diagnostic')
    elif row['source'] == 'self-assess' and (any(alignments.values()) or point_evidence):
        raise ValueError('self-assessment-has-course-alignment')
    return {**row, **alignments, 'feedback': _text(row['feedback'], 4000), 'pointEvidence': point_evidence}


def parse_course_evaluation_trace(raw):
    if raw is None:
        return None
    row = study_object(raw, ('modelId', 'promptVersion', 'ruleVersion', 'requestId'), ('provider',))
    result = {'modelId': _text(row['modelId'], 200), 'promptVersion': _text(row['promptVersion'], 120),
              'ruleVersion': _text(row['ruleVersion'], 120), 'requestId': course_identifier(row['requestId'], 120)}
    if 'provider' in row:
        result['provider'] = _text(row['provider'], 200)
    return result


def _same_set(left, right):
    return len(left) == len(right) and all(ident in right for ident in left)


def validate_course_diagnostic(raw, task, answer):
    diagnostic = parse_course_diagnostic(raw)
    study_text(answer, 'course-original-answer', 32000, True)
    if diagnostic['status'] == 'undetermined' or diagnostic['source'] == 'self-assess':
        return diagnostic
    if diagnostic['source'] == 'deterministic':
        if task['mode'] != 'quiz':
            raise ValueError('deterministic-course-recall-forbidden')
        computed = deterministic_course_diagnostic(task, answer)
        if (diagnostic['status'] != computed['status']
                or any(not _same_set(diagnostic[key], computed[key]) for key in ALIGNMENT_KEYS[3:])
                or any(diagnostic[key] for key in POINT_KEYS) or diagnostic['pointEvidence']):
            raise ValueError('inconsistent-course-quiz-diagnostic')
        return diagnostic
    if task['mode'] != 'recall' or diagnostic['wrongOptionIds'] or diagnostic['missingOptionIds']:
        raise ValueError('model-course-quiz-forbidden')
    partition = [ident for key in POINT_KEYS for ident in diagnostic[key]]
    if not _same_set(partition, [point['id'] for point in task['criteria']]):
        raise ValueError('invalid-course-point-partition')
    covered = {row['pointId'] for row in diagnostic['pointEvidence']}
    if any(ident not in covered for key in ('matchedPointIds', 'errorPointIds') for ident in diagnostic[key]):
        raise ValueError('missing-course-point-evidence')
    for evidence in diagnostic['pointEvidence']:
        point = next((row for row in task['criteria'] if row['id'] == evidence['pointId']), None)
        source = next((row for row in task['sources'] if row['sourceId'] == evidence['sourceId']), None)
        if (point is None or evidence['sourceId'] not in point['sourceIds'] or source is None
                or evidence['sourceQuote'] not in source['excerpt'] or evidence['answerQuote'] not in answer):
            raise ValueError('invalid-course-quote-binding')
    gaps = len(diagnostic['errorPointIds']) + len(diagnostic['missedPointIds'])
    mandatory_missing = any(point.get('mandatory') and point['id'] in diagnostic['missedPointIds']
                            for point in task['criteria'])
    if ((diagnostic['status'] == 'correct' and (diagnostic['errorPointIds'] or mandatory_missing))
            or (diagnostic['status'] == 'partial' and (not diagnostic['matchedPointIds'] or not gaps))
            or (diagnostic['status'] == 'incorrect' and not gaps)):
        raise ValueError('inconsistent-course-diagnostic-status')
    return diagnostic


def deterministic_course_diagnostic(task, answer_json):
    if (task['mode'] != 'quiz' or 'options' not in task or 'correctOptionIds' not in task
            or not task.get('selection')):
        raise ValueError('course-quiz-task-required')
    study_text(answer_json, 'course-quiz-answer', 32000)
    try:
        raw = json.loads(answer_json)
    except (ValueError, TypeError):
        raise ValueError('invalid-course-quiz-answer') from None
    selected = _ids(raw, 32)
    known = {option['optionId'] for option in task['options']}
    if any(ident not in known for ident in selected) or task['selection'] == 'single' and len(selected) > 1:
        raise ValueError('invalid-course-quiz-selection')
    correct = task['correctOptionIds']
    wrong = [option['optionId'] for option in task['options']
             if option['optionId'] in selected and option['optionId'] not in correct]
    missing = [ident for ident in correct if ident not in selected]
    matched = any(ident in correct for ident in selected)
    status = 'correct' if not wrong and not missing else 'partial' if matched and not wrong else 'incorrect'
    explanations = [option['explanation'] for option in task['options'] if option['optionId'] in wrong + missing]
    # JavaScript slice counts UTF-16 units, including a possible trailing surrogate.
    feedback = ('\n'.join(explanations).encode('utf-16-le', errors='surrogatepass')[:8000]
                .decode('utf-16-le', errors='surrogatepass')) if explanations else '原选项核对正确。'
    return {'schemaVersion': 1, 'status': status, 'source': 'deterministic', 'feedback': feedback,
            'matchedPointIds': [], 'missedPointIds': [], 'errorPointIds': [],
            'wrongOptionIds': wrong, 'missingOptionIds': missing, 'pointEvidence': []}


def course_diagnostic_outcome(diagnostic):
    if diagnostic['status'] == 'undetermined':
        return {'status': 'undetermined', 'source': 'model', 'explanation': diagnostic['feedback']}
    return {'status': diagnostic['status'], 'source': diagnostic['source'],
            'explanation': diagnostic['feedback'], 'rating': RATINGS[diagnostic['status']]}


def attempt_evaluation_for_diagnostic(diagnostic, content_hash):
    study_digest(content_hash)
    if diagnostic['status'] == 'undetermined':
        reason = diagnostic['reason']
        mapped = 'offline' if reason == 'offline' else 'no-reference' if reason in (
            'source-insufficient', 'source-conflict') else 'invalid'
        return {'status': 'pending', 'reason': mapped, 'feedback': diagnostic['feedback']}
    return {'status': 'resolved', 'rating': RATINGS[diagnostic['status']],
            'correct': diagnostic['status'] == 'correct', 'outcome': diagnostic['status'],
            'source': diagnostic['source'], 'feedback': diagnostic['feedback'],
            'evaluationHash': '', 'referenceHash': content_hash}


def course_diagnostic_hash(diagnostic, trace):
    return study_hash({'diagnostic': diagnostic, 'trace': trace})


def choose_course_remediation(support, diagnostic):
    """Choose one authored mapping in criterion/option order; invent no task."""
    if (support['task']['reviewStatus'] != 'verified' or diagnostic['status'] in ('undetermined', 'correct')
            or diagnostic['source'] not in ('model', 'deterministic')):
        return None
    gaps = set(diagnostic['missedPointIds'] + diagnostic['errorPointIds'])
    priorities = [point for point in support['criteria'] if point.get('mandatory')
                  and point['id'] in diagnostic['missedPointIds']]
    priorities += [point for point in support['criteria'] if point['id'] in diagnostic['errorPointIds']]
    priorities += [point for point in support['criteria'] if point['id'] in gaps]
    for point in priorities:
        child = next((row for row in support['task']['remediations']
                      if point['id'] in row['targetPointIds']), None)
        if child is not None:
            return copy.deepcopy(child)
    if support['type'] == 'quiz':
        for option in support['options']:
            ident = option['optionId']
            child = next((row for row in support['task']['remediations']
                          if (ident in diagnostic['wrongOptionIds'] and ident in row['wrongOptionIds'])
                          or (ident in diagnostic['missingOptionIds'] and ident in row['missingOptionIds'])), None)
            if child is not None:
                return copy.deepcopy(child)
    return None
