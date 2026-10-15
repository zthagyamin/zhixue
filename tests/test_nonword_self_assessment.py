"""Explicit immutable self-assessment, actual registered material and disposable SQLite."""
import copy
import json
import sqlite3
import sys
import threading
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'companion'), str(Path(__file__).resolve().parent)]
import test_index_gateway as gateway_fixture
import index_gateway
from infrastructure.nonword_source_store import SourceAdmissionStore
from infrastructure.nonword_source_resolver import RegisteredExerciseResolver, exercise_presentation
from infrastructure.nonword_event_proof import source_event_guard, catalog_word
from infrastructure.native_writer import NativeStudyWriter, NativeWritePorts
from infrastructure.source_protocol_hash import fingerprint
from study_event_schema import compute_study_event_core_hash


class SelfAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.h = gateway_fixture.IndexGatewayTests()
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.root = self.h.vault
        self.subject = self.h.subject('original-cards', 'flashcard')
        self.source = self.h.write(self.subject + '/cards.md',
            '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: cards\n'
            'zhixue_format: flashcard\nstatus: ready\n---\n'
            '| ID | front | back |\n|---|---|---|\n| q1 | Recall one source fact | Source fact |\n')
        self.item = index_gateway.load_gateway(self.root)['subjects'][0]['items'][0]
        self.query = {'itemKey': 'practice:' + self.item['itemId'], 'contentHash': self.item['contentHash'],
                      'presentation': exercise_presentation(self.item)}
        self.resolver = RegisteredExerciseResolver(self.root, 'owner-a', lambda root, **_: index_gateway.load_gateway(root))
        self.available = True
        self.grade = mock.Mock(side_effect=AssertionError('Explicit flashcard assessment must never invoke a grader.'))
        self.now = datetime(2026, 10, 10, 10, tzinfo=timezone.utc)
        self.path = self.root / 'temporary-assessments.db'
        self.store = self.make_store()

    def make_store(self, owner='owner-a', library='library-a', root=None):
        return SourceAdmissionStore(self.path, owner, library, root or self.root,
            lambda query: self.resolver(query) if self.available else None,
            self.grade, lambda: self.now)

    def submit(self, attempt='first', purpose='first', parent=None):
        capture = self.store.capture(self.query)
        request = {'attemptId': attempt, 'binding': capture['binding'], 'answerRevision': 1,
                   'answer': '', 'submittedAt': '2026-10-10T09:00:00.000Z',
                   'purpose': purpose, 'parentAttemptId': parent, 'assistance': 'observed'}
        self.store.submit(request)
        return request

    def assessment(self, submission, rating='good'):
        return {'schemaVersion': 1, 'attemptId': submission['attemptId'], 'binding': submission['binding'],
                'answerRevision': submission['answerRevision'], 'submittedAt': submission['submittedAt'],
                'rating': rating}

    def evaluate(self, attempt='first', request='grade-first'):
        return self.store.evaluate({'attemptId': attempt, 'requestId': request})

    def event(self, claim):
        event = {'schemaVersion': 3, 'eventId': claim['eventId'], 'occurredAt': claim['occurredAt'],
                 'domain': 'differential-review', 'eventType': 'practice-attempt',
                 'item': {'key': claim['binding']['itemKey'], 'kind': claim['eventKind']},
                 'attempt': {'rating': claim['rating'], 'correct': claim['correct'],
                             'stageBefore': 0, 'stageAfter': 3 if claim['correct'] else 0}}
        event['coreHash'] = compute_study_event_core_hash(event)
        return event

    def writer(self):
        def guard(db, root, owner, event, catalog, course):
            return source_event_guard(db, root, owner, event, catalog, source_store=lambda *_: self.store,
                                      original_word=catalog_word, course_check=course)
        return NativeStudyWriter(NativeWritePorts(now=lambda: self.now, local_tz=timezone.utc,
            lock=threading.RLock(), gateway=index_gateway.load_gateway, dashboard=lambda *_: {},
            log_path=lambda day: self.root / 'logs' / (str(day) + '.jsonl'), vault_path=lambda ref: self.root / ref,
            read_activity=lambda _: [], render_report=lambda *_: self.root / 'report.md',
            report_events=lambda _: [], relative_path=lambda path: path.relative_to(self.root).as_posix(),
            source_guard=guard))

    def test_four_original_ratings_are_preserved_in_verified_evaluation_and_actual_receiver(self):
        expected = {'again': ('incorrect', False), 'hard': ('partial', False),
                    'good': ('correct', True), 'easy': ('correct', True)}
        for rating, (outcome, correct) in expected.items():
            with self.subTest(rating=rating):
                submission = self.submit(rating)
                assessment = self.assessment(submission, rating)
                receipt = self.store.self_assess(assessment)
                self.assertEqual(receipt, {'schemaVersion': 1, 'durable': True,
                                          'selfAssessment': assessment, 'selfAssessmentHash': fingerprint(assessment)})
                evaluated = self.evaluate(rating, 'grade-' + rating)
                self.assertEqual((evaluated['status'], evaluated['outcome'], evaluated['correct']), ('resolved', outcome, correct))
                self.assertEqual(evaluated['selfAssessment'], assessment)
                self.assertEqual(evaluated['evaluationHash'], fingerprint(
                    {key: value for key, value in evaluated.items() if key != 'evaluationHash'}))
                claim = self.store.claim({'attemptId': rating, 'eventId': 'formal-' + rating})['claim']
                self.assertEqual((claim['rating'], claim['correct']), (rating, correct))
                with closing(sqlite3.connect(self.root / 'formal-events.db')) as db:
                    self.assertEqual(self.writer().accept(db, self.root, 'owner-a', {'event': self.event(claim)})['status'], 'accepted')
                    db.commit()
                self.assertEqual(self.store.read_attempt(rating)['submission'], submission)
        self.grade.assert_not_called()

    def test_unknown_source_keeps_original_self_assessment_and_needs_confirmation_then_fresh_evaluation(self):
        self.available = False
        submission = self.submit()
        assessment = self.assessment(submission, 'easy')
        self.store.self_assess(assessment)
        self.assertEqual(self.evaluate()['status'], 'pending')
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'first', 'eventId': 'too-early'})
        self.available = True
        capture = self.store.capture(self.query)
        self.store.confirm({'attemptId': 'first', 'captureId': capture['captureId']})
        self.assertEqual(self.store.read_attempt('first')['selfAssessment'], assessment)
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'first', 'eventId': 'still-too-early'})
        fresh = self.evaluate(request='fresh-confirmed')
        self.assertEqual(fresh['status'], 'resolved')
        self.assertEqual(fresh['selfAssessment']['binding'], submission['binding'])
        self.assertNotEqual(fresh['sourceCaptureId'], submission['binding']['captureId'])
        claim = self.store.claim({'attemptId': 'first', 'eventId': 'original-easy'})['claim']
        self.assertEqual(claim['rating'], 'easy')
        self.assertEqual(self.store.read_attempt('first')['submission'], submission)
        self.grade.assert_not_called()

    def test_exact_retry_is_idempotent_conflicts_do_not_replace_evaluation_or_formal_history(self):
        submission = self.submit()
        request = self.assessment(submission, 'hard')
        receipt = self.store.self_assess(request)
        evaluated = self.evaluate()
        formal = self.store.claim({'attemptId': 'first', 'eventId': 'same-formal'})
        self.assertEqual(self.store.self_assess(copy.deepcopy(request)), receipt)
        with self.assertRaisesRegex(ValueError, 'self-assessment-conflict'):
            self.store.self_assess({**request, 'rating': 'good'})
        self.assertEqual(self.store.read_attempt('first')['evaluation'], evaluated)
        self.assertEqual(self.store.read_claim_by_event('same-formal'), formal)
        with self.assertRaisesRegex(ValueError, 'claim-conflict'):
            self.store.claim({'attemptId': 'first', 'eventId': 'same-formal', 'rating': 'again'})

    def test_self_assessment_cannot_change_its_original_rating_when_claiming(self):
        submission = self.submit()
        self.store.self_assess(self.assessment(submission, 'easy'))
        self.evaluate()
        for rating in ('again', 'hard', 'good'):
            with self.subTest(rating=rating), self.assertRaisesRegex(ValueError, 'claim-conflict'):
                self.store.claim({'attemptId': 'first', 'eventId': 'wrong-rating', 'rating': rating})
        self.assertIsNone(self.store.read_claim_by_event('wrong-rating'))

    def test_scope_revision_time_and_original_binding_must_match_saved_submission(self):
        submission = self.submit()
        request = self.assessment(submission)
        cases = [{'attemptId': 'missing'}, {'answerRevision': 2},
                 {'submittedAt': '2026-10-10T09:01:00.000Z'},
                 {'submittedAt': '2026-10-10T09:00:00Z'}, {'schemaVersion': True}, {'rating': 'unknown'}]
        cases += [{'binding': {**request['binding'], field: value}}
                  for field, value in (('ownerId', 'other'), ('libraryId', 'other'), ('itemKey', 'other'),
                                       ('contentHash', 'b' * 64), ('captureId', 'other-capture'))]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.store.self_assess({**request, **change})
        for foreign in (self.make_store(owner='other'), self.make_store(library='other'), self.make_store(root=self.root.parent)):
            with self.assertRaises(ValueError):
                foreign.self_assess(request)
        self.assertIsNone(self.store.read_attempt('first')['selfAssessment'])
        self.assertEqual(self.store.read_attempt('first')['submission'], submission)

    def test_actual_registered_non_flashcard_rejects_self_assessment_and_unknown_never_converts_to_ai(self):
        for mode in ('quiz', 'recall', 'code'):
            with self.subTest(mode=mode):
                subject = self.h.subject('original-' + mode, mode)
                if mode == 'quiz':
                    self.h.quiz(subject)
                else:
                    table = ('| ID | prompt | initialCode | testCode |\n|---|---|---|---|\n'
                             '| q1 | Return one | def f(): return 1 | assert f() == 1 |\n'
                             if mode == 'code' else
                             '| ID | prompt | answer |\n|---|---|---|\n| q1 | What fact does the source give? | Source fact |\n')
                    self.h.write(subject + '/source.md', '---\ntype: zhixue-content\nzhixue: true\n'
                                 'zhixue_id: ' + mode + '\nzhixue_format: ' + mode + '\n---\n' + table)
                self.item = next(item for subject in index_gateway.load_gateway(self.root)['subjects']
                                 for item in subject['items'] if item['pluginType'] == mode)
                self.query = {'itemKey': 'practice:' + self.item['itemId'], 'contentHash': self.item['contentHash'],
                              'presentation': exercise_presentation(self.item)}
                submission = self.submit(mode)
                with self.assertRaisesRegex(ValueError, 'self-assessment-kind'):
                    self.store.self_assess(self.assessment(submission))
                self.available = False
                unknown = self.submit('unknown-' + mode)
                self.store.self_assess(self.assessment(unknown))
                self.available = True
                capture = self.store.capture(self.query)
                self.store.confirm({'attemptId': 'unknown-' + mode, 'captureId': capture['captureId']})
                self.assertEqual(self.evaluate('unknown-' + mode, 'not-ai-' + mode)['status'], 'pending')
                with self.assertRaisesRegex(ValueError, 'evaluation-required'):
                    self.store.claim({'attemptId': 'unknown-' + mode, 'eventId': 'not-formal-' + mode})
        self.grade.assert_not_called()

    def test_flashcard_with_no_explicit_self_assessment_stays_pending_without_grader(self):
        self.submit()
        self.assertEqual(self.evaluate()['status'], 'pending')
        self.grade.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'first', 'eventId': 'not-self-assessed'})

    def test_new_self_assessment_invalidates_old_pending_and_requires_new_evaluation_identity(self):
        submission = self.submit()
        old = self.evaluate()
        self.assertEqual(old['status'], 'pending')
        self.store.self_assess(self.assessment(submission))
        self.assertIsNone(self.store.read_attempt('first')['evaluation'])
        self.assertIsNone(self.store.read_attempt('first')['evaluationRequest'])
        with self.assertRaisesRegex(ValueError, 'request-conflict'):
            self.evaluate()
        self.assertEqual(self.evaluate(request='with-original-self-assessment')['status'], 'resolved')

    def test_changed_original_source_blocks_new_claim_and_retains_raw_answer_and_assessment(self):
        submission = self.submit()
        request = self.assessment(submission)
        self.store.self_assess(request)
        self.evaluate()
        self.source.write_text(self.source.read_text(encoding='utf-8').replace('Source fact', 'Changed source fact'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.store.claim({'attemptId': 'first', 'eventId': 'changed-source'})
        self.assertEqual(self.store.read_attempt('first')['submission'], submission)
        self.assertEqual(self.store.read_attempt('first')['selfAssessment'], request)

    def test_guided_and_remediation_assessments_are_durable_without_formal_promotion(self):
        for purpose, parent in (('guided', None), ('remediation', 'first-parent')):
            with self.subTest(purpose=purpose):
                submission = self.submit(purpose, purpose, parent)
                self.store.self_assess(self.assessment(submission))
                self.assertEqual(self.evaluate(purpose, 'grade-' + purpose)['status'], 'resolved')
                with self.assertRaisesRegex(ValueError, 'purpose'):
                    self.store.claim({'attemptId': purpose, 'eventId': 'no-' + purpose})

    def test_failed_self_assessment_commit_has_no_durable_evidence_or_changed_submission(self):
        submission = self.submit()
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('synthetic failed self-assessment commit')
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailedCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.self_assess(self.assessment(submission))
        self.assertIsNone(self.store.read_attempt('first')['selfAssessment'])
        self.assertEqual(self.store.read_attempt('first')['submission'], submission)

    def test_read_of_old_ledger_has_no_ddl_and_does_not_create_self_assessment_table(self):
        self.submit()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('DROP TABLE IF EXISTS nonword_source_self_assessments')
            db.commit()
        connect, queries = sqlite3.connect, []
        def traced(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.set_trace_callback(queries.append)
            return db
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect', side_effect=traced):
            self.assertIsNone(self.store.read_attempt('first')['selfAssessment'])
        self.assertFalse(any(word in query.upper() for query in queries for word in ('CREATE ', 'ALTER ', 'INSERT ', 'UPDATE ')))
        with closing(connect(self.path)) as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='nonword_source_self_assessments'").fetchone())

    def test_self_assessment_fences_a_late_previous_evaluation_worker(self):
        submission = self.submit()
        started, release = threading.Event(), threading.Event()
        current = self.store._current
        calls = []
        def blocked(capture):
            calls.append(1)
            if len(calls) == 1:
                started.set()
                self.assertTrue(release.wait(5))
            return current(capture)
        with mock.patch.object(self.store, '_current', blocked), ThreadPoolExecutor(max_workers=1) as pool:
            previous = pool.submit(self.evaluate)
            self.assertTrue(started.wait(5))
            try:
                self.store.self_assess(self.assessment(submission, 'hard'))
                fresh = self.evaluate(request='fresh-self-assessment')
                self.assertEqual(fresh['outcome'], 'partial')
                claim = self.store.claim({'attemptId': 'first', 'eventId': 'fresh-only'})
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
                previous.result(timeout=5)
        self.assertEqual(self.store.read_attempt('first')['evaluation'], fresh)
        self.assertEqual(self.store.read_claim_by_event('fresh-only'), claim)

    def test_original_assessment_survives_reconfirmed_source_version_but_old_evaluation_does_not(self):
        submission = self.submit()
        request = self.assessment(submission, 'easy')
        self.store.self_assess(request)
        old = self.evaluate()
        self.source.write_text(self.source.read_text(encoding='utf-8') + '\\nAdditional source context.\\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.store.claim({'attemptId': 'first', 'eventId': 'stale-reference'})
        capture = self.store.capture(self.query)
        self.assertEqual(capture['status'], 'confirmed')
        self.store.confirm({'attemptId': 'first', 'captureId': capture['captureId']})
        self.assertEqual(self.store.read_attempt('first')['selfAssessment'], request)
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'first', 'eventId': 'no-fresh-eval'})
        fresh = self.evaluate(request='new-source-version')
        self.assertNotEqual(old['sourceBinding'], fresh['sourceBinding'])
        self.assertEqual(self.store.claim({'attemptId': 'first', 'eventId': 'fresh-version'})['claim']['rating'], 'easy')
        self.assertEqual(self.store.read_attempt('first')['submission'], submission)

    def test_accepted_formal_event_replays_without_replacing_old_v3_record(self):
        submission = self.submit()
        request = self.assessment(submission, 'easy')
        self.store.self_assess(request)
        self.evaluate()
        event = self.event(self.store.claim({'attemptId': 'first', 'eventId': 'old-accepted'})['claim'])
        with closing(sqlite3.connect(self.root / 'formal-history.db')) as db:
            writer = self.writer()
            writer.accept(db, self.root, 'owner-a', {'event': event})
            original = db.execute('SELECT * FROM study_events_v3').fetchall()
            db.commit()
            self.source.unlink()
            self.assertEqual(self.store.self_assess(request)['selfAssessment'], request)
            self.assertEqual(writer.accept(db, self.root, 'owner-a', {'event': event})['status'], 'duplicate')
            self.assertEqual(db.execute('SELECT * FROM study_events_v3').fetchall(), original)
            db.commit()


if __name__ == '__main__':
    unittest.main()
