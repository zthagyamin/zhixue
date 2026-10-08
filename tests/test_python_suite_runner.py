import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('suite_reporter', Path(__file__).resolve().parents[1] / 'scripts/run-python-suite.py')
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class PythonSuiteReportTests(unittest.TestCase):
    def run_cases(self, case_type):
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(case_type)
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=reporter.CountedResult).run(suite)
        return reporter.report_result(result)

    def test_multiple_failed_subtests_do_not_create_negative_passed_methods(self):
        class Example(unittest.TestCase):
            def test_cases(self):
                for value in (1, 2):
                    with self.subTest(value=value):
                        self.fail('synthetic subtest failure')
        result = self.run_cases(Example)
        self.assertEqual((result['tests'], result['passed'], result['failures']), (1, 0, 2))
        self.assertFalse(result['successful'])

    def test_success_skip_and_expected_statuses_are_reported_separately(self):
        class Example(unittest.TestCase):
            def test_success(self):
                self.assertTrue(True)

            @unittest.skip('synthetic condition')
            def test_skip(self):
                self.fail('must not run')

            @unittest.expectedFailure
            def test_expected_failure(self):
                self.fail('synthetic expected failure')

            @unittest.expectedFailure
            def test_unexpected_success(self):
                pass
        result = self.run_cases(Example)
        self.assertEqual((result['tests'], result['passed'], result['failures']), (4, 1, 0))
        self.assertEqual(len(result['skipped']), 1)
        self.assertEqual(len(result['expectedFailures']), 1)
        self.assertEqual(len(result['unexpectedSuccesses']), 1)
        self.assertFalse(result['successful'])
