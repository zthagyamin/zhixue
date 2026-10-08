"""Closed math intents. Native signatures remain native, not portable item hashes."""
from __future__ import annotations
import copy
from account_sync_schema import study_object, study_size, study_id, study_digest, study_text
from native_course_schema import identity_binding, integer, iso_time
from learning_support import parse_learning_support, trim_contract_text


def normalize_source_item(item, identity, subject, support=None):
    if item.get('word'):
        raise ValueError('native-math-word-unsupported')
    practice = item.get('practiceItem') or item
    mode = practice.get('questionType') or item.get('pluginType') or subject.get('pluginType')
    if mode != 'calculation':
        raise ValueError('native-math-calculation-required')
    for key in ('prompt', 'answer', 'learningSupport'):
        if practice is not item and key in item and key in practice and item[key] != practice[key]:
            raise ValueError('native-math-reference-conflict')
    question = study_text(practice.get('prompt'), 'math-question', 4000)
    answer = study_text(practice.get('answer'), 'math-reference', 512)
    label = study_text(practice.get('sourceLabel') or item.get('topic') or subject.get('name') or '来源数学题', 'math-source-label', 200)
    body = {'questionType': 'calculation', 'prompt': question, 'answer': answer,
            'sourceLabel': label, 'domain': practice.get('domain') or item.get('domain') or subject.get('domain') or 'math'}
    study_text(body['domain'], 'math-domain', 100)
    explanation = practice.get('explanation') or item.get('explanation')
    if explanation:
        body['explanation'] = study_text(explanation, 'math-explanation', 4000)
    support = support if support is not None else item.get('learningSupport', practice.get('learningSupport'))
    result = {'schemaVersion': 2, 'kind': 'practice', 'eventKind': 'due', 'itemKey': identity['itemKey'],
              'contentHash': identity['contentHash'], 'practice': body}
    if support is not None:
        study_size(support, 16000)
        result['learningSupport'] = parse_learning_support(support, 'calculation')
    return copy.deepcopy(result)


def parse_source_request(payload, action):
    row = study_object(payload, ('schemaVersion', 'identity') + (('captureId',) if action == 'read' else ()))
    integer(row['schemaVersion'], 1, 1)
    if action not in ('capture', 'read'):
        raise ValueError('invalid-math-source-action')
    if action == 'read':
        study_digest(row['captureId'])
    return copy.deepcopy(row)


def parse_claim(payload):
    study_size(payload, 150000)
    row = study_object(payload, ('schemaVersion', 'identity', 'captureId', 'attempt'), ('stepInput', 'variant'))
    integer(row['schemaVersion'], 1, 1)
    study_digest(row['captureId'])
    attempt = study_object(row['attempt'], ('schemaVersion', 'attemptId', 'binding', 'parentAttemptId', 'revision',
        'answerRevision', 'answer', 'updatedAt', 'checkpoint', 'submitted', 'evaluation', 'formal', 'operations'), ('startedAt',))
    integer(attempt['schemaVersion'], 1, 1)
    binding, identity = identity_binding(attempt['binding'], row['identity'])
    study_id(attempt['attemptId'], 'math-attempt-id')
    for key in ('revision', 'answerRevision'):
        integer(attempt[key])
    study_text(attempt['answer'], 'math-answer', 32000, True)
    iso_time(attempt['updatedAt'])
    if 'startedAt' in attempt:
        iso_time(attempt['startedAt'])
    checkpoint = attempt['checkpoint']
    if type(checkpoint) is not dict or checkpoint.get('mode') != 'calculation' or checkpoint.get('purpose', 'first') not in ('first', 'guided', 'remediation'):
        raise ValueError('native-math-checkpoint-invalid')
    purpose = checkpoint.get('purpose', 'first')
    if attempt['parentAttemptId'] is not None:
        study_id(attempt['parentAttemptId'], 'math-parent-id')
        if purpose != 'remediation' or attempt['parentAttemptId'] == attempt['attemptId']:
            raise ValueError('native-math-parent-invalid')
    submitted = study_object(attempt['submitted'], ('answer', 'answerRevision', 'submittedAt', 'assistance'), ('maxPreHintLevel', 'answerRevealed'))
    study_text(submitted['answer'], 'math-answer', 32000, True)
    integer(submitted['answerRevision'])
    if submitted['answerRevision'] != attempt['answerRevision'] or submitted['answer'] != attempt['answer']:
        raise ValueError('native-math-answer-revision-conflict')
    iso_time(submitted['submittedAt'])
    if submitted['assistance'] not in ('independent', 'observed', 'unknown'):
        raise ValueError('native-math-assistance-invalid')
    if 'maxPreHintLevel' in submitted:
        integer(submitted['maxPreHintLevel'], 0, 3)
    if 'answerRevealed' in submitted and type(submitted['answerRevealed']) is not bool:
        raise ValueError('native-math-assistance-invalid')
    if attempt['formal'] is not None:
        raise ValueError('native-math-formal-must-use-barrier')
    if type(attempt['evaluation']) is not dict or attempt['evaluation'].get('status') not in ('pending', 'resolved') or type(attempt['operations']) is not list:
        raise ValueError('native-math-attempt-invalid')
    if 'stepInput' in row:
        step = study_object(row['stepInput'], ('text', 'revision', 'answerRevision'))
        study_text(step['text'], 'math-step-text', 32000, True)
        integer(step['revision'], 1)
        integer(step['answerRevision'])
        if step['answerRevision'] != submitted['answerRevision']:
            raise ValueError('native-math-step-revision-conflict')
    if 'variant' in row:
        if purpose!='remediation' or attempt['parentAttemptId'] is None:
            raise ValueError('native-math-variant-remediation-required')
        variant=parse_variant_descriptor(row['variant'],identity)
        row={**row,'variant':variant}
    return copy.deepcopy({**row, 'identity': identity, 'attempt': {**attempt, 'binding': binding}})


