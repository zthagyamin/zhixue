"""Validation only: long-term forecasts never mutate learning evidence or due dates."""
from copy import deepcopy
from datetime import date, datetime, timedelta
import math
import re

MAX_LONG_TERM_DAYS = 730


def _require(condition, message):
    if not condition:
        raise ValueError('invalid-long-term-plan: ' + message)


def _record(value):
    _require(isinstance(value, dict), 'object')
    return value


def _id(value):
    _require(isinstance(value, str) and value.strip() and len(value) <= 500
             and value not in ('__proto__', 'constructor', 'prototype'), 'id')


def _num(value, maximum=1e9):
    _require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum, 'number')


def _integer(value, maximum=1e9):
    _num(value, maximum)
    _require(value == int(value), 'integer')


def _strings(value):
    _require(isinstance(value, list), 'array')
    for v in value:
        _id(v)


def parse_plan_date(value):
    _require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'date')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError('invalid-long-term-plan: date') from exc


def _timestamp(value):
    _require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z', value), 'timestamp')
    try:
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError('invalid-long-term-plan: timestamp') from exc


def parse_practice_budget_groups(value):
    _require(isinstance(value, list) and len(value) <= 8, 'practice budget groups')
    ids, subjects = set(), set()
    for group in value:
        _record(group)
        _require(set(group) == {'id', 'title', 'subjectIds', 'minutes', 'defaultItemMinutes'}, 'practice budget fields')
        for key in ('id', 'title'):
            _id(group[key])
            _require(not any(ord(c) < 32 or ord(c) == 127 for c in group[key]), 'practice budget text')
        _require(group['id'] not in ids, 'duplicate practice budget')
        ids.add(group['id'])
        _require(isinstance(group['subjectIds'], list) and len(group['subjectIds']) > 0, 'practice budget subjects')
        for subject in group['subjectIds']:
            _id(subject)
            _require(not any(ord(c) < 32 or ord(c) == 127 for c in subject), 'practice budget subject')
            _require(subject not in subjects, 'duplicate practice budget subject')
            subjects.add(subject)
        _integer(group['minutes'], 180)
        _integer(group['defaultItemMinutes'], 30)
        _require(group['defaultItemMinutes'] >= 1, 'practice budget default minutes')
    return deepcopy(value)


def parse_long_term_plan_spec(value):
    s = _record(value)
    _id(s.get('planId'))
    days = (parse_plan_date(s.get('targetDeadline')) - parse_plan_date(s.get('startDate'))).days + 1
    _require(0 < days <= MAX_LONG_TERM_DAYS, 'horizon')
    b = _record(s.get('dailyMinutesBudget'))
    for key in ('workdayMin', 'workdayMax', 'weekendMax'):
        _num(b.get(key), 1440)
    _num(b.get('minReviewRatio'), 1)
    _require(b['workdayMin'] <= b['workdayMax'], 'minimum budget')
    _num(s.get('bufferRatio'), 1)
    if 'timeBudgetMode' in s:
        _require(s['timeBudgetMode'] in ('advisory', 'limit'), 'time budget mode')
    if 'dailyReviewTarget' in s:
        _integer(s['dailyReviewTarget'], 10000)
    if 'practiceBudgetGroups' in s:
        parse_practice_budget_groups(s['practiceBudgetGroups'])
    _require(isinstance(s.get('subjectsConfig'), list), 'subjects')
    ids = set()
    for subject in s['subjectsConfig']:
        _record(subject)
        _id(subject.get('subjectId'))
        _require(subject['subjectId'] not in ids, 'duplicate subject')
        ids.add(subject['subjectId'])
        _integer(subject.get('priority'), 5)
        _require(subject['priority'] >= 1, 'priority')
        if 'dailyQuotaTarget' in subject:
            _integer(subject['dailyQuotaTarget'])
        if 'dailyMinimumTarget' in subject:
            _integer(subject['dailyMinimumTarget'], 10000)
            _require(subject['dailyMinimumTarget'] <= subject.get('dailyQuotaTarget', math.inf), 'minimum exceeds cap')
        if 'requiredRounds' in subject:
            _integer(subject['requiredRounds'], 1000)
            _require(subject['requiredRounds'] > 0, 'rounds')
        if 'forecastRetention' in subject:
            _num(subject['forecastRetention'], .99)
            _require(subject['forecastRetention'] >= .7, 'retention')
        _require(subject.get('completionCriteria') in ('fixed-rounds', 'all-mastered'), 'criteria')
    return deepcopy(s)


