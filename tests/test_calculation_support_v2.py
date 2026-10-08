import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from learning_support import parse_learning_support


class CalculationSupportV2Tests(unittest.TestCase):
    def test_shared_contract_cases(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/stage3-calculation-support.json').read_text(encoding='utf-8'))
        for row in fixture['supportCases']:
            with self.subTest(row['name']):
                if row['valid']:
                    self.assertEqual(parse_learning_support(row['support'], 'calculation'), row['support'])
                else:
                    with self.assertRaises(ValueError):
                        parse_learning_support(row['support'], 'calculation')

    def test_v2_boundaries_and_detached_output(self):
        support = {'schemaVersion': 2, 'type': 'calculation', 'mode': 'numeric', 'variables': [], 'domain': 'real',
                   'step': {'stepId': 's', 'prompt': 'Compute.', 'reference': '2', 'mode': 'numeric'}}
        parsed = parse_learning_support(support, 'calculation')
        parsed['step']['reference'] = 'changed'
        self.assertEqual(support['step']['reference'], '2')
        for extra in ({'units': '\x7f'}, {'units': '😀' * 41}, {'conditions': ['a'] * 9},
                      {'conditions': ['X > 0', 'x > 0']}, {'variantMappingId': 'source/map'},
                      {'variantMappingId': 'x' * 121}, {'conditions': [None]}, {'schemaVersion': True}):
            with self.subTest(extra), self.assertRaises(ValueError):
                parse_learning_support({**support, **extra}, 'calculation')
        integral = copy.deepcopy(support)
        integral['schemaVersion'] = 2.0
        self.assertEqual(parse_learning_support(integral, 'calculation'), integral)
        legacy = {'schemaVersion': 1.0, 'type': 'calculation', 'mode': 'numeric', 'variables': [], 'domain': 'real'}
        with self.assertRaises(ValueError):
            parse_learning_support(legacy, 'calculation')

