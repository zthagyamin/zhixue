"""Pure JSON wire parity for the browser CodeRunReportV1; never execute code."""
from __future__ import annotations

import json
import math
import re
from decimal import Decimal

JS_SPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def json_stringify(value):
    """JS JSON.stringify spelling for the contract's size checks."""
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if type(value) in (int, float):
        number = float(value)
        if not number:
            return '0'
        spelling = repr(number).lower()
        if 1e-6 <= abs(number) < 1e21:
            fixed = format(Decimal(spelling), 'f')
            return fixed.rstrip('0').rstrip('.') if '.' in fixed else fixed
        mantissa, exponent = spelling.split('e') if 'e' in spelling else (spelling, '0')
        return mantissa.removesuffix('.0') + 'e' + ('+' if int(exponent) >= 0 else '-') + str(abs(int(exponent)))
    if type(value) is str:
        return re.sub(r'[\ud800-\udfff]', lambda match: '\\u' + format(ord(match[0]), '04x'),
                      json.dumps(value, ensure_ascii=False))
    if type(value) is list:
        return '[' + ','.join(json_stringify(entry) for entry in value) + ']'
    return '{' + ','.join(json_stringify(key) + ':' + json_stringify(entry) for key, entry in value.items()) + '}'


def code_object(raw, required, optional=()):
    if (type(raw) is not dict or any(type(key) is not str for key in raw)
            or set(required) - set(raw) or set(raw) - set(required) - set(optional)):
        raise ValueError('invalid-code-object')
    return raw


def code_text(raw, maximum=128):
    if type(raw) is not str or not raw.strip(JS_SPACE) or utf16_length(raw) > maximum:
        raise ValueError('invalid-code-text')
    return raw


def integer(raw, maximum=9007199254740991, minimum=0):
    if (type(raw) not in (int, float) or not minimum <= raw <= maximum
            or not math.isfinite(raw) or int(raw) != raw):
        raise ValueError('invalid-code-integer')
    return raw


