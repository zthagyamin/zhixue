import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
SCHEMA = importlib.util.find_spec('task_plan_schema')
if SCHEMA:
    from task_plan_schema import validate_task_plan


class TaskPlanSchemaTests(unittest.TestCase):
    def test_fixed_daily_policy_preserves_legacy_and_validates_optional_values(self):
        from task_plan_schema import validate_long_term_allocation
        value = {'schemaVersion': 1, 'planId': 'p', 'day': '2026-09-09', 'vocabularyTarget': 0, 'items': []}
        self.assertEqual(validate_long_term_allocation(value), value)
        self.assertEqual(validate_long_term_allocation({**value, 'reviewTarget': None, 'budgetMinutes': 30.0})['budgetMinutes'], 30)
        for fields in ({'reviewTarget': -1}, {'reviewTarget': 1.5}, {'reviewTarget': True}, {'reviewTarget': 10001}, {'budgetMinutes': -1}, {'budgetMinutes': None}, {'budgetMinutes': 12.5}, {'budgetMinutes': 1441}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate_long_term_allocation({**value, **fields})

    def setUp(self):
        self.assertIsNotNone(SCHEMA, 'V2 plan validator must exist')
        self.plan = json.loads((ROOT / 'tests/fixtures/task-plan-v2.json').read_text(encoding='utf-8'))

    def test_shared_fixture_preserves_every_field(self):
        self.assertEqual(validate_task_plan(self.plan), self.plan)

    def test_rejects_duplicate_identity_and_unbacked_completion(self):
        self.plan['tasks'].append(copy.deepcopy(self.plan['tasks'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate-task-id'):
            validate_task_plan(self.plan)

    def test_rejects_boolean_float_and_empty_quantities(self):
        for value in (True, 1.5, 0, -1):
            with self.subTest(value=value):
                self.plan['tasks'][0]['quantity'] = value
                with self.assertRaisesRegex(ValueError, 'invalid-task-quantity'):
                    validate_task_plan(self.plan)

    def test_rejects_bad_date_unknown_fields_and_invalid_lock(self):
        for key, value, code in [('day','2026-02-30','invalid-plan-day'),
                                  ('schemaVersion',3,'unsupported-task-plan-version'),
                                  ('mastery','mastered','unknown-plan-field')]:
            value_plan = {**self.plan, key:value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, code):
                validate_task_plan(value_plan)
        self.plan['manual']['lockedTaskIds'] = ['missing']
        with self.assertRaisesRegex(ValueError, 'unknown-locked-task'):
            validate_task_plan(self.plan)

    def test_zero_time_does_not_remove_mandatory_review(self):
        self.plan['optionalMinutes'] = 0
        self.assertTrue(validate_task_plan(self.plan)['tasks'][0]['required'])
        self.plan['tasks'][0]['required'] = False
        with self.assertRaisesRegex(ValueError, 'required-review'):
            validate_task_plan(self.plan)

    def test_identifier_cannot_contain_a_null_character(self):
        self.plan['tasks'][0]['taskId'] = 'bad\x00id'
        with self.assertRaisesRegex(ValueError, 'invalid-taskId'):
            validate_task_plan(self.plan)

    def test_json_integer_valued_floats_match_javascript_and_normalize(self):
        self.plan['schemaVersion'] = 2.0
        self.plan['draftVersion'] = 1.0
        self.plan['vocabulary']['target'] = 20.0
        self.plan['tasks'][0]['quantity'] = 1.0
        self.plan['optionalMinutes'] = 0.0
        parsed = validate_task_plan(self.plan)
        self.assertIs(type(parsed['tasks'][0]['quantity']), int)
        self.assertIs(type(parsed['optionalMinutes']), int)
        self.assertIs(type(parsed['schemaVersion']), int)

    def test_word_identity_snapshot_and_order_roundtrip(self):
        self.plan['manual']['order'] = ['manual-one', 'review-one']
        self.plan['vocabulary']['manualSelection'] = True
        self.plan['vocabulary']['snapshot'] = [{'itemKey':'word:tree','subjectId':'vocab','word':'Tree','language':'en','sourceHash':'a'*64,'completionRule':'three-stage'}]
        self.assertEqual(validate_task_plan(self.plan), self.plan)
        self.plan['vocabulary']['snapshot'][0]['meaning'] = 'not identity metadata'
        with self.assertRaisesRegex(ValueError, 'unknown-word-snapshot-field'):
            validate_task_plan(self.plan)


if __name__ == '__main__':
    unittest.main()
