import copy
import importlib
import json
import pathlib
import unittest

try:
    schema = importlib.import_module('companion.long_term_plan_schema')
except ModuleNotFoundError:
    schema = None


class LongTermPlanSchemaTests(unittest.TestCase):
    def test_shared_minimum_advisory_vectors(self):
        fixture = json.loads((pathlib.Path(__file__).parent / 'fixtures/long-term-minimum.json').read_text(encoding='utf-8'))
        for snapshot in fixture['validSnapshots']:
            self.assertEqual(schema.parse_long_term_plan_snapshot(snapshot), snapshot)
        for case in fixture['invalidCases']:
            value = copy.deepcopy(fixture['validSnapshots'][case['base']])
            parent = value
            for key in case['path'][:-1]:
                parent = parent[key]
            parent[case['path'][-1]] = case['value']
            with self.subTest(name=case['name']), self.assertRaises(ValueError):
                schema.parse_long_term_plan_snapshot(value)

    def test_review_goal_is_optional_and_bounded(self):
        for count in (0, 20, 10000):
            value = {**self.snapshot['spec'], 'dailyReviewTarget': count}
            self.assertEqual(schema.parse_long_term_plan_spec(value)['dailyReviewTarget'], count)
        for count in (-1, 1.5, True, 10001):
            with self.assertRaises(ValueError):
                schema.parse_long_term_plan_spec({**self.snapshot['spec'], 'dailyReviewTarget': count})

    def setUp(self):
        self.assertIsNotNone(schema, 'long term schema must exist')
        self.snapshot = json.loads((pathlib.Path(__file__).parent / 'fixtures/long-term-plan.json').read_text())['snapshot']

    def test_shared_snapshot_round_trips_without_mutation(self):
        result = schema.parse_long_term_plan_snapshot(self.snapshot)
        self.assertEqual(result, self.snapshot)
        result['spec']['planId'] = 'changed'
        self.assertEqual(self.snapshot['spec']['planId'], 'fixture-plan')

    def test_subject_retention_is_validated_and_matches_forecast_assumptions(self):
        snapshot = copy.deepcopy(self.snapshot)
        subject = snapshot['spec']['subjectsConfig'][0]
        subject['forecastRetention'] = .85
        with self.assertRaises(ValueError):
            schema.parse_long_term_plan_snapshot(snapshot)
        snapshot['forecastAssumptions']['requestRetentionBySubject'] = {subject['subjectId']: .85}
        self.assertEqual(schema.parse_long_term_plan_snapshot(snapshot), snapshot)
        for rate in (True, .5, 1):
            subject['forecastRetention'] = rate
            with self.assertRaises(ValueError):
                schema.parse_long_term_plan_spec(snapshot['spec'])

    def test_shared_malformed_snapshot_cases(self):
        fixture = json.loads((pathlib.Path(__file__).parent / 'fixtures/long-term-plan.json').read_text())
        for case in fixture['invalidSnapshotCases']:
            snapshot = copy.deepcopy(fixture['snapshot'])
            parent = snapshot
            for key in case['path'][:-1]:
                parent = parent[key]
            parent[case['path'][-1]] = case['value']
            with self.subTest(name=case['name']), self.assertRaises(ValueError):
                schema.parse_long_term_plan_snapshot(snapshot)

    def test_dates_budgets_priorities_and_ids_are_strict(self):
        s = self.snapshot['spec']
        leap = copy.deepcopy(s)
        leap.update(startDate='2024-02-29', targetDeadline='2024-02-29')
        schema.parse_long_term_plan_spec(leap)
        for patch in ({'startDate': '2023-02-29'}, {'targetDeadline': '2026-02-30'}, {'targetDeadline': '2026-09-06'}):
            with self.assertRaises(ValueError):
                schema.parse_long_term_plan_spec({**s, **patch})
        for value in (-1, float('nan'), float('inf'), True):
            invalid = copy.deepcopy(s)
            invalid['dailyMinutesBudget']['workdayMax'] = value
            with self.assertRaises(ValueError):
                schema.parse_long_term_plan_spec(invalid)
        invalid = copy.deepcopy(s)
        invalid['subjectsConfig'][0]['priority'] = 6
        with self.assertRaises(ValueError):
            schema.parse_long_term_plan_spec(invalid)

    def test_snapshot_inconsistencies_are_rejected(self):
        cases = []
        p = copy.deepcopy(self.snapshot); p['totalInventoryCount'] = 7; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['inventory'].append(p['inventory'][0]); cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['newItemIds'].append('a:0'); cases.append(p)
        p = copy.deepcopy(self.snapshot); p['backlog'] = []; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['learningMinutes'] = 99; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['expectedNewItems']['a'] = 2; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['date'] = '2026-02-30'; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['adjustmentProposals'] = [{'kind':'magic','feasible':True,'remainingBacklogCount':0}]; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['budgetMinutes'] = 999; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['schedule'][0]['reviewReserveMinutes'] = 0; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['learningCompletedItemIds'] = ['a:1']; p['backlog'] = []; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['inventory'][0]['blockedReason'] = 'history-unknown'; cases.append(p)
        p = copy.deepcopy(self.snapshot); p['inventory'][0]['prerequisiteItemIds'] = ['a:1']; cases.append(p)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                schema.parse_long_term_plan_snapshot(value)

if __name__ == '__main__':
    unittest.main()
