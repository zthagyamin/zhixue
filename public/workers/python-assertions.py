"""Count executed assertions in supplied practice tests, not in learner code."""
import ast


def _parse_test_tree(source):
    try:
        return ast.parse(source, filename='<题目测试>', mode='exec')
    except SyntaxError as error:
        raise _ZhixueTestDefinitionError('ZHIXUE_INVALID_TEST_DEFINITION: 题目测试语法错误，暂不能判定作答。') from error


def _zhixue_validate_tests(source):
    _parse_test_tree(source)


def _zhixue_run_tests(source, namespace, count=None, passed_count=None, execution_frames=None):
    tree = _parse_test_tree(source)
    executed = []
    marker = '__zhixue_executed_assertion__'
    passed_marker = '__zhixue_passed_assertion__'

    class CountAssertions(ast.NodeTransformer):
        def visit_Assert(self, node):
            self.generic_visit(node)
            node.test = ast.BoolOp(op=ast.Or(), values=[
                ast.Call(func=ast.Name(id=marker, ctx=ast.Load()), args=[], keywords=[]),
                node.test,
            ])
            # Runs only after the original assert succeeds; no re-evaluation.
            passed = ast.Expr(value=ast.Call(
                func=ast.Name(id=passed_marker, ctx=ast.Load()), args=[], keywords=[]))
            return [node, ast.copy_location(passed, node)]

    tree = ast.fix_missing_locations(CountAssertions().visit(tree))
    def observe():
        executed.append(None)
        if count is not None:
            count[0] += 1
    def observe_passed():
        if passed_count is not None:
            passed_count[0] += 1
    namespace[marker] = observe
    namespace[passed_marker] = observe_passed
    try:
        compiled = compile(tree, '<题目测试>', 'exec')
        if execution_frames is not None:
            _register_code_frames(execution_frames, compiled, 'tests')
        exec(compiled, namespace)
        if not executed:
            raise _ZhixueTestDefinitionError('ZHIXUE_NO_EXECUTED_ASSERTIONS: 题目测试没有执行 assert 断言，不能自动判定通过。')
        return len(executed)
    finally:
        namespace.pop(marker, None)
        namespace.pop(passed_marker, None)

# Execution evidence is produced here, from actual exception objects and frames.
import builtins
import inspect
import json
import math
import traceback

_TRUSTED_ASSERTION = builtins.AssertionError
_NON_LEARNER_EXCEPTIONS = (MemoryError, ImportError, OSError, SystemExit, KeyboardInterrupt, GeneratorExit)

def _utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def _utf16_clip(value, maximum):
    # Bound the temporary encoding too: a code point occupies one or two units.
    encoded = value[:maximum].encode('utf-16-le', errors='surrogatepass')
    clipped = encoded[:maximum * 2]
    if len(clipped) < len(encoded) and len(clipped) >= 2:
        last_unit = int.from_bytes(clipped[-2:], 'little')
        if 0xD800 <= last_unit <= 0xDBFF:
            clipped = clipped[:-2]
    return clipped.decode('utf-16-le', errors='surrogatepass')


class _ZhixueTestDefinitionError(ValueError):
    pass


def _bounded_json(value, depth=0, counter=None):
    counter = [0] if counter is None else counter
    counter[0] += 1
    if counter[0] > 256 or depth > 8:
        raise _ZhixueTestDefinitionError('code-json-limit')
    if value is None or type(value) is bool:
        return value
    if type(value) in (int, float) and math.isfinite(value):
        return value
    if type(value) is str and _utf16_length(value) <= 4000:
        return value
    if type(value) is list and len(value) <= 64:
        return [_bounded_json(item, depth + 1, counter) for item in value]
    if type(value) is dict and len(value) <= 64:
        if any(type(key) is not str or _utf16_length(key) > 128 or key in ('__proto__', 'constructor', 'prototype') for key in value):
            raise _ZhixueTestDefinitionError('invalid-code-json-key')
        return {key: _bounded_json(item, depth + 1, counter) for key, item in value.items()}
    raise _ZhixueTestDefinitionError('invalid-code-json')


def _checked_json(value):
    result = _bounded_json(value)
    if _utf16_length(json.dumps(result, ensure_ascii=False, separators=(',', ':'))) > 16000:
        raise _ZhixueTestDefinitionError('code-json-size')
    return result


