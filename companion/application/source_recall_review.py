"""Immutable source-recall input; material checks are injected pure rules."""
from __future__ import annotations

import json
from application.source_admission import parse_submission,parse_binding,canonical_json
from application.code_review import bounded_review_json


def validate_source_recall_reply(value):
    """The older normalizer must not coerce malformed model evidence into a grade."""
    groups=(('feedback','explanation'),('matched_points','matchedPoints'),('missed_points','missedPoints'))
    allowed={'verdict','confidence','matchedPointIds','missedPointIds'}|{field for group in groups for field in group}
    if (type(value) is not dict or set(value)-allowed or type(value.get('verdict')) is not str):
        raise ValueError('recall-review-invalid-diagnostic')
    for index,group in enumerate(groups):
        entries=[value[field] for field in group if field in value]
        if not entries or any(entry!=entries[0] for entry in entries):
            raise ValueError('recall-review-invalid-diagnostic')
        entry=entries[0]
        if index==0:
            if type(entry) is not str or not entry.strip():raise ValueError('recall-review-invalid-diagnostic')
        elif type(entry) is not list or len(entry)>5 or any(type(point) is not str for point in entry):
            raise ValueError('recall-review-invalid-diagnostic')
    if 'confidence' in value and (type(value['confidence']) not in (int,float) or not 0<=value['confidence']<=1):
        raise ValueError('recall-review-invalid-diagnostic')
    return value


def prepare_source_recall_review(attempt, *, material):
    try:
        binding=attempt['submission']['binding']
        scope=(binding['ownerId'],binding['libraryId'])
        submission=parse_submission(attempt['submission'],*scope)
        capture=attempt['capture']
        if capture['status']!='confirmed' or attempt.get('codeReports') or attempt.get('selfAssessment'):
            raise ValueError('recall-review-source-required')
        source=parse_binding(capture['sourceBinding'],*scope)
        if type(submission['answer']) is not str:
            raise ValueError('recall-review-answer-required')
        item=json.loads(canonical_json(capture['descriptor']['item']))
        if item.get('questionType')!='recall':
            raise ValueError('recall-review-source-type')
        model_item=material(item)
        data={**json.loads(canonical_json(submission)),'sourceBinding':source,'item':item,'modelItem':model_item}
        bounded_review_json(data)
        return data
    except (KeyError,TypeError,ValueError,UnicodeError,OverflowError,RecursionError) as error:
        reason=str(error)
        raise ValueError(reason if reason.startswith('recall-review-') else 'recall-review-invalid-material') from None
