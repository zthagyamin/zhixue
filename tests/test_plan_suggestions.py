"""Grounded bounded suggestions, without network or real vault state."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
try:
    from plan_suggestions import suggest_tasks
except ImportError:
    suggest_tasks = None


class SuggestionTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {'schemaVersion': 1, 'sourceHash': 'a' * 64, 'subjects': [], 'diagnostics': []}
        for s in range(4):
            subject = {'subjectId': f's{s}', 'name': f'Subject{s}', 'priority': 3, 'planningStatus': 'none', 'goals': [], 'words': [], 'units': []}
            for u in range(2):
                subject['units'].append({'unitId': f's{s}:u{u}', 'subjectId': f's{s}', 'title': f'Lesson{u}', 'order': u,
                    'sourceHash': 'b' * 64, 'prerequisites': [], 'formalComplete': False, 'completionRule': 'self-report',
                    'action': {'kind': 'open-note', 'contentRef': '[[PRIVATE-SOURCE]]'}, 'estimatedMinutes': 5})
            self.catalog['subjects'].append(subject)
        self.catalog['subjects'][3]['units'][1]['prerequisites'] = ['s3:u0']
        self.request = {'day': '2026-08-31', 'sourceHash': 'a' * 64, 'draftVersion': 3, 'excludedUnitIds': [], 'selectedUnitIds': [], 'intent': 'standard'}

    def suggest(self, ai=lambda _: {'choices': [{'ref': '2', 'count': 1}]}):
        self.assertTrue(callable(suggest_tasks), 'Suggestion adapter must exist')
        return suggest_tasks(self.catalog, self.request, ai)

    def test_ai_selects_real_non_first_unit_without_source_body(self):
        def ai(messages):
            self.assertNotIn('PRIVATE-SOURCE', json.dumps(messages))
            self.assertNotIn('sourceHash', json.dumps(messages))
            self.assertNotIn('s0:u0', json.dumps(messages))
            return {'choices': [{'ref': '2', 'count': 1, 'reason': 'Continue this lesson'}]}
        before = copy.deepcopy(self.catalog)
        result = self.suggest(ai)
        self.assertEqual(result['mode'], 'ai')
        self.assertEqual(result['selections'][0]['unitIds'], ['s0:u1'])
        self.assertEqual(self.catalog, before)
        for key in ('day', 'sourceHash', 'draftVersion'):
            self.assertEqual(result[key], self.request[key])

    def test_invalid_ai_payloads_fall_back_without_invention(self):
        for value in (None, [], {}, {'choices': []}, {'choices': [{'ref': 'unknown', 'count': 1}]},
                      {'choices': [{'ref': [], 'count': 1}]}, {'choices': [{'ref': '1', 'count': True}]},
                      {'choices': [{'ref': '1', 'count': 1.5}]}, {'choices': [{'ref': '1', 'count': 0}]},
                      {'choices': [{'ref': '1', 'count': 999}]},
                      {'choices': [{'ref': '1', 'count': 1}, {'ref': '1', 'count': 1}]},
                      {'choices': [{'ref': '1', 'count': 1}, {'ref': '2', 'count': 1}]}):
            with self.subTest(value=value):
                result = self.suggest(lambda _, value=value: value)
                self.assertEqual(result['mode'], 'fallback')
                ids = [id for selection in result['selections'] for id in selection['unitIds']]
                self.assertEqual(ids, ['s0:u0', 's1:u0', 's2:u0'])

    def test_provider_failure_is_sanitized_and_actionable(self):
        for error in (TimeoutError('private provider details'), RuntimeError('private provider details'), ValueError('invalid JSON')):
            def ai(_):
                raise error
            result = self.suggest(ai)
            self.assertEqual(result['mode'], 'fallback')
            self.assertIn('AI', result['message'])
            self.assertNotIn('private', result['message'])

    def test_exclusions_selected_and_unmet_prerequisites_never_reenter(self):
        self.request['excludedUnitIds'] = ['s0:u0', 's1:u0', 's1:u1']
        self.request['selectedUnitIds'] = ['s2:u0', 's2:u1', 's3:u0']
        result = self.suggest(lambda _: None)
        self.assertEqual([s['unitIds'] for s in result['selections']], [['s0:u1']])

    def test_explicit_goals_invalid_planning_and_completed_units_are_not_ai_candidates(self):
        self.catalog['subjects'][0]['goals'] = [{'goalId': 'explicit'}]
        self.catalog['subjects'][1]['planningStatus'] = 'invalid'
        for unit in self.catalog['subjects'][2]['units']:
            unit['formalComplete'] = True
        result = self.suggest(lambda _: None)
        self.assertEqual([s['unitIds'] for s in result['selections']], [['s3:u0']])

    def test_less_makes_no_provider_request_or_new_task(self):
        self.request['intent'] = 'less'
        result = self.suggest(lambda _: self.fail('AI unnecessary'))
        self.assertEqual(result['selections'], [])

    def test_more_can_choose_two_units_but_expands_only_to_three_total(self):
        self.request['intent'] = 'more'
        result = self.suggest(lambda _: {'choices': [{'ref': '1', 'count': 2}, {'ref': '3', 'count': 1}]})
        self.assertEqual(result['mode'], 'ai')
        self.assertEqual([id for s in result['selections'] for id in s['unitIds']], ['s0:u0', 's0:u1', 's1:u0'])
        result = self.suggest(lambda _: {'choices': [{'ref': '1', 'count': 2}, {'ref': '3', 'count': 2}]})
        self.assertEqual(result['mode'], 'fallback')
        self.assertLessEqual(sum(len(s['unitIds']) for s in result['selections']), 3)

    def test_optional_reference_limits_known_estimates_without_claiming_unknown_is_zero(self):
        self.request['optionalMinutes'] = 6
        result = self.suggest(lambda _: None)
        self.assertEqual(len(result['selections']), 1)
        self.catalog['subjects'][0]['units'][0].pop('estimatedMinutes')
        result = self.suggest(lambda _: None)
        self.assertIn('估时', result['message'])

    def test_stale_or_malformed_request_is_rejected_before_ai(self):
        for update in ({'sourceHash': 'c' * 64}, {'day': '2026-02-30'}, {'draftVersion': True},
                       {'intent': 'invent'}, {'excludedUnitIds': ['x', 'x']}, {'optionalMinutes': -1}, {'catalog': {}}):
            original = self.request
            self.request = {**original, **update}
            with self.subTest(update=update), self.assertRaises(ValueError):
                self.suggest(lambda _: self.fail('must validate before AI'))
            self.request = original

    def test_fallback_priority_then_longest_idle_then_stable_id(self):
        self.catalog['subjects'][1]['priority'] = 9
        self.catalog['subjects'][0]['lastProgressAt'] = '2026-08-30T00:00:00Z'
        self.catalog['subjects'][2]['lastProgressAt'] = '2026-08-20T00:00:00Z'
        self.catalog['subjects'][3]['lastProgressAt'] = '2026-08-10T00:00:00Z'
        result = self.suggest(lambda _: None)
        self.assertEqual([s['unitIds'][0] for s in result['selections']], ['s1:u0', 's3:u0', 's2:u0'])

    def test_empty_catalog_does_not_call_provider(self):
        self.catalog['subjects'] = []
        self.assertEqual(self.suggest(lambda _: self.fail('no candidates'))['selections'], [])

    def test_large_subject_does_not_consume_the_entire_bounded_candidate_input(self):
        subject = self.catalog['subjects'][0]
        template = subject['units'][0]
        subject['units'] = [{**template, 'unitId': f's0:u{i}', 'order': i} for i in range(300)]
        captured = []
        def ai(messages):
            captured.extend(json.loads(messages[1]['content'])['units'])
            return None
        result = self.suggest(ai)
        self.assertLessEqual(len(captured), 200)
        self.assertEqual([s['unitIds'][0] for s in result['selections']], ['s0:u0', 's1:u0', 's2:u0'])

    def test_provider_sees_usable_remaining_count_at_each_reference(self):
        def ai(messages):
            units = json.loads(messages[1]['content'])['units']
            self.assertEqual(units[0]['availableCount'], 2)
            self.assertEqual(units[1]['availableCount'], 1)
            return {'choices': [{'ref': '2', 'count': 1}]}
        self.assertEqual(self.suggest(ai)['mode'], 'ai')