def _closed_object(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or not value.keys() <= set(required) | set(optional):
        raise _ZhixueTestDefinitionError('invalid-code-object')


def _text(value, maximum):
    if type(value) is not str or not value.strip() or _utf16_length(value) > maximum:
        raise _ZhixueTestDefinitionError('invalid-code-text')
    return value


def _function_name(value):
    import re
    name = _text(value, 64)
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name) or name.startswith('__'):
        raise _ZhixueTestDefinitionError('invalid-code-function')
    return name


def _zhixue_validate_support(source):
    import re
    support = json.loads(source)
    _closed_object(support, ('schemaVersion', 'type', 'functionNames', 'cases'))
    if support['schemaVersion'] != 1 or type(support['schemaVersion']) is not int or support['type'] != 'code':
        raise _ZhixueTestDefinitionError('unsupported-code-support')
    names = support['functionNames']
    if type(names) is not list or not 1 <= len(names) <= 16:
        raise _ZhixueTestDefinitionError('invalid-code-functions')
    for name in names:
        _function_name(name)
    if len(set(names)) != len(names):
        raise _ZhixueTestDefinitionError('duplicate-code-function')
    cases = support['cases']
    if type(cases) is not list or not 1 <= len(cases) <= 32:
        raise _ZhixueTestDefinitionError('invalid-code-cases')
    ids = set()
    for case in cases:
        _closed_object(case, ('id', 'functionName', 'args', 'expected'), ('kwargs', 'hint'))
        case_id = _text(case['id'], 64)
        if not re.fullmatch(r'[A-Za-z0-9:_.-]+', case_id) or case_id in ids:
            raise _ZhixueTestDefinitionError('invalid-code-case-id')
        ids.add(case_id)
        if _function_name(case['functionName']) not in names:
            raise _ZhixueTestDefinitionError('unapproved-code-function')
        if type(case['args']) is not list or len(case['args']) > 20:
            raise _ZhixueTestDefinitionError('invalid-code-args')
        case['args'] = _checked_json(case['args'])
        kwargs = case.setdefault('kwargs', {})
        if type(kwargs) is not dict or len(kwargs) > 20:
            raise _ZhixueTestDefinitionError('invalid-code-kwargs')
        for key in kwargs:
            _function_name(key)
        case['kwargs'] = _checked_json(kwargs)
        case['expected'] = _checked_json(case['expected'])
        if 'hint' in case:
            _text(case['hint'], 2000)
    if _utf16_length(json.dumps(support, ensure_ascii=False, separators=(',', ':'))) > 100000:
        raise _ZhixueTestDefinitionError('code-support-size')
    return support


def _register_code_frames(registry, compiled, origin):
    pending = [compiled]
    while pending:
        code = pending.pop()
        # Keep a reference and check identity: code objects can compare equal.
        registry[id(code)] = (code, origin)
        pending.extend(value for value in code.co_consts if type(value) is type(compiled))


def _exception_metadata(error, prefix, original_lines, execution_frames, compilation_origin=None):
    location = None
    if isinstance(error, SyntaxError) and compilation_origin is not None:
        # Only our own compile operation may use SyntaxError's source line.
        # Runtime compile/raise calls instead use the actual executed frames.
        filename = '<learner>' if compilation_origin == 'learner' else '<题目测试>'
        frames = [(filename, error.lineno or 1, '<module>')]
    else:
        frames = []
        current = error.__traceback__
        while current is not None:
            code = current.tb_frame.f_code
            registered = execution_frames.get(id(code))
            if registered is not None and registered[0] is code:
                filename = '<learner>' if registered[1] == 'learner' else '<题目测试>'
                frames.append((filename, current.tb_lineno, code.co_name))
            current = current.tb_next
    for filename, line, function in frames:
        if filename not in ('<learner>', '<题目测试>'):
            continue
        origin = 'tests' if filename == '<题目测试>' else ('preparation' if line <= prefix else 'learner')
        location = {'origin': origin, 'file': _utf16_clip(filename, 240), 'line': line, 'functionName': _utf16_clip(function, 128)}
        if origin == 'learner' and 1 <= line - prefix <= original_lines:
            location['originalLine'] = line - prefix
    return {'kind': _utf16_clip(type(error).__name__, 128), 'message': _utf16_clip(str(error), 4000),
            'isAssertion': type(error) is _TRUSTED_ASSERTION,
            **({'location': location} if location else {})}


def _json_equal(left, right):
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if type(left) is list:
        return len(left) == len(right) and all(_json_equal(a, b) for a, b in zip(left, right))
    if type(left) is dict:
        return left.keys() == right.keys() and all(_json_equal(left[key], right[key]) for key in left)
    return left == right


