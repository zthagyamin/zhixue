"""Shared synthetic fixture verifies both Python persistence boundaries."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
from long_term_plan_schema import parse_practice_budget_groups, parse_long_term_plan_spec
from task_plan_schema import validate_long_term_allocation


class PracticeBudgetTests(unittest.TestCase):
    def test_shared_fixture(self):
        fixture = json.loads((ROOT / 'tests/fixtures/practice-budget.json').read_text(encoding='utf-8'))
        for group in fixture['valid']:
            self.assertEqual(parse_practice_budget_groups(group), group)
        for group in fixture['invalid']:
            with self.subTest(group=group):
                with self.assertRaises((ValueError, TypeError)):
                    parse_practice_budget_groups(group)

    def test_roundtrip_and_unknown_allocation_policy(self):
        groups = [{'id': 'papers', 'title': 'Papers', 'subjectIds': ['a', 'b'], 'minutes': 15, 'defaultItemMinutes': 3}]
        spec = {'planId': 'p', 'startDate': '2026-09-29', 'targetDeadline': '2026-09-30', 'dailyMinutesBudget': {'workdayMin': 0, 'workdayMax': 30, 'weekendMax': 30, 'minReviewRatio': 0}, 'subjectsConfig': [], 'bufferRatio': 0, 'practiceBudgetGroups': groups}
        self.assertEqual(parse_long_term_plan_spec(spec), spec)
        allocation = {'schemaVersion': 1, 'planId': 'p', 'day': '2026-09-29', 'vocabularyTarget': 0, 'items': [], 'practiceBudgetGroups': groups}
        self.assertEqual(validate_long_term_allocation(allocation), allocation)
        with self.assertRaises(ValueError):
            validate_long_term_allocation({**allocation, 'futureBudgetPolicy': True})


if __name__ == '__main__':
    unittest.main()
