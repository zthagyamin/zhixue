"""Versioned learning-content metadata; no I/O or scoring side effects."""
import copy
import json
import math
import re
from decimal import Decimal

def parse_recall_alignment(criteria, matched, missed):
    valid={point['id'] for point in criteria}
    if type(matched) is not list or type(missed) is not list or any(type(v) is not str or v not in valid for v in matched+missed) or len(set(matched+missed))!=len(matched+missed) or len(matched+missed)!=len(criteria):
        raise ValueError('invalid-recall-alignment')
    return {'matchedPointIds':matched.copy(),'missedPointIds':missed.copy()}

def _object(value,keys):
    if type(value) is not dict or set(value)-set(keys):raise ValueError('invalid-learning-support')
    return value
def _text(value,maximum):
    if type(value) is not str or not value.strip() or len(value.encode('utf-16-le'))//2>maximum or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',value):raise ValueError('invalid-learning-support-text')
    return value
def parse_learning_support(raw,mode):
    if mode=='code':
        return parse_code_learning_support_v1(raw)
    if mode=='quiz':
        from quiz_support import parse_quiz_support
        return parse_quiz_support(raw)
    if mode=='spelling':
        from spelling_support import parse_spelling_support
        return parse_spelling_support(raw)
    if mode=='flashcard':
        from flashcard_support import parse_flashcard_support
        return parse_flashcard_support(raw)
    if mode=='calculation':
        from calculation_support import parse_calculation_support
        if type(raw) is dict and type(raw.get('schemaVersion')) in (int,float) and raw['schemaVersion']==2:
            return parse_calculation_support_v2(raw)
        return parse_calculation_support(raw)
    if mode=='recall' and type(raw) is dict and type(raw.get('schemaVersion')) in (int,float) and raw['schemaVersion']==2:
        from course_task_support import parse_recall_support_v2
        return parse_recall_support_v2(raw)
    value=_object(raw,['schemaVersion','type','criteria','hints'])
    if type(value.get('schemaVersion')) is not int or value['schemaVersion']!=1 or value.get('type')!='recall' or mode!='recall':raise ValueError('unsupported-learning-support-version')
    if not any(key in value for key in ('criteria','hints')):raise ValueError('empty-learning-support')
    if 'criteria' in value:
        if type(value['criteria']) is not list or not 1<=len(value['criteria'])<=24:raise ValueError('invalid-recall-criteria')
        ids=set()
        for point in value['criteria']:
            _object(point,['id','text','weight','mandatory']);ident=_text(point.get('id'),64)
            if not re.fullmatch(r'[a-zA-Z0-9:_.-]+',ident) or ident in ids:raise ValueError('invalid-recall-criterion-id')
            ids.add(ident);_text(point.get('text'),1500)
            if 'weight' in point and (type(point['weight']) is not int or not 0<point['weight']<=1000):raise ValueError('invalid-recall-weight')
            if 'mandatory' in point and type(point['mandatory']) is not bool:raise ValueError('invalid-recall-mandatory')
    if 'hints' in value:
        if type(value['hints']) is not list or len(value['hints'])!=3:raise ValueError('invalid-recall-hints')
        for hint in value['hints']:_text(hint,2000)
    return copy.deepcopy(value)


# ECMAScript whitespace and UTF-16 lengths match the shared browser contracts.
_JS_SPACE = r'\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def _utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def trim_contract_text(value):
    return re.sub('^[' + _JS_SPACE + ']+|[' + _JS_SPACE + ']+$', '', value)


def _contract_text(value, maximum, controls=False):
    if type(value) is not str or re.fullmatch('[' + _JS_SPACE + ']*', value) or _utf16_length(value) > maximum:
        raise ValueError('invalid-contract-text')
    if controls and re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', value):
        raise ValueError('invalid-calculation-text')
    return value


def _closed_contract(raw, required, optional=()):
    value = _object(raw, (*required, *optional))
    if any(key not in value for key in required):
        raise ValueError('invalid-learning-support')
    return value


def _calculation_identifier(value):
    value = _contract_text(value, 120, controls=True)
    if not re.fullmatch(r'[A-Za-z0-9:_.-]+', value):
        raise ValueError('invalid-calculation-id')
    return value


def _normalized_calculation_text(value):
    return re.sub('[' + _JS_SPACE + ']+', ' ', value).strip(' ').lower()


def parse_calculation_support_v2(raw):
    """Additive V2 checks; delegate every original base rule to unchanged V1."""
    from calculation_support import parse_calculation_support
    required = ('schemaVersion', 'type', 'mode', 'variables', 'domain')
    additions = ('conditions', 'units', 'step', 'variantMappingId')
    value = _closed_contract(raw, required, ('tolerance', 'exploration', *additions))
    if type(value['schemaVersion']) not in (int, float) or value['schemaVersion'] != 2:
        raise ValueError('invalid-calculation-support')
    base = {key: entry for key, entry in value.items() if key not in additions}
    parse_calculation_support({**base, 'schemaVersion': 1})
    if 'exploration' in value:
        exploration = _closed_contract(value['exploration'], ('expression', 'parameters'))
        for parameter in exploration['parameters']:
            _closed_contract(parameter, ('id', 'label', 'min', 'max', 'step', 'defaultValue'))
    if 'conditions' in value:
        conditions = value['conditions']
        if type(conditions) is not list or len(conditions) > 8:
            raise ValueError('invalid-calculation-conditions')
        normalized = [_normalized_calculation_text(_contract_text(entry, 300, controls=True)) for entry in conditions]
        if len(set(normalized)) != len(normalized):
            raise ValueError('duplicate-calculation-condition')
    if 'units' in value:
        _contract_text(value['units'], 80, controls=True)
    if 'variantMappingId' in value:
        _calculation_identifier(value['variantMappingId'])
    if 'step' in value:
        step = _closed_contract(value['step'], ('stepId', 'prompt', 'reference', 'mode'))
        _calculation_identifier(step['stepId'])
        prompt = _contract_text(step['prompt'], 512, controls=True)
        reference = _contract_text(step['reference'], 512, controls=True)
        if _normalized_calculation_text(prompt) == _normalized_calculation_text(reference) or step['mode'] not in ('numeric', 'symbolic', 'semantic'):
            raise ValueError('invalid-calculation-step')
    return copy.deepcopy(value)


