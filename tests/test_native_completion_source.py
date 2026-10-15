"""Current completion from real native writes in synthetic temporary vaults."""
import copy
import json
import unittest

import test_native_course_event_proof as native_proof
import index_gateway
import planning_evidence
from study_event_schema import validate_study_event_v3


class NativeCompletionSourceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = native_proof.NativeCourseEventProofTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.vault = self.fixture.vault
        self.fixture.claim()
        self.event = self.fixture.event()
        self.assertEqual(self.fixture.accept(self.event, write=True)['status'], 'accepted')

    def context(self):
        gateway = self.fixture.catalog(self.vault)
        return planning_evidence.build_context(
            self.vault, gateway, self.fixture.owner, validate_study_event_v3,
            catalog_loader=self.fixture.catalog)

    def unit(self, context):
        return next(unit for subject in context['catalog']['subjects'] for unit in subject['units']
                    if unit['action'].get('itemKeys') == [self.event['item']['key']])

    def records(self):
        return planning_evidence.read_records(
            self.vault, self.fixture.catalog(self.vault), self.fixture.owner, validate_study_event_v3)

    def test_same_id_changed_source_cannot_complete_current_unit_and_preserves_original_evidence(self):
        before = self.context()
        self.assertTrue(self.unit(before)['taskComplete'])
        records = copy.deepcopy(self.records())
        original_attempt = self.fixture.h.ledger.read_attempt('attempt-1')
        state = self.vault / 'courses/state.md'
        state_bytes = state.read_bytes()
        journals = {path: path.read_bytes() for path in self.vault.rglob('*.jsonl')}
        source = self.vault / 'courses/lesson.md'
        metadata = source.read_bytes().split(b'---', 2)[:2]
        self.fixture.h.source.support['criteria'][0]['text'] += ' Changed concept condition.'
        self.fixture.h.source.support['task']['sources'][0]['excerpt'] += ' New concept condition.'
        self.fixture.h.source.source()
        after = self.context()
        current = next(item for item in after['catalog']['practiceSources']
                       if item['itemKey'] == self.event['item']['key'])
        self.assertNotEqual(current['sourceHash'], records[0]['planningEvidence']['itemSource']['sourceHash'])
        self.assertEqual(self.records(), records)
        self.assertEqual({path: path.read_bytes() for path in journals}, journals)
        self.assertEqual(state.read_bytes(), state_bytes)
        self.assertEqual(source.read_bytes().split(b'---', 2)[:2], metadata)
        self.assertEqual(self.fixture.h.ledger.read_attempt('attempt-1'), original_attempt)
        self.assertEqual(self.fixture.accept(self.event, write=True)['status'], 'duplicate')
        self.assertEqual(state.read_bytes(), state_bytes)
        self.assertEqual(self.fixture.event_count(), 1)
        self.assertFalse(self.unit(after)['taskComplete'])

    def test_old_journal_without_source_metadata_is_retained_but_not_current_completion(self):
        self.assertTrue(self.unit(self.context())['taskComplete'])
        gateway = self.fixture.catalog(self.vault)
        binding = index_gateway.lookup_binding(gateway, self.event['item']['key'])
        journal = index_gateway.subject_event_path(self.vault, binding, self.event)
        rows = [json.loads(line) for line in journal.read_text(encoding='utf-8').splitlines()]
        for row in rows:
            row.pop('planningEvidence', None)
        journal.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf-8')
        state_bytes = (self.vault / 'courses/state.md').read_bytes()
        context = self.context()
        self.assertEqual(self.records()[0]['event'], self.event)
        self.assertEqual(self.fixture.event_count(), 1)
        self.assertEqual((self.vault / 'courses/state.md').read_bytes(), state_bytes)
        self.assertFalse(self.unit(context)['taskComplete'])


if __name__ == '__main__':
    unittest.main()
