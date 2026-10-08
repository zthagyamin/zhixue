import types
import unittest
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'public/workers/python-assertions.py'
module = types.ModuleType('practice_assertions')
exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), module.__dict__)
run_tests = module._zhixue_run_tests


class ExecutedAssertionTests(unittest.TestCase):
    def test_executed_checks_and_function_checks_count(self):
        scope = {'add': lambda a, b: a + b}
        self.assertEqual(run_tests('assert add(1,2)==3\ndef check():\n assert add(-1,1)==0\ncheck()', scope), 2)
        self.assertNotIn('__zhixue_executed_assertion__', scope)

    def test_no_checks_never_pass(self):
        for source in ('', '# assert True', "text = 'assert True'", 'def unused():\n assert True', 'if False:\n assert True'):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'NO_EXECUTED_ASSERTIONS'):
                run_tests(source, {})

    def test_failing_assertion_and_message_are_preserved(self):
        scope = {}
        with self.assertRaisesRegex(AssertionError, 'expected three'):
            run_tests("assert 1+1==3, 'expected three'", scope)
        self.assertNotIn('__zhixue_executed_assertion__', scope)

    def test_assertion_expression_runs_only_once(self):
        calls = []
        self.assertEqual(run_tests('assert observe() == 1', {'observe': lambda: calls.append(1) or len(calls)}), 1)
        self.assertEqual(calls, [1])

    def test_pass_does_not_evaluate_failure_message(self):
        self.assertEqual(run_tests('assert True, missing_name()', {}), 1)

    def test_syntax_failure_is_not_a_pass(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_TEST_DEFINITION'):
            run_tests('assert (', {})

import asyncio
import json


def report(code, tests=None, cases=None, prefix=0):
    return json.loads(asyncio.run(module._zhixue_execute_report(code, tests,
        None if cases is None else json.dumps(cases), {'__name__': '__main__'}, prefix)))


def function_support(expected=3):
    return {'schemaVersion': 1, 'type': 'code', 'functionNames': ['add'],
            'cases': [{'id': 'sum', 'functionName': 'add', 'args': [1, 2], 'kwargs': {},
                       'expected': expected, 'hint': 'Check addition.'}]}


class CodeRunReportTests(unittest.TestCase):
    def test_test_type_error_mentions_assertion_stays_unknown(self):
        data = report('pass', "raise TypeError('AssertionError is only text')")['report']
        self.assertEqual(data['outcome'], 'unknown')
        self.assertFalse(data['exception']['isAssertion'])
        self.assertEqual(data['exception']['kind'], 'TypeError')

    def test_program_marker_text_cannot_change_phase(self):
        data = report("raise ValueError('ZHIXUE_INVALID_TEST_DEFINITION')")['report']
        self.assertEqual((data['phase'], data['outcome']), ('program', 'student-error'))

    def test_same_name_custom_assertion_is_not_trusted(self):
        data = report('pass', 'class AssertionError(Exception): pass\nraise AssertionError("custom")')['report']
        self.assertFalse(data['exception']['isAssertion'])
        self.assertEqual(data['outcome'], 'unknown')

    def test_builtin_assertion_and_executed_count_are_exact(self):
        data = report('def add(a,b): return a+b', 'assert add(1,2)==3\nassert add(2,2)==5\nassert True')['report']
        self.assertEqual(data['outcome'], 'student-error')
        self.assertTrue(data['exception']['isAssertion'])
        self.assertEqual(data['assertionsExecuted'], 2)
        self.assertEqual(data['assertionsPassed'], 1)

    def test_original_line_mapping_for_zero_one_three_imports(self):
        for prefix in ('', 'import math\n', 'import math\nimport json\nimport ast\n'):
            count = prefix.count('\n')
            data = report(prefix + 'x=1\nraise TypeError("bad")', prefix=count)['report']
            self.assertEqual(data['mapping'], {'prefixLineCount': count, 'originalLineCount': 2})
            self.assertEqual(data['exception']['location']['originalLine'], 2)
            self.assertEqual(data['exception']['location']['line'], count + 2)
        data = report('import no_such_preparation_module\npass', prefix=1)['report']
        self.assertEqual(data['outcome'], 'environment-error')
        self.assertEqual(data['exception']['location']['origin'], 'preparation')
        self.assertNotIn('originalLine', data['exception']['location'])

    def test_structured_first_failure_uses_exactly_one_function_invocation(self):
        code = 'calls=0\ndef add(a,b):\n global calls\n calls+=1\n return a+b+calls'
        cases = function_support()
        cases['cases'].append({'id': 'later', 'functionName': 'add', 'args': [2, 2], 'expected': 4})
        data = report(code, cases=cases)['report']
        self.assertEqual(data['firstFailure']['actual'], 4)
        self.assertEqual(data['firstFailure']['args'], [1, 2])
        self.assertEqual(data['firstFailure']['hint'], 'Check addition.')
        self.assertEqual(data['assertionsExecuted'], 1)
        self.assertEqual(data['assertionsPassed'], 0)

    def test_mutated_inputs_are_preserved_before_the_single_call(self):
        cases = function_support()
        cases['cases'][0]['args'] = [[1, 2]]
        data = report('def add(values):\n values.append(9)\n return values', cases=cases)['report']
        self.assertEqual(data['firstFailure']['args'], [[1, 2]])
        self.assertEqual(data['firstFailure']['actual'], [1, 2, 9])

    def test_test_setup_and_non_json_return_stay_pending(self):
        self.assertEqual(report('pass', 'missing_fixture()')['report']['outcome'], 'unknown')
        self.assertEqual(report('def add(a,b): return object()', cases=function_support())['report']['outcome'], 'unknown')

    def test_last_expression_and_top_level_await_are_preserved(self):
        self.assertEqual(report('import asyncio\nawait asyncio.sleep(0)\n3+4')['result'], '7')

    def test_invalid_support_is_checked_before_learner_code(self):
        for patch in ({'schemaVersion': 2}, {'functionNames': ['add()']}, {'cases': []}):
            cases = {**function_support(), **patch}
            data = report('raise ValueError("must not execute")', cases=cases)['report']
            self.assertEqual((data['phase'], data['outcome']), ('test-definition', 'test-error'))

class SharedCodeSupportFixtures(unittest.TestCase):
    def test_shared_node_python_support_contract(self):
        path = Path(__file__).resolve().parent / 'fixtures/stage3-code-support-contract.json'
        for fixture in json.loads(path.read_text(encoding='utf-8')):
            with self.subTest(name=fixture['name']):
                if fixture['valid']:
                    self.assertEqual(module._zhixue_validate_support(json.dumps(fixture['input']))['schemaVersion'], 1)
                else:
                    with self.assertRaises(ValueError):
                        module._zhixue_validate_support(json.dumps(fixture['input']))

class NonLearnerFailureTests(unittest.TestCase):
    def test_resource_environment_and_exit_exceptions_do_not_become_learner_failure(self):
        for kind in ('MemoryError', 'ModuleNotFoundError', 'KeyboardInterrupt', 'SystemExit', 'TimeoutError'):
            with self.subTest(kind=kind):
                self.assertEqual(report(f'raise {kind}("runtime interrupted")')['report']['outcome'], 'unknown')

class JSONComparisonTests(unittest.TestCase):
    def test_structured_json_comparison_does_not_treat_boolean_as_a_number(self):
        cases = function_support(expected=1)
        self.assertEqual(report('def add(a,b): return True', cases=cases)['report']['outcome'], 'student-error')
        self.assertEqual(report('def add(a,b): return 1.0', cases=cases)['report']['outcome'], 'success')

class ReviewSyntaxProvenanceTests(unittest.TestCase):
    def test_test_generated_syntax_error_cannot_choose_learner_provenance(self):
        for tests, line in (
            ("compile('def broken(', '<learner>', 'exec')", 1),
            ("raise SyntaxError('fake', ('<learner>', 999, 1, 'ignored'))", 1),
            ("exec(compile(\"raise SyntaxError('fake', ('<learner>', 1, 1, 'ignored'))\", '<learner>', 'exec'))", 1),
            ("def check():\n compile('def broken(', '<learner>', 'exec')\ncheck()", 2),
        ):
            with self.subTest(tests=tests):
                data = report('pass', tests)['report']
                self.assertEqual((data['phase'], data['outcome']), ('tests', 'unknown'))
                self.assertEqual(data['exception']['location']['origin'], 'tests')
                self.assertEqual(data['exception']['location']['line'], line)
                self.assertNotIn('originalLine', data['exception']['location'])

    def test_learner_compilation_and_executed_learner_frame_keep_true_locations(self):
        initial = report('def broken(')['report']
        self.assertEqual(initial['outcome'], 'student-error')
        self.assertEqual(initial['exception']['location']['originalLine'], 1)
        executed = report("def break_it():\n compile('def broken(', '<题目测试>', 'exec')", 'break_it()')['report']
        self.assertEqual(executed['outcome'], 'student-error')
        self.assertEqual(executed['exception']['location']['origin'], 'learner')
        self.assertEqual(executed['exception']['location']['originalLine'], 2)

class ReviewLegacyPassedCountTests(unittest.TestCase):
    def test_completed_checks_survive_later_setup_failure(self):
        for tests, executed, passed, outcome in (
            ('assert True\nraise TypeError("setup")', 1, 1, 'unknown'),
            ('assert True\nassert True\nraise TypeError("setup")', 2, 2, 'unknown'),
            ('assert True\nassert False', 2, 1, 'student-error'),
            ('assert True\nassert missing_fixture()', 2, 1, 'unknown'),
        ):
            with self.subTest(tests=tests):
                data = report('pass', tests)['report']
                self.assertEqual(data['assertionsExecuted'], executed)
                self.assertEqual(data['assertionsPassed'], passed)
                self.assertEqual(data['outcome'], outcome)
                self.assertEqual(data['status'], 'failed')

    def test_success_observation_keeps_single_expression_truth_and_lazy_message(self):
        code = '''events=[]
class Truth:
 def __bool__(self):
  events.append('truth')
  return True
def observe():
 events.append('expression')
 return Truth()
'''
        data = report(code, "assert observe(), missing_failure_message()\nassert events == ['expression', 'truth']\nraise TypeError('setup')")['report']
        self.assertEqual(data['outcome'], 'unknown')
        self.assertEqual((data['assertionsExecuted'], data['assertionsPassed']), (2, 2))

class ReviewUTF16DiagnosticTests(unittest.TestCase):
    def test_large_astral_exception_message_keeps_bounded_trustworthy_metadata(self):
        data = report('raise ValueError("😀"*3000)')['report']
        self.assertLessEqual(module._utf16_length(data['exception']['message']), 4000)
        self.assertEqual(data['exception']['message'], '😀' * 2000)
        self.assertEqual(data['exception']['kind'], 'ValueError')
        self.assertEqual(data['exception']['location']['originalLine'], 1)
        boundary = report('raise ValueError("a"*3999 + "😀tail")')['report']
        self.assertEqual(boundary['exception']['message'], 'a' * 3999)
        boundary['exception']['message'].encode('utf-8')

    def test_exception_kind_and_function_name_share_utf16_bounds(self):
        name = '𐐀' * 90
        kind = report(f'raise type("{name}", (Exception,), {{}})("message")')['report']['exception']
        self.assertLessEqual(module._utf16_length(kind['kind']), 128)
        function = report(f'def {name}():\n raise ValueError("message")\n{name}()')['report']['exception']
        self.assertLessEqual(module._utf16_length(function['location']['functionName']), 128)
        self.assertEqual(function['location']['originalLine'], 2)

    def test_rendered_traceback_and_trial_result_follow_the_same_output_limit(self):
        data = report('raise ValueError("😀"*12000)')
        self.assertLessEqual(module._utf16_length(data['error']), 20000)
        data = report('"😀"*12000')
        self.assertLessEqual(module._utf16_length(data['result']), 20000)

class ReviewCaughtAssertionTests(unittest.TestCase):
    def test_caught_failed_or_interrupted_checks_keep_counts_and_stay_unknown(self):
        for tests, executed, passed in (
            ('try:\n assert False\nexcept AssertionError:\n pass\nassert True', 2, 1),
            ('try:\n assert missing_fixture()\nexcept NameError:\n pass\nassert True', 2, 1),
            ('def check():\n try:\n  assert False\n except AssertionError:\n  pass\ncheck()', 1, 0),
        ):
            with self.subTest(tests=tests):
                payload = report('pass', tests)
                data = payload['report']
                self.assertEqual((data['status'], data['outcome'], data['phase']), ('failed', 'unknown', 'tests'))
                self.assertEqual((data['assertionsExecuted'], data['assertionsPassed']), (executed, passed))
                self.assertNotIn('exception', data)
                self.assertNotIn('firstFailure', data)
                self.assertTrue(payload['error'])

    def test_caught_check_is_not_replayed_and_message_stays_lazy(self):
        code = '''events=[]
def observe():
 events.append('condition')
 return False
def message():
 events.append('message')
 return 'expected failure'
'''
        tests = "try:\n assert observe(), message()\nexcept AssertionError:\n pass\nassert events == ['condition', 'message'], missing_message()"
        data = report(code, tests)['report']
        self.assertEqual((data['status'], data['outcome']), ('failed', 'unknown'))
        self.assertEqual((data['assertionsExecuted'], data['assertionsPassed']), (2, 1))