def parse_long_term_inventory(value, spec=None):
    _require(isinstance(value, list) and len(value) <= 100000, 'inventory')
    ids = set()
    for item in value:
        _record(item)
        for key in ('itemId', 'sourceHash', 'subjectId'):
            _id(item.get(key))
        _require(item['itemId'] not in ids, 'duplicate item')
        ids.add(item['itemId'])
        _num(item.get('estimatedMinutes'))
        _require(item['estimatedMinutes'] > 0, 'item minutes')
        if 'reviewMinutes' in item:
            _num(item['reviewMinutes'])
            _require(item['reviewMinutes'] > 0, 'review minutes')
        if 'completedRounds' in item:
            _integer(item['completedRounds'])
        if 'mastered' in item:
            _require(type(item['mastered']) is bool, 'mastered')
        if spec:
            _require(any(s['subjectId'] == item['subjectId'] for s in spec['subjectsConfig']), 'unconfigured subject')
    for item in value:
        if 'blockedReason' in item:
            _id(item['blockedReason'])
        if 'prerequisiteItemIds' in item:
            keys = item['prerequisiteItemIds']
            _strings(keys)
            _require(len(set(keys)) == len(keys), 'duplicate prerequisite')
            _require(all(k in ids and k != item['itemId'] for k in keys), 'prerequisite')
    return deepcopy(value)


