"""Run the real Companion unittest suite and report exact counts, including skips."""
import argparse
import json
from pathlib import Path
import sys
import unittest

class CountedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.passed_methods = 0

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed_methods += 1


def report_result(result):
    return {
        'tests': result.testsRun,
        'passed': result.passed_methods,
        'failures': len(result.failures),
        'errors': len(result.errors),
        'counting': 'tests/passed count methods; failures/errors count events, including failing subtests',
        'skipped': [{'test': test.id(), 'reason': reason} for test, reason in result.skipped],
        'expectedFailures': [test.id() for test, _ in result.expectedFailures],
        'unexpectedSuccesses': [test.id() for test in result.unexpectedSuccesses],
        'successful': result.wasSuccessful() and result.testsRun > 0 and not result.expectedFailures,
        'python': sys.version,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    # Match `python -m unittest` from the repository root, including namespace-package imports.
    sys.path.insert(0, str(root))
    suite = unittest.defaultTestLoader.discover(str(root / 'tests'), pattern='test_*.py')
    result = unittest.TextTestRunner(verbosity=2, resultclass=CountedResult).run(suite)
    report = report_result(result)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0 if report['successful'] else 1


if __name__ == '__main__':
    sys.exit(main())