async def _zhixue_execute_report(code, test_source, support_source, namespace, prefix):
    original_lines = len(code.split('\n')) - prefix
    report = {'schemaVersion': 1, 'status': 'passed', 'phase': 'program', 'outcome': 'success',
              'assertionsPassed': 0, 'assertionsExecuted': 0,
              'mapping': {'prefixLineCount': prefix, 'originalLineCount': original_lines}}
    result = None
    support = None
    compilation_origin = None
    execution_frames = {}
    try:
        report['phase'] = 'test-definition'
        if test_source is not None:
            compilation_origin = 'tests'
            _zhixue_validate_tests(test_source)
            compilation_origin = None
        if support_source is not None:
            support = _zhixue_validate_support(support_source)
        report['phase'] = 'program'
        compilation_origin = 'learner'
        tree = ast.parse(code, filename='<learner>', mode='exec')
        expression = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
        program = compile(tree, '<learner>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        _register_code_frames(execution_frames, program, 'learner')
        compilation_origin = None
        pending = eval(program, namespace)
        if inspect.isawaitable(pending):
            await pending
        if expression is not None:
            compilation_origin = 'learner'
            compiled_expression = compile(expression, '<learner>', 'eval', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            _register_code_frames(execution_frames, compiled_expression, 'learner')
            compilation_origin = None
            result = eval(compiled_expression, namespace)
            if inspect.isawaitable(result):
                result = await result
        report['phase'] = 'tests'
        if test_source is not None:
            count, passed_count = [0], [0]
            try:
                _zhixue_run_tests(test_source, namespace, count, passed_count, execution_frames)
            finally:
                report['assertionsExecuted'] = count[0]
                report['assertionsPassed'] = passed_count[0]
            if report['assertionsPassed'] < report['assertionsExecuted']:
                # Test control flow caught a failed/interrupted check. Retain
                # observations without asserting success or learner attribution.
                report.update(status='failed', outcome='unknown')
                return json.dumps({
                    'report': report,
                    'result': None,
                    'error': '题目测试有未通过或未完成的检查，请核对测试控制流程；暂不能判定作答。',
                }, ensure_ascii=False)
        if support:
            for case in support['cases']:
                function = namespace.get(case['functionName'])
                if not callable(function):
                    raise _ZhixueTestDefinitionError('approved-function-unavailable')
                # Retain inputs before the single call: learner code may mutate them.
                args = json.loads(json.dumps(case['args']))
                kwargs = json.loads(json.dumps(case['kwargs']))
                report['assertionsExecuted'] += 1
                actual = function(*args, **kwargs)
                try:
                    actual = _checked_json(actual)
                except _ZhixueTestDefinitionError as error:
                    raise RuntimeError('Function returned an unsupported or oversized JSON value; pending review.') from error
                if not _json_equal(actual, case['expected']):
                    report['firstFailure'] = {'caseId': case['id'], 'functionName': case['functionName'],
                                              'args': case['args'], 'kwargs': case['kwargs'],
                                              'expected': case['expected'], 'actual': actual,
                                              **({'hint': case['hint']} if 'hint' in case else {})}
                    report.update(status='failed', outcome='student-error')
                    break
                report['assertionsPassed'] += 1
    except BaseException as error:
        observed_error = error.__cause__ if type(error) is _ZhixueTestDefinitionError and isinstance(error.__cause__, SyntaxError) else error
        metadata = _exception_metadata(observed_error, prefix, original_lines, execution_frames, compilation_origin)
        report.update(status='failed', outcome='unknown', exception=metadata)
        origin = metadata.get('location', {}).get('origin')
        if report['phase'] == 'test-definition' or type(error) is _ZhixueTestDefinitionError:
            report.update(phase='test-definition', outcome='test-error')
        elif origin == 'preparation':
            report.update(phase='preparation', outcome='environment-error')
        elif isinstance(error, _NON_LEARNER_EXCEPTIONS):
            report['outcome'] = 'unknown'
        elif report['phase'] == 'program' and origin == 'learner':
            report['outcome'] = 'student-error'
        elif report['phase'] == 'tests' and (origin == 'learner' or metadata['isAssertion'] and origin == 'tests'):
            report['outcome'] = 'student-error'
        return json.dumps({'report': report, 'result': None, 'error': _utf16_clip(''.join(traceback.format_exception(error)), 20000)}, ensure_ascii=False)
    return json.dumps({'report': report, 'result': None if result is None else _utf16_clip(str(result), 20000)}, ensure_ascii=False)
