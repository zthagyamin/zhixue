"""Closed native course intents. Client fields never supply grading references."""
from __future__ import annotations

import copy
import re
from datetime import datetime
from account_sync_schema import study_digest, study_id, study_object, study_size, study_text, study_hash
from course_study_domain import (
    ALIGNMENT_KEYS, RATINGS, attempt_evaluation_for_diagnostic, choose_course_remediation,
    course_identifier, course_diagnostic_hash, course_task_hash, deterministic_course_diagnostic,
    parse_course_evaluation_trace, resolve_course_support_v2, resolve_course_task,
    validate_course_diagnostic,
)

BINDING_KEYS = ('ownerId', 'libraryId', 'snapshotId', 'itemKey', 'contentHash', 'groupId', 'roundId')
IDENTITY_KEYS = ('schemaVersion', 'libraryId', 'itemKey', 'contentHash', 'localBindingHash')
GRADE_KEYS = ('schemaVersion', 'action', 'requestId', 'binding', 'identity', 'captureId',
              'attemptId', 'purpose', 'parentAttemptId', 'parentDiagnosticHash', 'taskId',
              'taskHash', 'submission')
CLAIM_KEYS = ('schemaVersion', 'binding', 'identity', 'captureId', 'attemptId',
              'diagnosticHash', 'attemptEvaluationHash', 'eventId', 'occurredAt', 'rating')


def integer(value, minimum=0, maximum=9007199254740991):
    if (type(value) not in (int, float) or not minimum <= value <= maximum
            or value != int(value)):
        raise ValueError('invalid-native-course-integer')
    return int(value)


def iso_time(value):
    study_text(value, 'native-course-time', 40)
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value):
        raise ValueError('invalid-native-course-time')
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('invalid-native-course-time') from None
    return value


def identity_binding(binding, identity):
    binding = study_object(binding, BINDING_KEYS)
    identity = copy.deepcopy(study_object(identity, IDENTITY_KEYS))
    identity['schemaVersion'] = integer(identity['schemaVersion'], 1, 1)
    for key in ('ownerId', 'libraryId', 'snapshotId', 'itemKey', 'groupId', 'roundId'):
        study_id(binding[key], key)
    for key in ('libraryId', 'itemKey'):
        study_id(identity[key], key)
    for key in ('contentHash', 'localBindingHash'):
        study_digest(identity[key])
    study_digest(binding['contentHash'])
    if (binding['snapshotId'] != 'local' or not identity['itemKey'].startswith('practice:')
            or any(binding[key] != identity[key] for key in ('libraryId', 'itemKey', 'contentHash'))):
        raise ValueError('native-course-binding-mismatch')
    return copy.deepcopy(binding), copy.deepcopy(identity)


def parse_grade_request(payload):
    study_size(payload, 100000)
    self_assess = type(payload) is dict and payload.get('action') == 'self-assess'
    row = copy.deepcopy(study_object(payload, GRADE_KEYS + (('selfStatus',) if self_assess else ())))
    row['schemaVersion'] = integer(row['schemaVersion'], 1, 1)
    if row['action'] not in ('evaluate', 'self-assess'):
        raise ValueError('invalid-native-course-grade')
    binding, identity = identity_binding(row['binding'], row['identity'])
    for key in ('requestId', 'attemptId', 'taskId'):
        course_identifier(row[key], 120)
    for key in ('captureId', 'taskHash'):
        study_digest(row[key])
    if row['purpose'] not in ('first', 'guided', 'remediation'):
        raise ValueError('invalid-native-course-purpose')
    if row['parentAttemptId'] is not None:
        course_identifier(row['parentAttemptId'], 120)
        study_digest(row['parentDiagnosticHash'])
        if row['purpose'] != 'remediation' or row['parentAttemptId'] == row['attemptId']:
            raise ValueError('invalid-native-course-parent')
    elif row['parentDiagnosticHash'] is not None:
        raise ValueError('invalid-native-course-parent')
    submission = study_object(row['submission'], ('answer', 'answerRevision', 'submittedAt', 'assistance'),
                              ('maxPreHintLevel', 'answerRevealed'))
    study_text(submission['answer'], 'native-course-answer', 32000, True)
    submission['answerRevision'] = integer(submission['answerRevision'])
    iso_time(submission['submittedAt'])
    if submission['assistance'] not in ('independent', 'observed', 'unknown'):
        raise ValueError('invalid-native-course-assistance')
    if 'maxPreHintLevel' in submission:
        submission['maxPreHintLevel'] = integer(submission['maxPreHintLevel'], 0, 3)
    if 'answerRevealed' in submission and type(submission['answerRevealed']) is not bool:
        raise ValueError('invalid-native-course-reveal')
    if self_assess and row['selfStatus'] not in ('correct', 'partial', 'incorrect'):
        raise ValueError('invalid-native-course-self-status')
    return copy.deepcopy({**row, 'binding': binding, 'identity': identity, 'submission': submission})


