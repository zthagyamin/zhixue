"""Cross-runtime protocol tests using synthetic TypeScript-sealed evidence."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
if importlib.util.find_spec('account_sync_schema'):
    import account_sync_schema as schema
else:
    schema = None

VECTORS = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))


class AccountSyncSchemaTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(schema, 'Standalone portable Companion schema must exist')
        self.v = copy.deepcopy(VECTORS)

    def resign(self, record, core=False):
        if core:
            record['event']['coreHash'] = schema.study_hash({k: v for k, v in record['event'].items() if k != 'coreHash'})
        record['envelopeHash'] = schema.study_hash({k: v for k, v in record.items() if k != 'envelopeHash'})
        return record

    def test_typescript_golden_content_and_records(self):
        self.assertEqual(schema.validate_bundle(self.v['bundle']), self.v['bundle'])
        for record in self.v['records'] + [self.v['legacy'], self.v['task']]:
            self.assertEqual(schema.validate_record(record), record)
        for item in self.v['bundle']['items']:
            self.assertEqual(schema.seal_item({k: v for k, v in item.items() if k != 'contentHash'}), item)
        snap = self.v['bundle']['snapshot']
        self.assertEqual(schema.seal_snapshot({k: v for k, v in snap.items() if k != 'snapshotHash'}), snap)

    def test_reads_are_nonmutating_and_bundle_uses_manifest_order(self):
        self.v['bundle']['items'].reverse()
        before = copy.deepcopy(self.v)
        self.assertEqual(schema.validate_bundle(self.v['bundle']), VECTORS['bundle'])
        schema.validate_record(self.v['records'][0])
        self.assertEqual(self.v, before)

    def test_forbidden_fields_and_invalid_hashes(self):
        for key in ('sourceNote', 'apiKey', 'localPath'):
            item = copy.deepcopy(self.v['bundle']['items'][0]); item['word'][key] = 'not-public'
            with self.assertRaises(ValueError): schema.validate_item(item)
        changed = self.v['records'][0]; changed['snapshotId'] = 'another-snapshot'
        with self.assertRaisesRegex(ValueError, 'integrity'): schema.validate_record(changed)
        changed = self.v['records'][1]; changed['event']['attempt']['stageAfter'] = 3
        self.resign(changed)
        with self.assertRaisesRegex(ValueError, 'core-hash'): schema.validate_record(changed)

    def test_strict_types_and_safe_integers(self):
        for value in (True, '1', 1.1, 9007199254740992):
            item = copy.deepcopy(self.v['bundle']['items'][0]); item['schemaVersion'] = value
            with self.assertRaises(ValueError): schema.validate_item(item)
        for value in (True, '0', -1, 0.5):
            snap = copy.deepcopy(self.v['bundle']['snapshot']); snap['eventCursor'] = value
            with self.assertRaises(ValueError): schema.validate_snapshot(snap)
        self.assertEqual(schema.study_hash({'z': 1.0, '😀': 2, '\ue000': 3}),
                         schema.study_hash({'z': 1, '😀': 2, '\ue000': 3}))

    def test_unicode_limits_and_invalid_scalar(self):
        body = self.v['bundle']['items'][0]; del body['contentHash']
        body['title'] = '🌳' * 2000
        schema.seal_item(body)
        body['title'] += 'x'
        with self.assertRaises(ValueError): schema.seal_item(body)
        body['title'] = '\ud800'
        with self.assertRaises(ValueError): schema.seal_item(body)
        body['title'] = '\ufeff'
        with self.assertRaises(ValueError): schema.seal_item(body)

    def test_required_reference_and_code_material(self):
        body = self.v['bundle']['items'][1]; del body['contentHash']
        del body['practice']['answer']
        with self.assertRaisesRegex(ValueError, 'reference'): schema.seal_item(body)
        body['practice']['questionType'] = 'code'; body['practice']['initialCode'] = 'pass'
        with self.assertRaisesRegex(ValueError, 'code'): schema.seal_item(body)
        body['practice']['testCode'] = 'assert 1 == 1'
        schema.seal_item(body)

    def test_bundle_missing_duplicate_or_changed_member(self):
        self.v['bundle']['items'].pop()
        with self.assertRaises(ValueError): schema.validate_bundle(self.v['bundle'])
        bundle = copy.deepcopy(VECTORS['bundle']); bundle['items'][1] = bundle['items'][0]
        with self.assertRaises(ValueError): schema.validate_bundle(bundle)
        bundle = copy.deepcopy(VECTORS['bundle']); bundle['items'][0]['title'] = 'Changed'
        with self.assertRaises(ValueError): schema.validate_bundle(bundle)

    def test_causal_ancestry_and_terminal(self):
        first, second, third = self.v['records']; item = self.v['bundle']['items'][0]
        self.assertEqual(schema.check_record_binding(third, item, [second]), 'pending-parent')
        self.assertEqual(schema.check_record_binding(third, item, [first, second]), 'ready')
        self.assertEqual(schema.check_record_binding(self.v['legacy'], item), 'ready')
        with self.assertRaisesRegex(ValueError, 'task-plan'): schema.check_record_binding(self.v['task'], item)

    def test_forks_and_reused_attempt_are_not_projected(self):
        first, second, third = self.v['records']; item = self.v['bundle']['items'][0]
        fork = copy.deepcopy(third); fork['event']['eventId'] = 'fork-final'; fork['attemptId'] = 'attempt-fork'
        self.resign(fork, core=True)
        with self.assertRaisesRegex(ValueError, 'fork'): schema.check_record_binding(third, item, [first, second, fork])
        third['attemptId'] = first['attemptId']; self.resign(third)
        with self.assertRaisesRegex(ValueError, 'attempt'): schema.check_record_binding(third, item, [first, second])

    def test_scheduling_and_legacy_provenance(self):
        first, second, third = self.v['records']; item = self.v['bundle']['items'][0]
        del third['event']['scheduling']; self.resign(third, core=True)
        with self.assertRaisesRegex(ValueError, 'scheduling'): schema.check_record_binding(third, item, [first, second])
        first['event']['scheduling'] = copy.deepcopy(VECTORS['records'][2]['event']['scheduling'])
        self.resign(first, core=True)
        with self.assertRaisesRegex(ValueError, 'scheduling'): schema.check_record_binding(first, item)
        second['parentEventId'] = self.v['legacy']['event']['eventId']; self.resign(second)
        with self.assertRaisesRegex(ValueError, 'parent'): schema.check_record_binding(second, item, [self.v['legacy']])

    def test_changed_scope_cycle_and_nonadjacent_ancestry(self):
        first, second, third = self.v['records']; item = self.v['bundle']['items'][0]
        first['originDeviceId'] = 'another-device'; self.resign(first)
        with self.assertRaisesRegex(ValueError, 'parent'): schema.check_record_binding(third, item, [first, second])
        first = copy.deepcopy(VECTORS['records'][0]); first['parentEventId'] = first['event']['eventId']; self.resign(first)
        with self.assertRaises(ValueError): schema.check_record_binding(first, item)

    def test_task_evidence_cannot_be_mutated_or_promoted_by_coercion(self):
        for field, value in (('schemaVersion', True), ('unitIds', ['unit-one', 'unit-one']),
                             ('source', ['self-report']), ('occurredAt', '2026-09-02T00:00:00.000Z')):
            task = copy.deepcopy(self.v['task']); task['event'][field] = value; self.resign(task, core=True)
            with self.assertRaises(ValueError): schema.validate_record(task)

    def test_canonical_times_and_no_client_projection(self):
        body = self.v['bundle']['snapshot']; del body['snapshotHash']
        body['generatedAt'] = '0000-02-29T00:00:00.000Z'
        schema.seal_snapshot(body)
        for at in ('2026-02-29T00:00:00.000Z', '2026-09-01T24:00:00.000Z', '2026-09-01T00:00:00Z'):
            body['generatedAt'] = at
            with self.assertRaises(ValueError): schema.seal_snapshot(body)
        record = self.v['records'][2]
        record['event']['scheduling']['clientStateAfter'] = {'due': '2026-09-02T00:00:00.000Z'}
        with self.assertRaises(ValueError): schema.validate_record(record)

    def test_dates_reject_unicode_digits_and_match_existing_fixed_utc8_day(self):
        body = self.v['bundle']['snapshot']; del body['snapshotHash']
        body['generatedAt'] = '2026-٠٩-٠١T00:00:00.000Z'
        with self.assertRaises(ValueError): schema.seal_snapshot(body)
        task = self.v['task']; task['event']['occurredAt'] = '1989-06-01T15:30:00.000Z'; task['event']['day'] = '1989-06-01'
        self.resign(task, core=True)
        self.assertEqual(schema.validate_record(task), task)

    def test_actual_plugin_mode_preserves_spelling_and_blocks_mixed_round(self):
        item = self.v['bundle']['items'][0]
        final = self.v['records'][2]; final['practiceMode'] = 'spelling'; final['parentEventId'] = None
        final['event']['attempt']['stageBefore'] = 0; self.resign(final, core=True)
        self.assertEqual(schema.check_record_binding(schema.validate_record(final), item), 'ready')
        body = {key: value for key, value in item.items() if key != 'contentHash'}
        body['word']['example'] = ''; body['completionRule'] = 'graded-practice'
        thin = schema.seal_item(body); final['contentHash'] = thin['contentHash']; self.resign(final)
        self.assertEqual(schema.check_record_binding(final, thin), 'ready')
        final['practiceMode'] = 'three-stage'; self.resign(final)
        with self.assertRaisesRegex(ValueError, 'mode'): schema.check_record_binding(final, thin)
        second = self.v['records'][1]; second['practiceMode'] = 'recall'; self.resign(second)
        with self.assertRaisesRegex(ValueError, 'round'): schema.check_record_binding(second, item, [self.v['records'][0]])

    def test_due_three_stage_word_accepts_quick_flashcard_review_and_separate_relearning(self):
        item = self.v['bundle']['items'][0]
        quick = copy.deepcopy(self.v['records'][2])
        quick['practiceMode'] = 'flashcard'; quick['roundId'] = 'quick-review-round'
        quick['parentEventId'] = None; quick['attemptId'] = 'quick-review-attempt'
        quick['event']['eventId'] = 'quick-review-event'
        quick['event']['attempt'] = {'rating': 'good', 'correct': True, 'stageBefore': 0, 'stageAfter': 3}
        self.resign(quick, core=True)
        self.assertEqual(schema.check_record_binding(schema.validate_record(quick), item), 'ready')

        failed = copy.deepcopy(quick)
        failed['roundId'] = 'forgot-review-round'; failed['attemptId'] = 'forgot-review-attempt'
        failed['event']['eventId'] = 'forgot-review-event'
        failed['event']['attempt'] = {'rating': 'again', 'correct': False, 'stageBefore': 0, 'stageAfter': 0}
        self.resign(failed, core=True)
        self.assertEqual(schema.check_record_binding(schema.validate_record(failed), item), 'ready')

        relearn = copy.deepcopy(self.v['records'][0])
        relearn['roundId'] = 'relearn-round'; relearn['attemptId'] = 'relearn-attempt'
        relearn['event']['eventId'] = 'relearn-event'
        self.resign(relearn, core=True)
        self.assertEqual(schema.check_record_binding(schema.validate_record(relearn), item, [failed]), 'ready')


if __name__ == '__main__':
    unittest.main()
