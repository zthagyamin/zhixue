import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from learning_support import parse_learning_support


def support():
    return {'schemaVersion': 1, 'type': 'code', 'functionNames': ['add'],
            'cases': [{'id': 'sum', 'functionName': 'add', 'args': [1, 2], 'expected': 3}]}


class CodeLearningSupportTests(unittest.TestCase):
    def test_shared_contract_fixtures(self):
        paths = ['stage3-code-support-contract.json', 'stage3-code-support-parity.json']
        for name in paths:
            path = Path(__file__).parent / 'fixtures' / name
            if not path.exists():
                continue
            for row in json.loads(path.read_text(encoding='utf-8')):
                with self.subTest(row['name']):
                    if row['valid']:
                        parsed = parse_learning_support(row['input'], 'code')
                        expected = copy.deepcopy(row['input'])
                        for case in expected['cases']:
                            case['kwargs'] = case.get('kwargs') or {}
                        self.assertEqual(parsed, expected)
                    else:
                        with self.assertRaises(ValueError):
                            parse_learning_support(row['input'], 'code')

    def test_bounded_json_and_strict_function_cases(self):
        base = support()
        parsed = parse_learning_support(base, 'code')
        parsed['cases'][0]['args'].append(3)
        self.assertEqual(base['cases'][0]['args'], [1, 2])
        nested = 0
        for _ in range(9):
            nested = [nested]
        for extra in ({'functionNames': ['add', 'add']}, {'schemaVersion': True}, {'cases': base['cases'] * 33},
                      {'cases': [{**base['cases'][0], 'expected': float('nan')}]},
                      {'cases': [{**base['cases'][0], 'expected': nested}]},
                      {'cases': [{**base['cases'][0], 'args': [0] * 21}]},
                      {'cases': [{**base['cases'][0], 'kwargs': {'__dunder': 1}}]}):
            with self.subTest(extra), self.assertRaises(ValueError):
                parse_learning_support({**base, **extra}, 'code')
        self.assertEqual(parse_learning_support({**base, 'schemaVersion': 1.0}, 'code')['schemaVersion'], 1)