def parse_claim_request(payload):
    study_size(payload, 12000)
    row = copy.deepcopy(study_object(payload, CLAIM_KEYS))
    row['schemaVersion'] = integer(row['schemaVersion'], 1, 1)
    binding, identity = identity_binding(row['binding'], row['identity'])
    for key in ('attemptId', 'eventId'):
        course_identifier(row[key], 120)
    for key in ('captureId', 'diagnosticHash', 'attemptEvaluationHash'):
        study_digest(row[key])
    iso_time(row['occurredAt'])
    if row['rating'] not in ('again', 'hard', 'good', 'easy'):
        raise ValueError('invalid-native-course-rating')
    return copy.deepcopy({**row, 'binding': binding, 'identity': identity})


def logical_attempt_body(request):
    return {key: copy.deepcopy(value) for key, value in request.items()
            if key not in ('action', 'requestId', 'selfStatus')}


def unknown(reason, feedback='课程评价尚未确定，请保留原答案。'):
    return {'schemaVersion': 1, 'status': 'undetermined', 'source': 'none',
            'feedback': feedback, **{key: [] for key in ALIGNMENT_KEYS},
            'pointEvidence': [], 'reason': reason}


def make_receipt(request, diagnostic, trace, remediation_id=None):
    evaluation = attempt_evaluation_for_diagnostic(diagnostic, request['identity']['contentHash'])
    evaluation_hash = None if evaluation['status'] == 'pending' else study_hash(
        {key: value for key, value in evaluation.items() if key != 'evaluationHash'})
    body = {'schemaVersion': 1, 'durable': True, 'requestId': request['requestId'],
            'originRequestId': request['requestId'],
            **{key: request[key] for key in ('binding', 'identity', 'captureId', 'attemptId',
                'purpose', 'parentAttemptId', 'parentDiagnosticHash', 'taskId', 'taskHash')},
            'answerRevision': request['submission']['answerRevision'], 'diagnostic': diagnostic,
            'trace': trace, 'diagnosticHash': course_diagnostic_hash(diagnostic, trace),
            'attemptEvaluationHash': evaluation_hash, 'remediationTaskId': remediation_id}
    return {**body, 'receiptHash': study_hash(body)}


def native_course_rules():
    from application.native_course import NativeCourseRules
    return NativeCourseRules(
        parse_grade=parse_grade_request, parse_claim=parse_claim_request,
        resolve_support=resolve_course_support_v2, resolve_task=resolve_course_task,
        task_hash=course_task_hash, choose_remediation=choose_course_remediation,
        validate_diagnostic=validate_course_diagnostic, parse_trace=parse_course_evaluation_trace,
        deterministic_diagnostic=deterministic_course_diagnostic, receipt=make_receipt,
        unknown=unknown, maximum_rating=lambda status: RATINGS[status],
    )