def logical_claim(row):
    attempt = row['attempt']
    return {**{key: row[key] for key in ('schemaVersion', 'identity', 'captureId')},
            'attempt': {key: attempt[key] for key in ('schemaVersion', 'attemptId', 'binding', 'parentAttemptId', 'submitted')},
            'purpose': attempt['checkpoint'].get('purpose', 'first'), **({'stepInput': row['stepInput']} if 'stepInput' in row else {}),
            **({'variant': row['variant']} if 'variant' in row else {})}


def parse_evaluate(payload):
    study_size(payload, 5000)
    row = study_object(payload, ('schemaVersion', 'requestId', 'attemptId', 'answerRevision', 'sourceVersion', 'mode'), ('stepRevision',))
    integer(row['schemaVersion'], 1, 1)
    for key in ('requestId', 'attemptId'):
        study_id(row[key], 'math-' + key)
    integer(row['answerRevision'])
    study_digest(row['sourceVersion'])
    if row['mode'] not in ('final', 'step'):
        raise ValueError('invalid-math-evaluation-mode')
    if 'stepRevision' in row:
        integer(row['stepRevision'], 1)
    return copy.deepcopy(row)


def parse_formal(payload):
    row = study_object(payload, ('schemaVersion', 'action', 'attemptId', 'answerRevision', 'sourceVersion', 'eventId', 'evaluationHash', 'occurredAt'), ('coreHash',))
    integer(row['schemaVersion'], 1, 1)
    if row['action'] != 'formal':
        raise ValueError('invalid-math-claim-action')
    for key in ('attemptId', 'eventId'):
        study_id(row[key], key)
    integer(row['answerRevision'])
    for key in ('sourceVersion', 'evaluationHash'):
        study_digest(row[key])
    if 'coreHash' in row:
        study_digest(row['coreHash'])
    iso_time(row['occurredAt'])
    return copy.deepcopy(row)


def parse_read(payload):
    row=study_object(payload,('schemaVersion','attemptId'),('requestId',))
    integer(row['schemaVersion'],1,1)
    study_id(row['attemptId'],'math-attempt-id')
    if 'requestId' in row:
        study_id(row['requestId'],'math-request-id')
    return copy.deepcopy(row)


def native_math_rules():
    from application.native_math import NativeMathRules
    from calculation_grade import grade_calculation_reference
    from calculation_step import grade_calculation_step
    from infrastructure.math_step_provider import diagnose_semantic_step
    return NativeMathRules(parse_claim,parse_evaluate,parse_source_request,parse_read,
                           grade_calculation_reference,grade_calculation_step,diagnose_semantic_step,
                           lambda text: bool(trim_contract_text(text)))


