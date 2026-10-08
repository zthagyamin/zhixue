"""Task-plan V2 wire contract. Kept in parity with app/task-plan-types.ts."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import date

CAPABILITY = 'task-planning-v1'
POLICY_CAPABILITY = 'daily-plan-policy-v1'
PRACTICE_BUDGET_CAPABILITY = 'practice-budget-v1'
COMPLETION_RULES = {'three-stage', 'graded-practice', 'self-report', 'formal-mastered', 'formal-done', 'formal-completed-reference'}


def hash_task_plan(plan):
    body = {key: value for key, value in plan.items() if key != 'planHash'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def validate_task_plan_integrity(value):
    plan = validate_task_plan(value)
    if hash_task_plan(plan) != plan['planHash']:
        raise ValueError('invalid-task-plan-hash')
    return plan


def _object(value, required, optional, code):
    if not isinstance(value, dict):
        raise ValueError(f'invalid-{code}')
    if set(value) - set(required) - set(optional):
        raise ValueError(f'unknown-{code}-field')
    if set(required) - set(value):
        raise ValueError(f'missing-{code}-field')
    return value


def _text(value, code):
    if not isinstance(value, str) or not value.strip() or len(value) > 4000 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(code)


def _integer(value, minimum, code):
    if type(value) not in (int, float) or not minimum <= value <= 9007199254740991 or (isinstance(value, float) and (not math.isfinite(value) or not value.is_integer())):
        raise ValueError(code)
    return int(value)


def _strings(value, code, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(code)
    for item in value:
        _text(item, code)
    if len(set(value)) != len(value):
        raise ValueError('duplicate-plan-value')
    return value


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('invalid-plan-hash')


def valid_plan_day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _action(value):
    if not isinstance(value, dict):
        raise ValueError('invalid-task-action')
    kind = value.get('kind')
    if kind == 'practice':
        _object(value, ['kind', 'itemKeys'], [], 'action')
        _strings(value['itemKeys'], 'invalid-task-action', True)
    elif kind == 'open-note':
        _object(value, ['kind', 'contentRef'], [], 'action')
        _text(value['contentRef'], 'invalid-task-action')
    elif kind == 'manual':
        _object(value, ['kind'], [], 'action')
    else:
        raise ValueError('invalid-task-action')


def validate_daily_task(value):
    task = copy.deepcopy(_object(value, ['taskId', 'subjectId', 'title', 'category', 'origin', 'required', 'unitIds', 'quantity', 'action', 'completionRule', 'sourceHash'],
                   ['goalId', 'estimatedMinutes', 'reviewRoundId', 'blockedReason'], 'task'))
    for key in ('taskId', 'subjectId', 'title'):
        _text(task[key], f'invalid-{key}')
    if task['category'] not in ('new-word', 'review', 'subject'):
        raise ValueError('invalid-task-category')
    if task['origin'] not in ('fixed', 'goal', 'ai', 'manual', 'fallback'):
        raise ValueError('invalid-task-origin')
    if type(task['required']) is not bool:
        raise ValueError('invalid-task-required')
    if not isinstance(task['completionRule'], str) or task['completionRule'] not in COMPLETION_RULES:
        raise ValueError('invalid-completion-rule')
    task['quantity'] = _integer(task['quantity'], 1, 'invalid-task-quantity')
    _strings(task['unitIds'], 'invalid-task-units')
    _action(task['action'])
    _hash(task['sourceHash'])
    if task['category'] == 'review' and (task['required'] is not True or not task.get('reviewRoundId')):
        raise ValueError('required-review')
    for key in ('goalId', 'reviewRoundId', 'blockedReason'):
        if key in task:
            _text(task[key], f'invalid-{key}')
    if 'estimatedMinutes' in task:
        task['estimatedMinutes'] = _integer(task['estimatedMinutes'], 0, 'invalid-task-estimate')
    return copy.deepcopy(task)


def validate_long_term_allocation(value):
    v = copy.deepcopy(_object(value, ['schemaVersion','planId','day','vocabularyTarget','items'], ['reviewTarget','budgetMinutes','practiceBudgetGroups'], 'long-term-allocation'))
    if 'practiceBudgetGroups' in v:
        from long_term_plan_schema import parse_practice_budget_groups
        parse_practice_budget_groups(v['practiceBudgetGroups'])
    if v.get('reviewTarget') is not None:
        v['reviewTarget'] = _integer(v['reviewTarget'], 0, 'invalid-long-term-review-target')
        if v['reviewTarget'] > 10000: raise ValueError('invalid-long-term-review-target')
    if 'budgetMinutes' in v:
        v['budgetMinutes'] = _integer(v['budgetMinutes'], 0, 'invalid-long-term-budget')
        if v['budgetMinutes'] > 1440: raise ValueError('invalid-long-term-budget')
    def text(value):
        _text(value, 'invalid-long-term-allocation')
        if len(value)>500 or value in ('__proto__','constructor','prototype'):
            raise ValueError('invalid-long-term-allocation')
    if type(v['schemaVersion']) not in (int,float) or v['schemaVersion'] != 1 or not valid_plan_day(v['day']):
        raise ValueError('invalid-long-term-allocation')
    v['schemaVersion']=1
    text(v['planId']); v['vocabularyTarget']=_integer(v['vocabularyTarget'],0,'invalid-long-term-allocation')
    if not isinstance(v['items'],list): raise ValueError('invalid-long-term-allocation')
    ids=set(); physical=set(); lexemes=set(); count=0
    for i in v['items']:
        _object(i,['itemId','subjectId','kind','itemKeys','unitIds','sourceHash'],['lexemeKey'],'long-term-item')
        text(i['itemId']); text(i['subjectId']); _hash(i['sourceHash'])
        if i['itemId'] in ids or i['kind'] not in ('vocabulary','practice','material'): raise ValueError('invalid-long-term-allocation')
        ids.add(i['itemId'])
        for key in ('itemKeys','unitIds'):
            _strings(i[key],'invalid-long-term-allocation')
            for item in i[key]: text(item)
        if physical.intersection(i['itemKeys']): raise ValueError('invalid-long-term-allocation')
        physical.update(i['itemKeys'])
        if i['kind']=='vocabulary':
            text(i.get('lexemeKey'))
            if i['itemKeys']!=[i['itemId']] or i['unitIds'] or i['lexemeKey'] in lexemes: raise ValueError('invalid-long-term-allocation')
            lexemes.add(i['lexemeKey']); count+=1
        elif 'lexemeKey' in i or (i['kind']=='material' and (i['itemKeys'] or i['unitIds']!=[i['itemId']])) or (i['kind']=='practice' and not i['itemKeys']):
            raise ValueError('invalid-long-term-allocation')
    if count!=v['vocabularyTarget']: raise ValueError('invalid-long-term-allocation')
    return v


def validate_task_plan(value):
    if not isinstance(value, dict) or value.get('schemaVersion') != 2 or type(value.get('schemaVersion')) not in (int, float):
        raise ValueError('unsupported-task-plan-version')
    plan = copy.deepcopy(_object(value, ['schemaVersion', 'day', 'planHash', 'inputHash', 'sourceHash', 'draftVersion', 'tasks', 'vocabulary', 'manual'], ['optionalMinutes', 'longTermAllocation'], 'plan'))
    plan['schemaVersion'] = 2
    if not valid_plan_day(plan['day']):
        raise ValueError('invalid-plan-day')
    for key in ('planHash', 'inputHash', 'sourceHash'):
        _hash(plan[key])
    plan['draftVersion'] = _integer(plan['draftVersion'], 0, 'invalid-draft-version')
    if 'optionalMinutes' in plan:
        plan['optionalMinutes'] = _integer(plan['optionalMinutes'], 0, 'invalid-optional-minutes')
    if not isinstance(plan['tasks'], list):
        raise ValueError('invalid-plan-tasks')
    ids = set()
    for index, value_task in enumerate(plan['tasks']):
        task = validate_daily_task(value_task)
        plan['tasks'][index] = task
        if task['taskId'] in ids:
            raise ValueError('duplicate-task-id')
        ids.add(task['taskId'])
    words = _object(plan['vocabulary'], ['target', 'assignedLexemeKeys'], ['manualSelection', 'snapshot', 'excludedLexemeKeys', 'lockedLexemeKeys', 'lockedItemKeys', 'excludedItemKeys'], 'vocabulary')
    target=20
    if 'longTermAllocation' in plan:
        plan['longTermAllocation']=validate_long_term_allocation(plan['longTermAllocation'])
        if plan['longTermAllocation']['day']!=plan['day']: raise ValueError('invalid-long-term-allocation-day')
        target=plan['longTermAllocation']['vocabularyTarget']
    if type(words['target']) not in (int, float) or words['target'] != target:
        raise ValueError('invalid-new-word-target')
    words['target'] = target
    _strings(words['assignedLexemeKeys'], 'invalid-new-word-assignment')
    if 'excludedLexemeKeys' in words:
        _strings(words['excludedLexemeKeys'], 'invalid-excluded-words')
    if 'lockedLexemeKeys' in words:
        _strings(words['lockedLexemeKeys'], 'invalid-locked-words')
    if 'lockedItemKeys' in words:
        _strings(words['lockedItemKeys'], 'invalid-locked-word-items')
    if 'excludedItemKeys' in words:
        _strings(words['excludedItemKeys'], 'invalid-excluded-word-items')
    if 'manualSelection' in words and type(words['manualSelection']) is not bool:
        raise ValueError('invalid-word-selection-mode')
    if 'snapshot' in words:
        if not isinstance(words['snapshot'], list):
            raise ValueError('invalid-word-snapshot')
        word_ids = set()
        for word in words['snapshot']:
            _object(word, ['itemKey', 'subjectId', 'word', 'language', 'sourceHash', 'completionRule'], ['legacyKeys'], 'word-snapshot')
            for key in ('itemKey', 'subjectId', 'word', 'language'):
                _text(word[key], 'invalid-word-snapshot')
            _hash(word['sourceHash'])
            if word['completionRule'] not in ('three-stage', 'graded-practice'):
                raise ValueError('invalid-word-completion-rule')
            if 'legacyKeys' in word:
                _strings(word['legacyKeys'], 'invalid-word-alias')
            if word['itemKey'] in word_ids:
                raise ValueError('duplicate-word-snapshot')
            word_ids.add(word['itemKey'])
    manual = _object(plan['manual'], ['lockedTaskIds', 'excludedUnitIds'], ['order'], 'manual')
    locks = _strings(manual['lockedTaskIds'], 'invalid-task-lock')
    _strings(manual['excludedUnitIds'], 'invalid-task-exclusion')
    if any(task_id not in ids for task_id in locks):
        raise ValueError('unknown-locked-task')
    if 'order' in manual and any(task_id not in ids for task_id in _strings(manual['order'], 'invalid-task-order')):
        raise ValueError('unknown-ordered-task')
    return copy.deepcopy(plan)
