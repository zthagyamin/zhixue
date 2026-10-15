"""Grade saved option IDs against the independently captured reference."""
from __future__ import annotations

import json


def grade_source_choice(item, answer, *, parse_support):
    unknown = {'correct': None, 'verdict': 'unknown', 'source': 'deterministic'}
    support = item.get('learningSupport')
    if support is not None:
        try:
            support = parse_support(support)
        except (ValueError, KeyError, TypeError):
            return unknown
        if support['schemaVersion'] != 1:
            return unknown  # V2 uses the dedicated task/diagnostic application.
        ids = [option['optionId'] for option in support['options']]
        correct = support['correctOptionIds']
        mode = support['selection']
    else:
        options = item.get('options')
        expected = item.get('answer')
        if (not isinstance(options, list) or len(options) < 2
                or any(type(value) is not str for value in options)
                or len(set(options)) != len(options)):
            return unknown
        if isinstance(expected, str) and expected in options:
            expected = options.index(expected)
        if type(expected) is not int or not 0 <= expected < len(options):
            return unknown
        ids = [f'option-{index}' for index in range(len(options))]
        correct, mode = [ids[expected]], 'single'
        if isinstance(answer, str) and answer in options:
            answer = [ids[options.index(answer)]]
        elif type(answer) is int and 0 <= answer < len(options):
            answer = [ids[answer]]
    if isinstance(answer, str):
        try:
            answer = json.loads(answer)
        except (ValueError, TypeError):
            return unknown
    if (type(answer) is not list or not answer or any(type(value) is not str or value not in ids for value in answer)
            or len(set(answer)) != len(answer) or mode == 'single' and len(answer) != 1):
        return unknown
    matched = [value for value in correct if value in answer]
    missing = [value for value in correct if value not in answer]
    wrong = [value for value in answer if value not in correct]
    verdict = 'correct' if not missing and not wrong else 'partial' if matched and not wrong else 'wrong'
    return {'correct': verdict == 'correct', 'verdict': verdict, 'source': 'deterministic',
            'matchedOptionIds': matched, 'missingOptionIds': missing, 'wrongOptionIds': wrong,
            'explanation': (f"错选：{'、'.join(wrong) or '无'}；漏选：{'、'.join(missing) or '无'}。"
                            + str(item.get('explanation') or ''))}
