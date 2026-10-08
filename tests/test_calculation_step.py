import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from calculation_step import grade_calculation_step


def support(mode, reference, **extra):
    return {'schemaVersion': 2, 'type': 'calculation', 'mode': 'numeric', 'variables': ['x'], 'domain': 'real',
            'step': {'stepId': 'one', 'prompt': 'Write the requested intermediate value.', 'reference': reference, 'mode': mode}, **extra}


class CalculationStepTests(unittest.TestCase):
    def test_shared_step_diagnoses(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/stage3-calculation-support.json').read_text(encoding='utf-8'))
        for row in fixture['stepCases']:
            with self.subTest(row['name']):
                extra = {key: row[key] for key in ('tolerance', 'conditions') if key in row}
                result = grade_calculation_step(row['answer'], support(row['mode'], row['reference'], **extra))
                self.assertEqual(result['status'], row['status'])
                self.assertEqual(result['source'], 'deterministic')
                self.assertEqual(set(result), {'status', 'source', 'explanation'})
                self.assertTrue(result['explanation'].strip())

    def test_invalid_legacy_and_unattempted_abstain(self):
        for answer, raw in [(None, support('numeric', '2')), ('2', {}), ('2', {**support('numeric', '2'), 'schemaVersion': 1}),
                            ('2', support('numeric', '2', domain='complex'))]:
            self.assertEqual(grade_calculation_step(answer, raw)['status'], 'undetermined')

    def test_global_equal_is_valid_with_conditions_but_unknown_is_not_wrong(self):
        self.assertEqual(grade_calculation_step('x+x', support('symbolic', '2*x', conditions=['x = 0']))['status'], 'correct')
        self.assertEqual(grade_calculation_step('sqrt(x^2)', support('symbolic', 'x'))['status'], 'undetermined')
        self.assertEqual(grade_calculation_step('1e-999', support('numeric', '0'))['status'], 'undetermined')

