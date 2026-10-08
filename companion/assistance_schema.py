"""Behavior-only auxiliary evidence. No scoring, state projection or I/O."""
from __future__ import annotations
import copy
from account_sync_schema import study_object, study_id, study_digest, study_count, study_size, study_hash, _practice_core, validate_record

ACTIONS = ('meaning-check', 'meaning-study', 'reference-answer', 'ai-hint', 'ai-tutor', 'answer-feedback')
MODES = ('three-stage', 'quiz', 'recall', 'calculation', 'code', 'flashcard', 'spelling')
MAX_BYTES = 4096


def _counts(raw, pre):
    if type(raw) is not list or len(raw) > len(ACTIONS):
        raise ValueError('invalid-assistance-counts')
    result, seen = [], set()
    for value in raw:
        row = study_object(value, ['action', 'count'])
        action = row['action']
        if type(action) is not str or action not in ACTIONS or (pre and action == 'answer-feedback'):
            raise ValueError('invalid-assistance-action')
        if action in seen:
            raise ValueError('duplicate-assistance-action')
        seen.add(action)
        count = study_count(row['count'], 'assistance-count', 1)
        if count > 10000:
            raise ValueError('invalid-assistance-count')
        result.append(dict(action=action, count=count))
    return sorted(result, key=lambda row: ACTIONS.index(row['action']))


def _body(raw, sealed):
    study_size(raw, MAX_BYTES)
    obj = study_object(raw, ['schemaVersion', 'attemptEventId', 'attemptCoreHash', 'practiceMode', 'observationScope', 'preSubmitAssistance', 'postSubmitFeedback'],
                       ['recallPolicy'] + (['summaryId', 'summaryHash'] if sealed else []))
    if study_count(obj['schemaVersion'], 'assistance-version') not in (1,2) or obj['schemaVersion']==1 and 'recallPolicy' in obj or obj['schemaVersion']==2 and 'recallPolicy' not in obj:
        raise ValueError('unsupported-assistance-version')
    policy=None
    if obj['schemaVersion']==2:
        from learning_support import parse_recall_policy
        policy=parse_recall_policy(obj['recallPolicy'])
        if obj['practiceMode']!='recall':raise ValueError('invalid-recall-policy-mode')
    study_id(obj['attemptEventId'], 'assistance-attempt'); study_digest(obj['attemptCoreHash'])
    if type(obj['practiceMode']) is not str or obj['practiceMode'] not in MODES:
        raise ValueError('invalid-assistance-mode')
    if obj['observationScope'] != 'current-page-attempt':
        raise ValueError('invalid-assistance-scope')
    if sealed:
        study_id(obj.get('summaryId'), 'assistance-identifier'); study_digest(obj.get('summaryHash'))
    return dict(schemaVersion=obj['schemaVersion'], **({'recallPolicy':policy} if policy else {}), attemptEventId=obj['attemptEventId'], attemptCoreHash=obj['attemptCoreHash'], practiceMode=obj['practiceMode'],
                observationScope='current-page-attempt', preSubmitAssistance=_counts(obj['preSubmitAssistance'], True), postSubmitFeedback=_counts(obj['postSubmitFeedback'], False))


def _identifier(body):
    return 'assistance:' + study_hash([body['schemaVersion'], body['attemptEventId'], body['attemptCoreHash']])


def seal_summary(raw):
    body = _body(raw, False)
    body['summaryId'] = _identifier(body)
    result = dict(body, summaryHash=study_hash(body)); study_size(result, MAX_BYTES)
    return result


def validate_summary(raw):
    body = _body(raw, True)
    if raw['summaryId'] != _identifier(body):
        raise ValueError('invalid-assistance-identifier')
    body['summaryId'] = raw['summaryId']
    if raw['summaryHash'] != study_hash(body):
        raise ValueError('assistance-summary-integrity')
    return dict(body, summaryHash=raw['summaryHash'])


def validate_parent(raw, parent, known_mode):
    summary = validate_summary(raw)
    event = copy.deepcopy(parent)
    # This optional device projection is outside the immutable V3 core.
    if type(event) is dict and type(event.get('scheduling')) is dict:
        event['scheduling'].pop('clientStateAfter', None)
    _practice_core(event)
    if event['eventId'] != summary['attemptEventId'] or event['coreHash'] != summary['attemptCoreHash']:
        raise ValueError('assistance-parent-binding')
    if summary['practiceMode'] != known_mode:
        raise ValueError('assistance-parent-mode')
    if summary.get('recallPolicy') and summary['recallPolicy']['appliedRating']!=event['attempt']['rating']:raise ValueError('recall-policy-parent-rating')
    return summary


def validate_native_binding(raw):
    obj = study_object(raw, ['schemaVersion', 'eventId', 'coreHash', 'contentHash', 'localBindingHash', 'practiceMode'])
    if study_count(obj['schemaVersion'], 'native-binding-version') != 1:
        raise ValueError('unsupported-native-binding-version')
    study_id(obj['eventId'], 'event')
    for key in ('coreHash', 'contentHash', 'localBindingHash'):
        study_digest(obj[key])
    if type(obj['practiceMode']) is not str or obj['practiceMode'] not in MODES:
        raise ValueError('invalid-native-binding-mode')
    return copy.deepcopy(obj)


