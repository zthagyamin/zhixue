"""Actual V3 writer/SQL paths using frozen native course claims and temporary notes."""
import copy
import sqlite3
import unittest
from contextlib import closing
from datetime import datetime, timezone
from unittest import mock

import test_native_course_service as native_fixture
from infrastructure.course_event_proof import native_course_event_guard
from infrastructure.native_writer import NativeStudyWriter, NativeWritePorts
from study_event_schema import compute_study_event_core_hash, ensure_study_v3_schema
import index_gateway


class NativeCourseEventProofTests(unittest.TestCase):
    def setUp(self):
        self.h = native_fixture.Harness()
        self.addCleanup(self.h.close)
        self.request = self.h.request()
        self.owner = native_fixture.source_fixture.OWNER
        self.vault = self.h.source.vault

        def forbidden(*_):
            self.fail('Registered native course event used a legacy writer')

        self.writer = NativeStudyWriter(NativeWritePorts(
            now=lambda: datetime(2026, 10, 6, 2, tzinfo=timezone.utc), local_tz=timezone.utc,
            lock=index_gateway.LOCK, gateway=self.catalog, dashboard=forbidden,
            log_path=forbidden, vault_path=forbidden, read_activity=forbidden,
            render_report=forbidden, report_events=forbidden, relative_path=forbidden,
            course_guard=lambda db, root, owner, event, catalog: native_course_event_guard(
                db, root, owner, event, catalog, catalog_loader=self.h.source.loader, store_path=self.h.source.db)))

    def catalog(self, root, **_):
        return self.h.source.loader(root, owner=self.owner, refresh=False)

    def event(self, rating='good', event_id='event-1', correct=None):
        value = {'schemaVersion': 3, 'eventId': event_id, 'coreHash': '',
                 'occurredAt': self.request['submission']['submittedAt'], 'domain': 'differential-review',
                 'eventType': 'practice-attempt', 'item': {'kind': 'due', 'key': self.request['binding']['itemKey']},
                 'attempt': {'rating': rating, 'correct': rating in ('good', 'easy') if correct is None else correct,
                             'stageBefore': 0, 'stageAfter': 3 if rating in ('good', 'easy') else 0},
                 'scheduling': {'reviewedAt': self.request['submission']['submittedAt'],
                                'schedulerVersion': 'ts-fsrs-5.4.1-default-v1'}}
        value['coreHash'] = compute_study_event_core_hash(value)
        return value

    def claim(self, *, action='evaluate', status=None, rating='good'):
        request = {**self.request, 'action': action, **({'selfStatus': status} if status else {})}
        receipt = self.h.app.grade(request)
        claim = self.h.claim(request, receipt, rating=rating)
        self.h.app.claim(claim)
        return receipt

    def accept(self, event, write=False):
        with closing(sqlite3.connect(self.h.source.db)) as db:
            return self.writer.accept(db, self.vault, self.owner, {'event': event, 'localContext': {}}, write)

    def event_count(self):
        with closing(sqlite3.connect(self.h.source.db)) as db:
            return db.execute('SELECT count(*) FROM study_events_v3').fetchone()[0]

    def test_no_course_claim_cannot_save_any_formal_event(self):
        with self.assertRaisesRegex(ValueError, 'claim-required'):
            self.accept(self.event())
        self.assertEqual(self.event_count(), 0)

    def test_actual_claim_saves_once_and_exact_old_duplicate_survives_source_changes(self):
        self.claim()
        first = self.accept(self.event())
        self.assertEqual(first['status'], 'accepted')
        self.assertTrue(first['companionReceipt']['durable'])
        self.h.source.source(answer='A conflicting new reference')
        self.assertEqual(self.accept(self.event())['status'], 'duplicate')
        self.assertEqual(self.event_count(), 1)

    def test_event_rating_item_time_and_outcome_must_match_original_claim(self):
        self.claim(action='self-assess', status='incorrect', rating='again')
        events = [self.event(rating='good'), self.event(rating='again', correct=True)]
        wrong_time = self.event(rating='again')
        wrong_time['scheduling']['reviewedAt'] = '2026-10-06T02:00:00.000Z'
        wrong_item = self.event(rating='again')
        wrong_item['item']['key'] = 'practice:other'
        wrong_day = self.event(rating='again')
        wrong_day['occurredAt'] = '2026-10-07T01:00:00.000Z'
        for event in [*events, wrong_time, wrong_item, wrong_day]:
            event['coreHash'] = compute_study_event_core_hash(event)
            with self.subTest(event=event['item']['key']), self.assertRaises(ValueError):
                self.accept(event)
        self.assertEqual(self.event_count(), 0)

    def test_known_course_event_cannot_fall_through_legacy_in_another_configured_root(self):
        self.claim()
        other = self.h.source.data / 'another-vault'
        other.mkdir()
        with closing(sqlite3.connect(self.h.source.db)) as db:
            ensure_study_v3_schema(db)
            with self.assertRaisesRegex(ValueError, 'claim-required'):
                native_course_event_guard(db, other, self.owner, self.event(), {'active': False, 'subjects': []},
                    catalog_loader=self.h.source.loader, store_path=self.h.source.db)

    def test_real_note_projection_keeps_metadata_and_replays_without_second_event(self):
        self.claim()
        state = self.vault / 'courses/state.md'
        header = state.read_bytes()
        self.assertEqual(self.accept(self.event(), write=True)['status'], 'accepted')
        written = state.read_bytes()
        self.assertTrue(written.startswith(header))
        self.assertIn(b'ZHIXUE:LEARNING-EVIDENCE', written)
        self.assertEqual(self.accept(self.event(), write=True)['status'], 'duplicate')
        self.assertEqual(state.read_bytes(), written)
        self.assertEqual(self.event_count(), 1)

    def test_current_source_change_blocks_new_write_but_preserves_original_diagnosis(self):
        self.claim()
        self.h.source.source(answer='A conflicting new reference')
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.accept(self.event())
        self.assertEqual(self.event_count(), 0)
        self.assertEqual(self.h.ledger.read_attempt('attempt-1')['receipt']['diagnostic']['status'], 'correct')

    def test_source_edit_during_projection_rolls_back_only_own_event_and_state(self):
        self.claim()
        state = self.vault / 'courses/state.md'
        before = state.read_bytes()
        write = index_gateway.record_subject_event

        def edit_after_journal(*args, **kwargs):
            value = write(*args, **kwargs)
            self.h.source.support['criteria'][0]['text'] += ' Changed independently during projection.'
            self.h.source.source()
            return value

        with mock.patch.object(index_gateway, 'record_subject_event', side_effect=edit_after_journal):
            with self.assertRaisesRegex(ValueError, 'source-changed'):
                self.accept(self.event(), write=True)
        self.assertEqual(self.event_count(), 0)
        self.assertEqual(state.read_bytes(), before)
        self.assertIn('Changed independently', (self.vault / 'courses/lesson.md').read_text(encoding='utf-8'))

    def test_legacy_word_admission_never_opens_a_native_course_ledger(self):
        with closing(sqlite3.connect(self.h.source.db)) as db:
            ensure_study_v3_schema(db)
            event = self.event()
            event['item'] = {'kind': 'word', 'key': 'word-legacy'}
            with mock.patch('infrastructure.course_event_proof.CourseGradeLedger', side_effect=AssertionError('legacy ledger')):
                self.assertIsNone(native_course_event_guard(db, self.vault, 'legacy-owner', event, {},
                    catalog_loader=self.h.source.loader, store_path=self.h.source.db))


if __name__ == '__main__':
    unittest.main()