def parse_long_term_plan_snapshot(value):
    p = _record(value)
    _require(type(p.get('schemaVersion')) is int and p['schemaVersion'] == 1, 'schema version')
    spec = parse_long_term_plan_spec(p.get('spec'))
    inventory = parse_long_term_inventory(p.get('inventory'), spec)
    as_of = parse_plan_date(p.get('asOfDate'))
    _timestamp(p.get('lastRebalancedAt'))
    drift = p.get('activeDriftDays')
    _require(type(drift) in (int, float) and math.isfinite(drift), 'drift')
    _require(type(p.get('totalInventoryCount')) in (int, float) and p['totalInventoryCount'] == len(inventory), 'inventory total')
    start = parse_plan_date(spec['startDate'])
    days = (parse_plan_date(spec['targetDeadline']) - start).days + 1
    _require(type(p.get('estimatedTotalDays')) in (int, float) and p['estimatedTotalDays'] == days, 'days')
    for key in ('excludedItemIds', 'learningCompletedItemIds', 'warnings'):
        _strings(p.get(key))
    by_id = {i['itemId']: i for i in inventory}
    seen = set()

    def take(key):
        _require(key in by_id and key not in seen, 'active item accounting')
        seen.add(key)

    for key in p['learningCompletedItemIds']:
        take(key)
    _require(len(set(p['excludedItemIds'])) == len(p['excludedItemIds']), 'duplicate excluded')
    _require(all(k in p['learningCompletedItemIds'] for k in p['excludedItemIds']), 'excluded acquisition')
    for item in inventory:
        subject = next(s for s in spec['subjectsConfig'] if s['subjectId'] == item['subjectId'])
        completed = bool(item.get('mastered') or item.get('completedRounds', 0) > 0)
        excluded = bool(item.get('mastered') or (subject['completionCriteria'] == 'fixed-rounds'
                        and item.get('completedRounds', 0) >= subject.get('requiredRounds', 1)))
        _require((item['itemId'] in p['learningCompletedItemIds']) == completed, 'completion evidence')
        _require((item['itemId'] in p['excludedItemIds']) == excluded, 'exclusion evidence')
    _require(isinstance(p.get('schedule'), list) and len(p['schedule']) == days, 'schedule')
    for index, slot in enumerate(p['schedule']):
        _record(slot)
        _require(slot.get('date') == (start + timedelta(days=index)).isoformat()
                 and type(slot.get('dayIndex')) in (int, float) and slot['dayIndex'] == index + 1, 'slot date')
        _require(slot.get('phase') in ('learning', 'consolidation', 'final-sprint'), 'phase')
        _require(type(slot.get('isBufferDay')) is bool, 'buffer')
        for key in ('newItemIds', 'reviewItemIds', 'warnings'):
            _strings(slot.get(key))
        sources = _record(slot.get('newItemSourceHashes'))
        _require(len(sources) == len(slot['newItemIds']), 'assignment sources')
        for key in slot['newItemIds']:
            _require(key in sources, 'assignment source')
            _id(sources[key])
        for key in ('expectedNewItems', 'projectedReviews'):
            _record(slot.get(key))
        for key in ('budgetMinutes', 'learningMinutes', 'reviewMinutes', 'reviewReserveMinutes', 'unservedReviewMinutes'):
            _num(slot.get(key))
        if 'timeBudgetMode' in slot:
            _require(slot['timeBudgetMode'] in ('advisory', 'limit'), 'slot budget mode')
        if slot.get('timeBudgetMode') != 'advisory':
            _require(slot['learningMinutes'] + slot['reviewMinutes'] <= slot['budgetMinutes'] + 1e-8, 'capacity')
        if parse_plan_date(slot['date']) >= as_of:
            for key in slot['newItemIds']:
                _require(key in by_id and sources[key] == by_id[key]['sourceHash'], 'active assignment source')
            weekend = parse_plan_date(slot['date']).weekday() >= 5
            budget = spec['dailyMinutesBudget']['weekendMax' if weekend else 'workdayMax']
            _require(slot['budgetMinutes'] == budget and abs(slot['reviewReserveMinutes']
                     - budget * spec['dailyMinutesBudget']['minReviewRatio']) < 1e-8, 'declared budget')
            _require(slot.get('timeBudgetMode', 'limit') == spec.get('timeBudgetMode', 'limit'), 'slot budget policy')
            if spec.get('timeBudgetMode') != 'advisory':
                _require(slot['learningMinutes'] + max(slot['reviewMinutes'], slot['reviewReserveMinutes'])
                         <= budget + 1e-8, 'reserved capacity')
            if slot['isBufferDay']:
                for subject in spec['subjectsConfig']:
                    _require(slot['expectedNewItems'].get(subject['subjectId'], 0) <= subject.get('dailyMinimumTarget', 0), 'buffer learning')
            for key in slot['newItemIds']:
                item = by_id.get(key)
                _require(item is not None and not item.get('blockedReason') and
                         all(k in seen for k in item.get('prerequisiteItemIds', [])), 'learning eligibility')
                take(key)
            _require(len(set(slot['reviewItemIds'])) == len(slot['reviewItemIds']), 'duplicate review')
            for keys_name, counts_name in (('newItemIds', 'expectedNewItems'), ('reviewItemIds', 'projectedReviews')):
                counts = {}
                for key in slot[keys_name]:
                    _require(key in by_id, 'unknown item')
                    subject = by_id[key]['subjectId']
                    counts[subject] = counts.get(subject, 0) + 1
                for count in slot[counts_name].values():
                    _integer(count)
                _require(counts == slot[counts_name], 'counts')
            for subject in spec['subjectsConfig']:
                _require(slot['expectedNewItems'].get(subject['subjectId'], 0)
                         <= subject.get('dailyQuotaTarget', math.inf), 'subject quota')
                if subject.get('dailyMinimumTarget', 0) > slot['expectedNewItems'].get(subject['subjectId'], 0):
                    _require('minimum-shortfall:' + subject['subjectId'] in slot['warnings'], 'minimum shortfall warning')
            remaining = {s['subjectId']: s.get('dailyMinimumTarget', 0) for s in spec['subjectsConfig']}
            minimum_minutes = 0
            for key in slot['newItemIds']:
                item = by_id[key]
                if remaining.get(item['subjectId'], 0) > 0:
                    minimum_minutes += item['estimatedMinutes']
                    remaining[item['subjectId']] -= 1
            if spec.get('timeBudgetMode') == 'advisory':
                _require(slot['learningMinutes'] - minimum_minutes <= max(0, budget - max(slot['reviewMinutes'], slot['reviewReserveMinutes'])) + 1e-8, 'optional estimate capacity')
            _require(abs(sum(by_id[k]['estimatedMinutes'] for k in slot['newItemIds']) - slot['learningMinutes']) < 1e-8, 'learning minutes')
            _require(abs(sum(by_id[k].get('reviewMinutes', 2) for k in slot['reviewItemIds']) - slot['reviewMinutes']) < 1e-8, 'review minutes')
    _require(isinstance(p.get('backlog'), list), 'backlog')
    for item in p['backlog']:
        _record(item)
        _id(item.get('itemId'))
        take(item['itemId'])
        original = by_id[item['itemId']]
        _require(all(item.get(k) == original[k] for k in ('subjectId', 'sourceHash', 'estimatedMinutes')), 'backlog identity')
        _id(item.get('reason'))
    _require(len(seen) == len(inventory), 'missing active items')
    rounds = _record(p.get('remainingRequiredRounds'))
    _require(len(rounds) == len(inventory), 'round coverage')
    for item in inventory:
        _integer(rounds.get(item['itemId']))
        subject = next(s for s in spec['subjectsConfig'] if s['subjectId'] == item['subjectId'])
        _require(rounds[item['itemId']] == max(0, subject.get('requiredRounds', 1) - item.get('completedRounds', 0)), 'round count')
    _require(isinstance(p.get('adjustmentProposals'), list), 'proposals')
    for proposal in p['adjustmentProposals']:
        _record(proposal)
        _require(type(proposal.get('feasible')) is bool, 'proposal feasibility')
        _integer(proposal.get('remainingBacklogCount'))
        _require(not proposal['feasible'] or proposal['remainingBacklogCount'] == 0, 'proposal backlog')
        if proposal.get('kind') == 'extend-deadline':
            end = parse_plan_date(proposal.get('targetDeadline'))
            _require(end > parse_plan_date(spec['targetDeadline']) and (end-start).days < MAX_LONG_TERM_DAYS and 'extraDailyMinutes' not in proposal, 'proposal deadline')
        else:
            _require(proposal.get('kind') == 'increase-budget', 'proposal kind')
            _integer(proposal.get('extraDailyMinutes'), 1440)
            _require(proposal['extraDailyMinutes'] > 0 and 'targetDeadline' not in proposal, 'proposal budget')
    assumptions = _record(p.get('forecastAssumptions'))
    _require(assumptions.get('model') == 'ts-fsrs' and assumptions.get('rating') == 'Good'
             and assumptions.get('enableFuzz') is False and assumptions.get('granularity') == 'daily'
             and assumptions.get('projectionOnly') is True, 'assumptions')
    _num(assumptions.get('requestRetention'), .99)
    _require(assumptions['requestRetention'] >= .7, 'retention')
    if 'requestRetentionBySubject' in assumptions:
        rates = _record(assumptions['requestRetentionBySubject'])
        for key, rate in rates.items():
            _id(key)
            _num(rate, .99)
            _require(rate >= .7, 'retention')
    for subject in spec['subjectsConfig']:
        if 'forecastRetention' in subject:
            _require(assumptions.get('requestRetentionBySubject', {}).get(subject['subjectId']) == subject['forecastRetention'], 'subject retention assumption')
    return deepcopy(p)