def seal_account_assistance(raw_parent, raw_summary):
    parent = validate_record(raw_parent)
    if parent['provenanceMode'] == 'task':
        raise ValueError('assistance-requires-practice')
    summary = validate_parent(raw_summary, parent['event'], parent['practiceMode'])
    body = dict(schemaVersion=1, libraryId=parent['libraryId'], attemptEnvelopeHash=parent['envelopeHash'], summary=summary)
    return dict(body, associationHash=study_hash(body))


def validate_account_assistance(raw, parent=None):
    study_size(raw, 8192)
    obj = study_object(raw, ['schemaVersion', 'libraryId', 'attemptEnvelopeHash', 'summary', 'associationHash'])
    if study_count(obj['schemaVersion'], 'assistance-version') != 1:
        raise ValueError('unsupported-assistance-version')
    study_id(obj['libraryId'], 'library'); study_digest(obj['attemptEnvelopeHash']); study_digest(obj['associationHash'])
    body = dict(schemaVersion=1, libraryId=obj['libraryId'], attemptEnvelopeHash=obj['attemptEnvelopeHash'], summary=validate_summary(obj['summary']))
    if study_hash(body) != obj['associationHash']:
        raise ValueError('assistance-association-integrity')
    if parent is not None:
        parent = validate_record(parent)
        if parent['provenanceMode'] == 'task' or parent['libraryId'] != body['libraryId'] or parent['envelopeHash'] != body['attemptEnvelopeHash']:
            raise ValueError('assistance-account-binding')
        validate_parent(body['summary'], parent['event'], parent['practiceMode'])
    return dict(body, associationHash=obj['associationHash'])


def seal_native_assistance(raw_binding, raw_summary):
    binding = validate_native_binding(raw_binding); summary = validate_summary(raw_summary)
    if binding['eventId'] != summary['attemptEventId'] or binding['coreHash'] != summary['attemptCoreHash'] or binding['practiceMode'] != summary['practiceMode']:
        raise ValueError('assistance-native-binding')
    body = dict(schemaVersion=1, binding=binding, summary=summary)
    return dict(body, associationHash=study_hash(body))


def validate_native_assistance(raw):
    study_size(raw, 8192)
    obj = study_object(raw, ['schemaVersion', 'binding', 'summary', 'associationHash'])
    if study_count(obj['schemaVersion'], 'assistance-version') != 1:
        raise ValueError('unsupported-assistance-version')
    study_digest(obj['associationHash']); result = seal_native_assistance(obj['binding'], obj['summary'])
    if result['associationHash'] != obj['associationHash']:
        raise ValueError('assistance-association-integrity')
    return result


def validate_assistance_receipt(raw):
    study_size(raw, 4096)
    obj = study_object(raw, ['schemaVersion', 'receiptId', 'summaryId', 'summaryHash', 'associationHash', 'status'], ['reason', 'proof'])
    if study_count(obj['schemaVersion'], 'assistance-receipt-version') != 1:
        raise ValueError('unsupported-assistance-receipt-version')
    study_id(obj['receiptId'], 'receipt'); study_id(obj['summaryId'], 'summary')
    study_digest(obj['summaryHash']); study_digest(obj['associationHash'])
    if obj['status'] not in ('received', 'blocked', 'applied'):
        raise ValueError('invalid-assistance-receipt-status')
    if obj['status'] == 'applied':
        if not obj.get('proof'):
            raise ValueError('missing-assistance-proof')
        proof = study_object(obj['proof'], ['attemptCoreHash', 'proofHash', 'targetCount'])
        study_digest(proof['attemptCoreHash']); study_digest(proof['proofHash'])
        if study_count(proof['targetCount'], 'assistance-target-count', 2) != 2:
            raise ValueError('invalid-assistance-target-count')
    elif 'proof' in obj:
        raise ValueError('invalid-assistance-proof')
    if obj['status'] == 'blocked':
        if obj.get('reason') not in ('source-changed', 'source-missing', 'mapping-missing', 'dependency-pending', 'write-conflict', 'storage-unavailable', 'writeback-failed', 'baseline-unverified'):
            raise ValueError('invalid-assistance-reason')
    elif 'reason' in obj:
        raise ValueError('invalid-assistance-reason')
    return copy.deepcopy(obj)


def check_assistance_receipt(record, raw):
    receipt = validate_assistance_receipt(raw); summary = record['summary']
    if (receipt['summaryId'] != summary['summaryId'] or receipt['summaryHash'] != summary['summaryHash'] or receipt['associationHash'] != record['associationHash']
            or receipt.get('proof', {}).get('attemptCoreHash', summary['attemptCoreHash']) != summary['attemptCoreHash']):
        raise ValueError('assistance-receipt-binding')
    return receipt