def _code_identifier(value):
    value = _contract_text(value, 64)
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value) or value.startswith('__'):
        raise ValueError('invalid-code-function')
    return value


def _json_stringify(value):
    """JSON text for size limits, including JS number spelling and lone surrogates."""
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
        text = json.dumps(value, ensure_ascii=False)
        return re.sub(r'[\ud800-\udfff]', lambda match: '\\u' + format(ord(match[0]), '04x'), text)
    if type(value) is list:
        return '[' + ','.join(_json_stringify(entry) for entry in value) + ']'
    return '{' + ','.join(_json_stringify(key) + ':' + _json_stringify(entry) for key, entry in value.items()) + '}'


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
        if type(value) is str and _utf16_length(value) <= 4000:
            return value
        if type(value) is list and len(value) <= 64:
            return [visit(entry, depth + 1) for entry in value]
        if type(value) is dict:
            if len(value) > 64 or any(type(key) is not str or _utf16_length(key) > 128 or key in ('__proto__', 'constructor', 'prototype') for key in value):
                raise ValueError('invalid-code-json-key')
            return {key: visit(entry, depth + 1) for key, entry in value.items()}
        raise ValueError('invalid-code-json')

    result = visit(raw, 0)
    if _utf16_length(_json_stringify(result)) > 16000:
        raise ValueError('code-json-size')
    return result


def parse_code_learning_support_v1(raw):
    """Validate source function cases without executing any learner code."""
    row = _closed_contract(raw, ('schemaVersion', 'type', 'functionNames', 'cases'))
    if type(row['schemaVersion']) not in (int, float) or row['schemaVersion'] != 1 or row['type'] != 'code':
        raise ValueError('unsupported-code-support')
    if type(row['functionNames']) is not list or not 1 <= len(row['functionNames']) <= 16:
        raise ValueError('invalid-code-functions')
    functions = [_code_identifier(value) for value in row['functionNames']]
    if len(set(functions)) != len(functions):
        raise ValueError('duplicate-code-function')
    if type(row['cases']) is not list or not 1 <= len(row['cases']) <= 32:
        raise ValueError('invalid-code-cases')
    ids, cases = set(), []
    for raw_case in row['cases']:
        entry = _closed_contract(raw_case, ('id', 'functionName', 'args', 'expected'), ('kwargs', 'hint'))
        ident = _contract_text(entry['id'], 64)
        if not re.fullmatch(r'[A-Za-z0-9:_.-]+', ident) or ident in ids:
            raise ValueError('invalid-code-case-id')
        ids.add(ident)
        function = _code_identifier(entry['functionName'])
        if function not in functions:
            raise ValueError('unapproved-code-function')
        if type(entry['args']) is not list or len(entry['args']) > 20:
            raise ValueError('invalid-code-args')
        kwargs = entry.get('kwargs', {})
        if type(kwargs) is not dict or len(kwargs) > 20:
            raise ValueError('invalid-code-kwargs')
        for key in kwargs:
            _code_identifier(key)
        case = {'id': ident, 'functionName': function, 'args': bounded_code_json(entry['args']),
                'kwargs': bounded_code_json(kwargs), 'expected': bounded_code_json(entry['expected'])}
        if 'hint' in entry:
            case['hint'] = _contract_text(entry['hint'], 2000)
        cases.append(case)
    result = {'schemaVersion': 1, 'type': 'code', 'functionNames': functions, 'cases': cases}
    if _utf16_length(_json_stringify(result)) > 100000:
        raise ValueError('code-support-size')
    return result


def has_executable_code_material(raw):
    """Mirror browser execution prerequisites without running learner code."""
    if type(raw) is not dict or type(raw.get('initialCode')) is not str or not trim_contract_text(raw['initialCode']):
        return False
    support = raw.get('learningSupport')
    if type(support) is dict and support.get('type') == 'code':
        try:
            parse_code_learning_support_v1(support)
            return True
        except ValueError:
            return False
    return type(raw.get('testCode')) is str and bool(trim_contract_text(raw['testCode']))


def parse_recall_policy(raw):
    value=_object(raw,['policyVersion','attemptId','maxPreHintLevel','requestedRating','appliedRating'])
    level=value.get('maxPreHintLevel');rating=value.get('requestedRating')
    if value.get('policyVersion')!='recall-hints-v1' or type(value.get('attemptId')) is not str or not re.fullmatch(r'[a-zA-Z0-9:_.-]{1,120}',value['attemptId']) or type(level) is not int or not 0<=level<=3 or rating not in ('again','hard','good','easy'):raise ValueError('invalid-recall-policy')
    applied='again' if level>=3 else 'hard' if level>=2 and rating in ('good','easy') else rating
    if value.get('appliedRating')!=applied:raise ValueError('invalid-recall-policy')
    return copy.deepcopy(value)
