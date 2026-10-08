import copy
import importlib.util
import itertools
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_schema as schema
if importlib.util.find_spec('account_sync_projection'):
    import account_sync_projection as projection
else:
    projection = None

V = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
CARD = '''---
type: learning-result
review_date: 2026-09-01
review_enabled: true
---
# Original material
Keep this paragraph and [[source]].
'''


def record(event_id, when, rating):
    value = copy.deepcopy(V['records'][2]); value.update(practiceMode='recall', roundId=event_id, attemptId=event_id, parentEventId=None)
    value['event']['eventId'] = event_id; value['event']['occurredAt'] = when
    value['event']['attempt'] = {'correct': rating != 'again', 'rating': rating, 'stageBefore': 0, 'stageAfter': 0 if rating == 'again' else 3}
    value['event']['scheduling']['reviewedAt'] = when
    value['event']['coreHash'] = schema.study_hash({k: v for k, v in value['event'].items() if k != 'coreHash'})
    value['envelopeHash'] = schema.study_hash({k: v for k, v in value.items() if k != 'envelopeHash'})
    return {'record': value, 'entryName': 'Reference point'}


class AccountSyncProjectionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(projection, 'Chronological review projection must exist')

    def test_all_arrival_orders_replay_to_same_latest_failure(self):
        baseline = projection.capture_review_baseline(CARD, {}, '2026-09-01T00:00:00.000Z')
        evidence = [record('good-one', '2026-09-01T01:00:00.000Z', 'good'), record('good-two', '2026-09-08T01:00:00.000Z', 'good'),
                    record('again-last', '2026-09-09T01:00:00.000Z', 'again')]
        results = [projection.replay_review_queue(baseline, list(order)) for order in itertools.permutations(evidence)]
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(results[0]['entries'][0]['chain'], 0)
        self.assertEqual(results[0]['entries'][0]['due'], '2026-09-10')
        self.assertTrue(results[0]['reviewEnabled'])

    def test_occurred_day_not_delivery_day_and_duplicate_does_not_count_twice(self):
        baseline = projection.capture_review_baseline(CARD, {}, '2026-09-01T00:00:00.000Z')
        event = record('night-review', '2026-09-01T16:01:00.000Z', 'good')
        result = projection.replay_review_queue(baseline, [event, event])
        self.assertEqual(result['entries'][0]['due'], '2026-09-09')
        self.assertEqual(result['entries'][0]['chain'], 1)
        self.assertEqual(len(result['eventIds']), 1)

    def test_baseline_included_history_is_not_recounted(self):
        event = record('known-review', '2026-08-31T01:00:00.000Z', 'good')
        import review_queue
        card = CARD + '\n' + review_queue._render_queue([{'name': 'Reference point', 'due': '2026-09-07', 'attempts': 1, 'chain': 1, 'last': 'good', 'done': False, 'note': ''}], ['known-review'])
        baseline = projection.capture_review_baseline(card, {'known-review': event['record']['event']['coreHash']}, '2026-09-01T00:00:00.000Z')
        result = projection.replay_review_queue(baseline, [event])
        self.assertEqual(result['entries'][0]['chain'], 1)
        with self.assertRaisesRegex(ValueError, 'baseline'): projection.capture_review_baseline(card, {}, '2026-09-01T00:00:00.000Z')
        old_unknown = record('unknown-old', '2026-08-31T01:00:00.000Z', 'good')
        with self.assertRaisesRegex(ValueError, 'baseline'): projection.replay_review_queue(baseline, [old_unknown])

    def test_successful_intermediate_stages_never_schedule_or_promote(self):
        baseline = projection.capture_review_baseline(CARD, {}, '2026-09-01T00:00:00.000Z')
        first = {'record': V['records'][0], 'entryName': 'Reference point'}
        result = projection.replay_review_queue(baseline, [first])
        self.assertEqual(result['entries'], [])
        self.assertEqual(projection.effective_events([V['records'][0], V['records'][1], V['records'][2]]), [V['records'][2]['event']])

    def test_render_preserves_user_text_and_rejects_malformed_or_manual_queue(self):
        baseline = projection.capture_review_baseline(CARD, {}, '2026-09-01T00:00:00.000Z')
        state = projection.replay_review_queue(baseline, [record('one-good', '2026-09-01T01:00:00.000Z', 'good')])
        after = projection.render_review_queue(CARD, state)
        self.assertIn('Keep this paragraph and [[source]].', after)
        self.assertIn('review_date: 2026-09-08', after)
        self.assertNotEqual(projection.review_fingerprint(CARD), projection.review_fingerprint(after))
        with self.assertRaises(ValueError): projection.capture_review_baseline(CARD + '\n%% ZHIXUE:REVIEW-QUEUE:BEGIN %%\n- manual malformed line\n%% ZHIXUE:REVIEW-QUEUE:END %%', {}, '2026-09-01T00:00:00.000Z')

    def test_new_evidence_block_does_not_overwrite_legacy_or_formal_mastery(self):
        original = '---\ntype: zhixue-practice-state\n---\n# State\nUser text\n%% ZHIXUE:LEARNING-EVIDENCE:BEGIN %%\nLegacy ability\n%% ZHIXUE:LEARNING-EVIDENCE:END %%\n'
        updated = projection.render_account_evidence(original, {'word:tree': [V['records'][2]['event']]})
        self.assertIn('Legacy ability', updated); self.assertIn('User text', updated)
        self.assertIn('ACCOUNT-LEARNING-EVIDENCE', updated)
        self.assertNotIn('mastered', updated)
        self.assertEqual(projection.render_account_evidence(updated, {'word:tree': [V['records'][2]['event']]}), updated)

    def test_crlf_is_preserved_in_properties_and_both_managed_blocks(self):
        card = CARD.replace('\n', '\r\n')
        baseline = projection.capture_review_baseline(card, {}, '2026-09-01T00:00:00.000Z')
        state = projection.replay_review_queue(baseline, [record('crlf-good', '2026-09-01T01:00:00.000Z', 'good')])
        result = projection.render_review_queue(card, state)
        self.assertNotIn('\n', result.replace('\r\n', ''))
        state_text = '---\r\ntype: zhixue-practice-state\r\n---\r\n# State\r\nKeep me\r\n'
        result = projection.render_account_evidence(state_text, {'word:tree': [V['records'][2]['event']]})
        self.assertNotIn('\n', result.replace('\r\n', ''))

    def test_non_scheduling_history_does_not_invalidate_later_baseline(self):
        baseline = projection.capture_review_baseline(CARD, {}, '2026-09-02T00:00:00.000Z')
        state = projection.replay_review_queue(baseline, [{'record': V['records'][0], 'entryName': 'Reference point'}, {'record': V['task'], 'entryName': 'Task'}])
        self.assertEqual(state['entries'], [])

    def test_known_hash_without_queue_journal_cannot_be_silently_skipped(self):
        event = record('not-yet-applied', '2026-09-01T01:00:00.000Z', 'good')
        baseline = projection.capture_review_baseline(CARD, {'not-yet-applied': event['record']['event']['coreHash']}, '2026-09-01T00:00:00.000Z')
        self.assertEqual(projection.replay_review_queue(baseline, [event])['entries'][0]['chain'], 1)

    def test_duplicate_empty_journals_are_rejected(self):
        card = CARD + '\n%% ZHIXUE:REVIEW-QUEUE:BEGIN %%\n<!-- ZHIXUE:REVIEW-EVENTS W10= -->\n<!-- ZHIXUE:REVIEW-EVENTS W10= -->\n%% ZHIXUE:REVIEW-QUEUE:END %%'
        with self.assertRaises(ValueError): projection.capture_review_baseline(card, {}, '2026-09-01T00:00:00.000Z')

    def test_yaml_false_with_comment_keeps_disabled_state_and_comment(self):
        card = CARD.replace('review_enabled: true', 'review_enabled: false # paused by user')
        baseline = projection.capture_review_baseline(card, {}, '2026-09-01T00:00:00.000Z')
        self.assertFalse(baseline['reviewEnabled'])
        rendered = projection.render_review_queue(card, projection.replay_review_queue(baseline, []))
        self.assertIn('review_enabled: false # paused by user', rendered)


if __name__ == '__main__': unittest.main()