def bounded_code_json(raw):
    nodes = 0
    def visit(value, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 256 or depth > 8:
            raise ValueError('code-json-limit')
        if value is None or type(value) is bool:
            return value
        if type(value) in (int, float):
            try:
                if math.isfinite(float(value)):
                    return value
            except OverflowError:
                pass
        if type(value) is str and utf16_length(value) <= 4000:
            return value
        if type(value) is list and len(value) <= 64:
            return [visit(entry, depth + 1) for entry in value]
        if type(value) is dict:
            if len(value) > 64 or any(type(key) is not str or utf16_length(key) > 128
                                     or key in ('__proto__', 'constructor', 'prototype') for key in value):
                raise ValueError('invalid-code-json-key')
            return {key: visit(entry, depth + 1) for key, entry in value.items()}
        raise ValueError('invalid-code-json')
    result = visit(raw, 0)
    if utf16_length(json_stringify(result)) > 16000:
        raise ValueError('code-json-size')
    return result


def code_json_equal(left, right):
    if type(left) is bool or type(right) is bool:
        return type(left) is bool and type(right) is bool and left == right
    if type(left) in (int, float) and type(right) in (int, float):
        return float(left) == float(right)
    if type(left) != type(right):
        return False
    if type(left) is list:
        return len(left) == len(right) and all(code_json_equal(a, b) for a, b in zip(left, right))
    if type(left) is dict:
        return set(left) == set(right) and all(code_json_equal(left[key], right[key]) for key in left)
    return left == right


def parse_identity(raw):
    row = code_object(raw, ('attemptId', 'revision', 'sourceVersion', 'testVersion'))
    return {'attemptId': code_text(row['attemptId']), 'revision': integer(row['revision']),
            'sourceVersion': code_text(row['sourceVersion']), 'testVersion': code_text(row['testVersion'])}


def parse_failure(raw):
    row = code_object(raw, ('caseId', 'functionName', 'args', 'kwargs', 'expected', 'actual'), ('hint',))
    ident, function = code_text(row['caseId'], 64), code_text(row['functionName'], 64)
    if not re.fullmatch(r'[A-Za-z0-9:_.-]+', ident):
        raise ValueError('invalid-code-case-id')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', function) or function.startswith('__'):
        raise ValueError('invalid-code-function')
    if type(row['args']) is not list or len(row['args']) > 20:
        raise ValueError('invalid-code-args')
    kwargs = row['kwargs']
    if type(kwargs) is not dict or len(kwargs) > 20:
        raise ValueError('invalid-code-kwargs')
    for key in kwargs:
        key = code_text(key, 64)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key.startswith('__'):
            raise ValueError('invalid-code-function')
    result = {'functionName': function, 'args': bounded_code_json(row['args']),
              'kwargs': bounded_code_json(kwargs), 'expected': bounded_code_json(row['expected'])}
    if 'hint' in row:
        result['hint'] = code_text(row['hint'], 2000)
    # The TS failure parser goes through the same normalized one-case support.
    support = {'schemaVersion': 1, 'type': 'code', 'functionNames': [function],
               'cases': [{'id': ident, **result}]}
    if utf16_length(json_stringify(support)) > 100000:
        raise ValueError('code-support-size')
    return {**result, 'caseId': ident, 'actual': bounded_code_json(row['actual'])}


def parse_exception(raw, mapping):
    row = code_object(raw, ('kind', 'message', 'isAssertion'), ('location',))
    kind = code_text(row['kind'], 128)
    if (type(row['message']) is not str or utf16_length(row['message']) > 4000
            or type(row['isAssertion']) is not bool or row['isAssertion'] and kind != 'AssertionError'):
        raise ValueError('invalid-code-exception')
    result = {'kind': kind, 'message': row['message'], 'isAssertion': row['isAssertion']}
    if 'location' in row:
        loc = code_object(row['location'], ('origin', 'file', 'line'), ('originalLine', 'functionName'))
        if loc['origin'] not in ('learner', 'tests', 'preparation'):
            raise ValueError('invalid-code-location')
        location = {'origin': loc['origin'], 'file': code_text(loc['file'], 240),
                    'line': integer(loc['line'], 100010, 1)}
        if 'originalLine' in loc:
            location['originalLine'] = integer(loc['originalLine'], mapping['originalLineCount'], 1)
        if 'functionName' in loc:
            location['functionName'] = code_text(loc['functionName'], 128)
        if (location['file'] != ('<题目测试>' if loc['origin'] == 'tests' else '<learner>')
                or loc['origin'] == 'preparation' and loc['line'] > mapping['prefixLineCount']):
            raise ValueError('invalid-code-location-origin')
        if (loc['origin'] == 'learner' and ('originalLine' not in loc or loc['line'] != loc['originalLine'] + mapping['prefixLineCount'])
                or loc['origin'] != 'learner' and 'originalLine' in loc):
            raise ValueError('invalid-code-line-mapping')
        result['location'] = location
    return result


def parse_code_run_report(raw):
    row = code_object(raw, ('schemaVersion', 'runId', 'status', 'phase', 'outcome', 'assertionsPassed',
                           'assertionsExecuted', 'mapping'), ('identity', 'exception', 'firstFailure'))
    if (type(row['schemaVersion']) not in (int, float) or row['schemaVersion'] != 1
            or row['status'] not in ('passed', 'failed')
            or row['phase'] not in ('preparation', 'test-definition', 'program', 'tests')
            or row['outcome'] not in ('success', 'student-error', 'test-error', 'environment-error', 'unknown')):
        raise ValueError('invalid-code-report')
    passed, executed = integer(row['assertionsPassed'], 1000000), integer(row['assertionsExecuted'], 1000000)
    mapping = code_object(row['mapping'], ('prefixLineCount', 'originalLineCount'))
    mapping = {'prefixLineCount': integer(mapping['prefixLineCount'], 3),
               'originalLineCount': integer(mapping['originalLineCount'], 100001, 1)}
    if (passed > executed or (row['status'] == 'passed') != (row['outcome'] == 'success')
            or row['status'] == 'passed' and ('exception' in row or 'firstFailure' in row)
            or row['status'] == 'failed' and row['phase'] == 'tests' and row['outcome'] == 'student-error'
               and not row.get('exception') and not row.get('firstFailure')
            or row['outcome'] == 'environment-error' and row['phase'] != 'preparation'
            or row['outcome'] == 'test-error' and row['phase'] != 'test-definition'):
        raise ValueError('contradictory-code-report')
    exception = parse_exception(row['exception'], mapping) if 'exception' in row else None
    failure = parse_failure(row['firstFailure']) if 'firstFailure' in row else None
    location = (exception or {}).get('location') or {}
    if (row['outcome'] == 'student-error' and not failure and not
            (location.get('origin') == 'learner' or row['phase'] == 'tests'
             and (exception or {}).get('isAssertion') and location.get('origin') == 'tests')):
        raise ValueError('untrusted-code-attribution')
    if row['outcome'] == 'success' and passed != executed:
        raise ValueError('contradictory-code-count')
    if failure and code_json_equal(failure['expected'], failure['actual']):
        raise ValueError('contradictory-code-values')
    if failure and (row['phase'] != 'tests' or row['outcome'] != 'student-error' or executed != passed + 1):
        raise ValueError('contradictory-code-case')
    if row['outcome'] == 'success' and row['phase'] not in ('program', 'tests'):
        raise ValueError('contradictory-code-success')
    result = {'schemaVersion': 1, 'runId': integer(row['runId'], minimum=1), 'status': row['status'],
              'phase': row['phase'], 'outcome': row['outcome'], 'assertionsPassed': passed,
              'assertionsExecuted': executed, 'mapping': mapping}
    if 'identity' in row:
        result['identity'] = parse_identity(row['identity'])
    if exception:
        result['exception'] = exception
    if failure:
        result['firstFailure'] = failure
    if utf16_length(json_stringify(result)) > 64000:
        raise ValueError('code-report-size')
    return result
