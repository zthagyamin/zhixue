"""Actual registered Markdown source admission and immutable native replay."""
import copy
import json
import sqlite3
import sys
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import test_index_gateway as fixtures
import index_gateway
from infrastructure.nonword_source_resolver import RegisteredExerciseResolver, exercise_presentation
from infrastructure.nonword_source_store import SourceAdmissionStore
from infrastructure.nonword_event_proof import source_event_guard, catalog_word
from infrastructure.native_writer import NativeStudyWriter, NativeWritePorts
from study_event_schema import compute_study_event_core_hash


class RegisteredSourceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.IndexGatewayTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.vault
        self.subject = self.fixture.subject()
        self.source = self.fixture.quiz(self.subject)
        self.catalog = index_gateway.load_gateway(self.root)
        self.item = self.catalog['subjects'][0]['items'][0]
        self.key = 'practice:' + self.item['itemId']
        self.now = datetime(2026, 10, 10, 10, tzinfo=timezone.utc)
        self.resolver = RegisteredExerciseResolver(self.root, 'owner-a',
            lambda root, **_: index_gateway.load_gateway(root))
        self.store = SourceAdmissionStore(self.root / 'temporary-source.db', 'owner-a', 'library-a', self.root,
            self.resolver, lambda item, answer: {'verdict': 'correct' if answer == item['answer'] else 'wrong',
                'correct': answer == item['answer'], 'explanation': 'Checked original reference.'}, lambda: self.now)
        self.query = {'itemKey': self.key, 'contentHash': self.item['contentHash'],
                      'presentation': exercise_presentation(self.item)}

    def prepare(self, key=None):
        query = copy.deepcopy(self.query)
        if key:
            query.update(itemKey=key, sourceItemKey=self.key)
        capture = self.store.capture(query)
        self.assertEqual(capture['status'], 'confirmed')
        self.store.submit({'attemptId': 'attempt-first', 'binding': capture['binding'], 'answerRevision': 1,
                           'answer': self.item['answer'], 'submittedAt': '2026-10-10T09:00:00.000Z',
                           'purpose': 'first', 'parentAttemptId': None, 'assistance': 'unknown'})
        self.assertEqual(self.store.evaluate({'attemptId': 'attempt-first', 'requestId': 'evaluate-first'})['status'], 'resolved')
        claim = self.store.claim({'attemptId': 'attempt-first', 'eventId': 'source-formal-first'})['claim']
        event = {'schemaVersion': 3, 'eventId': claim['eventId'], 'occurredAt': claim['occurredAt'],
                 'domain': 'differential-review', 'eventType': 'practice-attempt',
                 'item': {'kind': claim['eventKind'], 'key': claim['binding']['itemKey']},
                 'attempt': {'correct': claim['correct'], 'rating': claim['rating'], 'stageBefore': 0, 'stageAfter': 3}}
        event['coreHash'] = compute_study_event_core_hash(event)
        return event

    def writer(self):
        def proof(db, root, owner, event, catalog, course):
            return source_event_guard(db, root, owner, event, catalog,
                source_store=lambda *_: self.store, original_word=catalog_word, course_check=course)
        return NativeStudyWriter(NativeWritePorts(now=lambda: self.now, local_tz=timezone.utc,
            lock=threading.RLock(), gateway=index_gateway.load_gateway, dashboard=lambda *_: {},
            log_path=lambda day: self.root / 'logs' / (str(day) + '.jsonl'),
            vault_path=lambda ref: self.root / ref, read_activity=lambda _: [],
            render_report=lambda *_: self.root / 'report.md', report_events=lambda _: [],
            relative_path=lambda path: path.relative_to(self.root).as_posix(), source_guard=proof))

    def test_same_key_with_different_reference_is_not_source_confirmation(self):
        query = copy.deepcopy(self.query)
        query['presentation']['answer'] = 'Mars'
        self.assertEqual(self.store.capture(query)['status'], 'pending')

    def test_unique_complete_material_can_confirm_an_old_logical_identity(self):
        query = copy.deepcopy(self.query)
        query['itemKey'] = 'practice:generated:old-question'
        result = self.store.capture(query)
        self.assertEqual(result['status'], 'confirmed')
        self.assertEqual(result['binding']['itemKey'], query['itemKey'])
        self.assertEqual(result['sourceBinding']['itemKey'], self.key)
        other = self.fixture.subject('other')
        self.fixture.quiz(other)
        self.assertEqual(self.store.capture(query)['status'], 'pending')
        del query['presentation']['answer']
        self.assertEqual(self.store.capture(query)['status'], 'pending')

    def test_indexed_native_claim_ignores_caller_target_and_exact_replays_after_source_deleted(self):
        event = self.prepare('old-logical-question')
        with sqlite3.connect(':memory:') as db:
            writer = self.writer()
            result = writer.accept(db, self.root, 'owner-a', {'event': event,
                'localContext': {'stateRef': 'does-not-exist.md', 'abilityId': 'unrelated'}})
            self.assertEqual(result['status'], 'accepted')
            frozen = json.loads(db.execute('SELECT binding_json FROM study_event_bindings').fetchone()[0])
            self.assertEqual(frozen['context']['abilityId'], self.item['abilityId'])
            self.assertEqual(frozen['context']['stateRef'], self.subject + '/state.md')
            self.assertEqual(json.loads(db.execute('SELECT event_json FROM study_events_v3').fetchone()[0])['item']['key'], 'old-logical-question')
            history = index_gateway.progress_records(self.root, index_gateway.load_gateway(self.root), 'owner-a')
            self.assertEqual([row['event']['eventId'] for row in history], [event['eventId']])
            self.assertEqual(history[0]['sourceAssociationV1']['itemKey'], self.key)
            self.source.unlink()
            self.assertEqual(writer.accept(db, self.root, 'owner-a', {'event': event})['status'], 'duplicate')

    def test_new_frozen_route_cannot_replay_into_another_root(self):
        event = self.prepare()
        with sqlite3.connect(':memory:') as db:
            writer = self.writer()
            writer.accept(db, self.root, 'owner-a', {'event': event})
            second = self.root / 'other-vault'
            second.mkdir()
            with self.assertRaisesRegex(ValueError, 'source-admission-scope'):
                writer.accept(db, second, 'owner-a', {'event': event})
            self.assertEqual(list(second.rglob('*.jsonl')), [])

    def test_original_source_change_after_claim_rejects_before_formal_write(self):
        event = self.prepare()
        self.source.write_text(self.source.read_text(encoding='utf-8').replace('Grounded explanation', 'Changed reference'), encoding='utf-8')
        with sqlite3.connect(':memory:') as db:
            with self.assertRaisesRegex(ValueError, 'source-admission-source-changed'):
                self.writer().accept(db, self.root, 'owner-a', {'event': event})
            self.assertEqual(db.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 0)

    def test_registered_word_remains_word_when_display_mode_changes(self):
        word_root = self.fixture.subject('words', 'three-stage')
        self.fixture.write(word_root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning |\n|---|---|\n| River | 河 |\n')
        catalog = index_gateway.load_gateway(self.root)
        key = next(key for key, binding in catalog['bindings'].items() if binding['wordKey'] == 'river')
        self.assertTrue(catalog_word(key, catalog))
        self.assertFalse(catalog_word(self.key, catalog))
        event = {'schemaVersion': 3, 'eventId': 'registered-word-original',
                 'occurredAt': '2026-10-10T09:00:00.000Z', 'domain': 'ielts',
                 'eventType': 'practice-attempt', 'item': {'kind': 'word', 'key': key},
                 'attempt': {'rating': 'good', 'correct': True, 'stageBefore': 0, 'stageAfter': 3}}
        event['coreHash'] = compute_study_event_core_hash(event)
        with sqlite3.connect(':memory:') as db:
            self.assertEqual(self.writer().accept(db, self.root, 'owner-a', {'event': event})['status'], 'accepted')
            for kind in ('due', 'python'):
                forged = copy.deepcopy(event)
                forged['eventId'] = 'registered-word-forged-' + kind
                forged['item']['kind'] = kind
                forged['coreHash'] = compute_study_event_core_hash(forged)
                with self.assertRaisesRegex(ValueError, 'source-unverified'):
                    self.writer().accept(db, self.root, 'owner-a', {'event': forged})
            self.assertEqual(db.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 1)

    def test_queue_decorations_do_not_change_exercise_descriptor(self):
        original = self.resolver(self.query)
        def catalog(root, **_):
            loaded = index_gateway.load_gateway(root)
            loaded['subjects'][0]['items'][0]['dueAt'] = '2099-12-31'
            loaded['subjects'][0]['items'][0]['practiceItem'] = {
                **self.item, 'dueAt': '2099-12-31', 'questionType': 'quiz'}
            return loaded
        decorated = RegisteredExerciseResolver(self.root, 'owner-a', catalog)(self.query)
        self.assertEqual(decorated, original)


if __name__ == '__main__':
    unittest.main()