def parse_variant_descriptor(raw,identity):
    row=study_object(raw,('schemaVersion','mappingId','parentItemKey','parentContentHash','hashKind','templateVersion','templateId','seed','parameters','variantHash'))
    integer(row['schemaVersion'],1,1)
    integer(row['templateVersion'],1,1)
    integer(row['seed'],0,4294967295)
    study_id(row['mappingId'],'math-mapping-id')
    study_digest(row['variantHash'])
    if row['parentItemKey']!=identity['itemKey'] or row['parentContentHash']!=identity['contentHash'] or row['hashKind']!='content':
        raise ValueError('native-math-variant-parent-conflict')
    ranges={'cancel-domain':{'k':(-8,8),'nonzero':(0,1)},'sqrt-sign':{'x':(-9,9)},
            'context-linear':{'rate':(1,8),'baseline':(0,12),'target':(12,40)},'inverse-linear':{'x':(-8,8),'b':(-12,12),'y':(-20,20)}}
    if row['templateId'] not in ranges:
        raise ValueError('native-math-variant-template-unavailable')
    limits=ranges[row['templateId']]
    values=study_object(row['parameters'],tuple(limits))
    for key,(lo,hi) in limits.items():
        integer(values[key],lo,hi)
    if row['templateId']=='context-linear' and values['target']<values['baseline']:
        raise ValueError('native-math-variant-parameters-invalid')
    return copy.deepcopy(row)


def parse_mapping(raw):
    row=study_object(raw,('schemaVersion','mappingId','parentItemKey','parentContentHash','hashKind','templateVersion','templateId','sourceConditions','parameters'))
    integer(row['schemaVersion'],1,1)
    integer(row['templateVersion'],1,1)
    from learning_support import _contract_text, _normalized_calculation_text, _calculation_identifier
    _calculation_identifier(row['mappingId'])
    _contract_text(row['parentItemKey'],1000,controls=True)
    study_digest(row['parentContentHash'])
    if row['hashKind']!='content':
        raise ValueError('native-math-mapping-content-required')
    if type(row['sourceConditions']) is not list or not 1 <= len(row['sourceConditions']) <= 8:
        raise ValueError('native-math-mapping-conditions-required')
    conditions=[_normalized_calculation_text(_contract_text(x,300,controls=True)) for x in row['sourceConditions']]
    if len(set(conditions))!=len(conditions):
        raise ValueError('native-math-mapping-conditions-invalid')
    # The existing closed descriptor parser validates the same exact templates.
    descriptor={k:v for k,v in row.items() if k!='sourceConditions'}
    parse_variant_descriptor({**descriptor,'seed':0,'variantHash':'0'*64},
        {'itemKey':row['parentItemKey'],'contentHash':row['parentContentHash']})
    return copy.deepcopy(row)


def parse_preparation(raw):
    row=study_object(raw,('schemaVersion','snapshotId','mapping','review'))
    integer(row['schemaVersion'],1,1)
    if row['snapshotId']!='local':
        raise ValueError('native-math-mapping-snapshot-invalid')
    parse_mapping(row['mapping'])
    review=study_object(row['review'],('sourceQuote','rationale'))
    study_text(review['sourceQuote'],'math-source-quote',1000)
    rationale=study_text(review['rationale'],'math-review-rationale',2000).strip()
    if len(rationale)<20 or rationale==review['sourceQuote'].strip():
        raise ValueError('native-math-mapping-review-required')
    return copy.deepcopy(row)


def parse_mapping_request(payload,action):
    study_size(payload,20000)
    if action not in ('publish','read'):
        raise ValueError('native-math-mapping-action-invalid')
    row=study_object(payload,('schemaVersion','identity','captureId')+(('preparation',) if action=='publish' else ()))
    integer(row['schemaVersion'],1,1)
    study_digest(row['captureId'])
    if action=='publish':
        parse_preparation(row['preparation'])
    return copy.deepcopy(row)


def parse_variant_request(payload):
    row=study_object(payload,('schemaVersion','identity','captureId','attemptId','seed'))
    integer(row['schemaVersion'],1,1)
    integer(row['seed'],0,4294967295)
    study_digest(row['captureId'])
    study_id(row['attemptId'],'math-parent-id')
    return copy.deepcopy(row)
