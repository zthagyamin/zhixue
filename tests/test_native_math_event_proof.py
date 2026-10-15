"""Real math ledger and V3 receiver, using only a disposable source vault."""
import copy
import sqlite3
import unittest
from contextlib import closing
from unittest import mock

import test_native_math_service as math_fixture
import server
import index_gateway
from infrastructure.math_source_capture import NativeMathSources
from source_admission_fixture import bind_fixture_owner
from study_event_schema import compute_study_event_core_hash


class NativeMathEventProofTests(unittest.TestCase):
    def setUp(self):
        self.h = math_fixture.NativeMathServiceTests()
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.vault = self.h.vault
        self.owner = math_fixture.OWNER
        self.config = dict(server.CONFIG)
        self.db_path = server.LOCAL_DATABASE_PATH
        server.CONFIG['learning_vault_root'] = str(self.vault)
        server.LOCAL_DATABASE_PATH = self.h.db
        self.addCleanup(self.restore_server)
        bind_fixture_owner(server, self.owner)

    def restore_server(self):
        server.CONFIG.clear()
        server.CONFIG.update(self.config)
        server.LOCAL_DATABASE_PATH = self.db_path

    def event(self, rating='good', event_id='math-formal-1', correct=None):
        submitted = self.h.claim['attempt']['submitted']
        event = {'schemaVersion': 3, 'eventId': event_id, 'coreHash': '',
                 'occurredAt': submitted['submittedAt'], 'domain': 'differential-review',
                 'eventType': 'practice-attempt',
                 'item': {'kind': 'due', 'key': self.h.claim['identity']['itemKey']},
                 'attempt': {'rating': rating, 'correct': rating in ('good', 'easy') if correct is None else correct,
                             'stageBefore': 0, 'stageAfter': 3 if rating in ('good', 'easy') else 0},
                 'scheduling': {'reviewedAt': submitted['submittedAt'], 'schedulerVersion': server.SCHEDULER_VERSION}}
        event['coreHash'] = compute_study_event_core_hash(event)
        return event

    def prepare(self, event, answer='4'):
        self.h.claim['attempt']['answer'] = answer
        self.h.claim['attempt']['submitted']['answer'] = answer
        self.h.app.claim(self.h.claim)
        result = self.h.app.evaluate(self.h.request)
        self.h.app.claim({'schemaVersion': 1, 'action': 'formal', 'attemptId': 'a1',
                         'answerRevision': 1, 'sourceVersion': self.h.request['sourceVersion'],
                         'eventId': event['eventId'], 'evaluationHash': 'c' * 64,
                         'occurredAt': event['occurredAt']})
        return result

    def accept(self, event, write=True, owner=None, root=None):
        with closing(sqlite3.connect(self.h.db)) as db:
            result = server.accept_study_event_v3(db, root or self.vault, owner or self.owner,
                {'event': event, 'localContext': {'title': 'Synthetic arithmetic', 'activityType': 'website-practice'}}, write)
            db.commit()
            return result

    def event_count(self):
        with closing(sqlite3.connect(self.h.db)) as db:
            return db.execute('SELECT count(*) FROM study_events_v3').fetchone()[0]

    def test_actual_math_evidence_is_accepted_once_and_projects_only_its_original_source(self):
        event = self.event()
        self.assertEqual(self.prepare(event)['final']['status'], 'correct')
        source = (self.vault / 'courses/lesson.md').read_bytes()
        self.assertEqual(self.accept(event)['status'], 'accepted')
        self.assertEqual(self.accept(event)['status'], 'duplicate')
        self.assertEqual(self.event_count(), 1)
        self.assertEqual((self.vault / 'courses/lesson.md').read_bytes(), source)
        self.assertIn(b'ZHIXUE:LEARNING-EVIDENCE', (self.vault / 'courses/state.md').read_bytes())

    def test_cautious_rating_keeps_the_correct_final_evidence_without_promoting_the_event(self):
        event = self.event('again')
        self.prepare(event)
        self.assertEqual(self.accept(event)['status'], 'accepted')
        self.assertEqual(self.h.ledger.read('a1')['results'][0]['final']['status'], 'correct')
        self.assertFalse(event['attempt']['correct'])

    def test_wrong_final_cannot_be_promoted_to_a_correct_formal_event(self):
        event = self.event()
        self.assertEqual(self.prepare(event, '5')['final']['status'], 'incorrect')
        with self.assertRaisesRegex(ValueError, 'outcome|source-unverified'):
            self.accept(event)
        self.assertEqual(self.event_count(), 0)

    def test_source_edit_blocks_new_event_and_keeps_raw_answer(self):
        event = self.event()
        self.prepare(event)
        self.h.source(answer='5')
        with self.assertRaisesRegex(ValueError, 'source-changed|source-unverified'):
            self.accept(event)
        self.assertEqual(self.event_count(), 0)
        self.assertEqual(self.h.ledger.read('a1')['claim']['attempt']['submitted']['answer'], '4')

    def test_accepted_old_math_event_remains_an_exact_duplicate_after_source_edit(self):
        event = self.event()
        self.prepare(event)
        self.accept(event)
        self.h.source(answer='5')
        self.assertEqual(self.accept(event)['status'], 'duplicate')
        self.assertEqual(self.event_count(), 1)

    def test_new_event_cannot_use_another_owner_or_library_claim(self):
        event = self.event()
        self.prepare(event)
        other = self.h.data / 'other-vault'
        other.mkdir()
        for owner, root in [('2' * 64, self.vault), (self.owner, other)]:
            with self.subTest(owner=owner, root=root.name), self.assertRaises(ValueError):
                self.accept(event, write=False, owner=owner, root=root)
        self.assertEqual(self.event_count(), 0)

    def test_incorrect_final_is_saved_without_replacing_the_original_answer(self):
        event = self.event('again')
        self.prepare(event, '5')
        self.assertEqual(self.accept(event)['status'], 'accepted')
        self.assertEqual(self.h.ledger.read('a1')['claim']['attempt']['submitted']['answer'], '5')
        self.assertEqual(self.event_count(), 1)

    def test_item_time_and_claim_event_identity_must_match(self):
        event = self.event()
        self.prepare(event)
        wrong_item, wrong_time, wrong_event = [copy.deepcopy(event) for _ in range(3)]
        wrong_item['item']['key'] = 'practice:unrelated'
        wrong_time['scheduling']['reviewedAt'] = '2026-10-09T00:00:00.000Z'
        wrong_event['eventId'] = 'another-event'
        for changed in (wrong_item, wrong_time, wrong_event):
            changed['coreHash'] = compute_study_event_core_hash(changed)
            with self.subTest(event=changed['eventId']), self.assertRaises(ValueError):
                self.accept(changed)
        self.assertEqual(self.event_count(), 0)

    def test_independent_step_completion_during_source_recheck_does_not_change_final_admission(self):
        event = self.event()
        self.prepare(event)
        verify = NativeMathSources.verify_current
        completed = False
        def complete_step(source, *args, **kwargs):
            nonlocal completed
            result = verify(source, *args, **kwargs)
            if not completed:
                completed = True
                self.h.app.evaluate({**self.h.request, 'requestId': 'step-only', 'mode': 'step', 'stepRevision': 1})
            return result
        with mock.patch.object(NativeMathSources, 'verify_current', complete_step):
            self.assertEqual(self.accept(event)['status'], 'accepted')
        self.assertEqual(self.event_count(), 1)

    def test_source_edit_during_projection_rolls_back_the_event_without_removing_the_edit(self):
        event = self.event()
        self.prepare(event)
        state = self.vault / 'courses/state.md'
        original = state.read_bytes()
        record = index_gateway.record_subject_event
        def edit_source(*args, **kwargs):
            result = record(*args, **kwargs)
            self.h.source(answer='5')
            return result
        with mock.patch.object(index_gateway, 'record_subject_event', side_effect=edit_source):
            with self.assertRaisesRegex(ValueError, 'source-changed'):
                self.accept(event)
        self.assertEqual(self.event_count(), 0)
        self.assertEqual(state.read_bytes(), original)
        self.assertIn('| 5 |', (self.vault / 'courses/lesson.md').read_text(encoding='utf-8'))
