"""Real SQLite source admission, immutable submissions and scoped formal claims."""
import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from infrastructure.nonword_source_store import SourceAdmissionStore
from account_sync_schema import study_hash
from study_event_schema import compute_study_event_core_hash, validate_study_event_v3


class SourceAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'vault'
        self.root.mkdir()
        self.path = Path(self.temp.name) / 'temporary-source.db'
        self.now = datetime(2026, 10, 10, 10, tzinfo=timezone.utc)
        self.item = {'questionType': 'quiz', 'prompt': 'Choose the source answer.',
                     'options': ['first', 'second'], 'answer': 1}
        self.descriptor = {'sourceKey': 'practice:authored', 'sourceHash': 'a' * 64,
                           'eventKind': 'due', 'item': self.item,
                           'route': {'binding': {'itemId': 'authored', 'abilityId': 'authored',
                                                'stateRef': 'state.md'}, 'context': {'abilityId': 'authored'}}}
        self.available = True
        self.grade_calls = []
        self.query = {'itemKey': 'old-client-key', 'sourceItemKey': 'practice:authored',
                      'contentHash': 'b' * 64, 'presentation': {'questionType': 'quiz',
                                                              'prompt': self.item['prompt'],
                                                              'options': self.item['options']}}
        self.store = self.make_store()

    def resolver(self, query):
        self.assertEqual(query['presentation'], self.query['presentation'])
        return copy.deepcopy(self.descriptor) if self.available else None

    def grade(self, item, answer):
        self.grade_calls.append((copy.deepcopy(item), copy.deepcopy(answer)))
        correct = answer == item['answer']
        return {'verdict': 'correct' if correct else 'wrong', 'correct': correct,
                'explanation': 'Synthetic trusted reference only.'}

    def make_store(self, owner='owner-a', library='library-a', root=None):
        return SourceAdmissionStore(self.path, owner, library, root or self.root,
                                    self.resolver, self.grade, lambda: self.now)

    def submission(self, capture=None, **updates):
        capture = capture or self.store.capture(self.query)
        result = {'attemptId': 'attempt-a', 'binding': capture['binding'], 'answerRevision': 3,
                  'answer': 1, 'submittedAt': '2026-10-10T09:00:00.000Z',
                  'purpose': 'first', 'parentAttemptId': None, 'assistance': 'unknown'}
        return {**result, **updates}

    def resolved(self):
        capture = self.store.capture(self.query)
        self.store.submit(self.submission(capture))
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'evaluate-a'})
        self.assertEqual(result['status'], 'resolved')
        return result

    def test_guided_answer_is_saved_and_evaluated_without_a_formal_claim(self):
        submission = self.submission(purpose='guided', parentAttemptId=None, assistance='observed')
        self.assertTrue(self.store.submit(submission)['durable'])
        self.assertEqual(self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'guided-grade'})['status'], 'resolved')
        with self.assertRaisesRegex(ValueError, 'source-admission-purpose'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'guided-cannot-be-first'})
        self.assertEqual(self.store.read_attempt('attempt-a')['submission']['purpose'], 'guided')

    def test_guided_draft_can_be_saved_before_parent_submission(self):
        submission = self.submission(purpose='guided', parentAttemptId='not-yet-submitted', assistance='observed')
        self.assertTrue(self.store.submit(submission)['durable'])
        self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'guided-before-parent'})
        with self.assertRaisesRegex(ValueError, 'source-admission-purpose'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'cannot-promote-guided'})

    def test_cautious_formal_rating_keeps_original_evaluation_truth(self):
        self.resolved()
        receipt = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'cautious-first', 'rating': 'again'})
        self.assertFalse(receipt['claim']['correct'])
        self.assertTrue(self.store.read_attempt('attempt-a')['evaluation']['correct'])
        self.store.admit(self.event(receipt['claim']))

    def test_recall_hint_evidence_cannot_be_promoted_to_an_uncapped_rating(self):
        self.item['questionType'] = 'recall'
        self.store.submit(self.submission(maxPreHintLevel=3, assistance='observed'))
        self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'hinted-first'})
        with self.assertRaisesRegex(ValueError, 'source-admission-claim-conflict'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'hinted-formal', 'rating': 'good'})
        receipt = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'hinted-formal', 'rating': 'again'})
        self.assertFalse(receipt['claim']['correct'])

    def test_remediation_cannot_replace_or_add_to_first_formal_result(self):
        self.resolved()
        first = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'first-formal'})
        child = self.submission(attemptId='remediation-a', purpose='remediation',
                                parentAttemptId='attempt-a', assistance='observed')
        self.store.submit(child)
        self.store.evaluate({'attemptId': 'remediation-a', 'requestId': 'remediation-grade'})
        with self.assertRaisesRegex(ValueError, 'source-admission-purpose'):
            self.store.claim({'attemptId': 'remediation-a', 'eventId': 'second-formal'})
        self.assertEqual(self.store.read_claim_by_event('first-formal'), first)
        self.assertIsNone(self.store.read_claim_by_event('second-formal'))

    def test_missing_attempt_purpose_is_retained_but_not_promoted(self):
        legacy = self.submission()
        for key in ('purpose', 'parentAttemptId', 'assistance'):
            legacy.pop(key, None)
        self.store.submit(legacy)
        self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'unknown-purpose'})
        with self.assertRaisesRegex(ValueError, 'source-admission-purpose'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'unknown-cannot-promote'})

    def event(self, claim):
        event = {'schemaVersion': 3, 'eventId': claim['eventId'],
                 'occurredAt': claim['occurredAt'], 'domain': 'differential-review',
                 'eventType': 'practice-attempt', 'item': {'kind': claim['eventKind'],
                                                         'key': claim['binding']['itemKey']},
                 'attempt': {'correct': claim['correct'], 'rating': claim['rating'],
                             'stageBefore': 0, 'stageAfter': 3}}
        event['coreHash'] = compute_study_event_core_hash(event)
        return event

    def test_unconfirmed_capture_and_answer_are_durable_but_never_formal(self):
        self.available = False
        capture = self.store.capture(self.query)
        self.assertEqual(capture['status'], 'pending')
        self.assertTrue(capture['durable'])
        receipt = self.store.submit(self.submission(capture, answer='  original\nanswer  '))
        self.assertTrue(receipt['durable'])
        self.assertEqual(self.store.read_attempt('attempt-a')['submission']['answer'], '  original\nanswer  ')
        evaluation = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'pending-a'})
        self.assertEqual(evaluation['status'], 'pending')
        self.assertNotIn('correct', evaluation)
        self.assertNotIn('rating', evaluation)
        self.assertEqual(self.grade_calls, [])
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM nonword_source_claims').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='study_events_v3'").fetchone()[0], 0)

    def test_exact_submission_retries_and_changed_revision_or_answer_conflict(self):
        submitted = self.submission()
        first = self.store.submit(submitted)
        self.assertEqual(self.store.submit(copy.deepcopy(submitted)), first)
        for changed in ({'answer': 0}, {'answerRevision': 4},
                        {'submittedAt': '2026-10-10T09:01:00.000Z'}):
            with self.assertRaisesRegex(ValueError, 'submission-conflict'):
                self.store.submit({**submitted, **changed})
        self.assertEqual(self.store.read_attempt('attempt-a')['submission']['answer'], 1)

    def test_owner_library_and_root_isolation_reject_foreign_binding(self):
        submission = self.submission()
        self.store.submit(submission)
        for foreign in (self.make_store(owner='other'), self.make_store(library='other'),
                        self.make_store(root=self.root.parent)):
            self.assertIsNone(foreign.read_attempt('attempt-a'))
            with self.assertRaisesRegex(ValueError, 'scope|capture-required'):
                foreign.submit(submission)
            self.assertIsNone(foreign.read_claim_by_event('event-a'))

    def test_failed_commit_has_no_durable_receipt_or_saved_answer(self):
        capture = self.store.capture(self.query)
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('synthetic failed commit')
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailedCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.submit(self.submission(capture))
        self.assertIsNone(self.store.read_attempt('attempt-a'))

    def test_evaluation_reads_only_saved_answer_and_authoritative_item(self):
        self.resolved()
        self.assertEqual(self.grade_calls, [(self.item, 1)])
        with self.assertRaisesRegex(ValueError, 'field'):
            self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'evil',
                                 'answer': 0, 'reference': 'caller reference'})

    def test_pending_confirm_requires_identical_presentation_and_fresh_evaluation(self):
        self.available = False
        old = self.store.capture(self.query)
        self.store.submit(self.submission(old))
        self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'old-evaluation'})
        self.available = True
        confirmed = self.store.capture(self.query)
        receipt = self.store.confirm({'attemptId': 'attempt-a', 'captureId': confirmed['captureId']})
        self.assertTrue(receipt['durable'])
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'early'})
        fresh = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'new-evaluation'})
        self.assertEqual(fresh['status'], 'resolved')
        self.assertEqual(len(self.grade_calls), 1)
        with self.assertRaisesRegex(ValueError, 'request-conflict'):
            self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'old-evaluation'})

    def test_source_change_before_or_during_evaluation_stays_pending(self):
        self.store.submit(self.submission())
        self.descriptor['sourceHash'] = 'c' * 64
        receipt = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'changed-source'})
        self.assertEqual(receipt['status'], 'pending')
        self.assertEqual(self.grade_calls, [])
        self.descriptor['sourceHash'] = 'a' * 64
        grade = self.store.grade
        def changing(item, answer):
            result = grade(item, answer)
            self.descriptor['sourceHash'] = 'd' * 64
            return result
        self.store.grade = changing
        receipt = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'changed-during-grade'})
        self.assertEqual(receipt['status'], 'pending')
        self.assertNotIn('correct', receipt)

    def test_code_and_flashcard_without_specialized_evidence_remain_pending(self):
        for mode in ('code', 'flashcard'):
            self.item['questionType'] = mode
            self.store.submit(self.submission(attemptId=mode))
            result = self.store.evaluate({'attemptId': mode, 'requestId': mode})
            self.assertEqual(result['status'], 'pending')
            self.assertNotIn('correct', result)

    def test_claim_is_immutable_idempotent_and_bound_to_evaluation(self):
        evaluated = self.resolved()
        request = {'attemptId': 'attempt-a', 'eventId': 'event-a', 'rating': 'easy'}
        first = self.store.claim(request)
        self.assertEqual(self.store.claim(request), first)
        claim = first['claim']
        self.assertEqual(claim['evaluationHash'], evaluated['evaluationHash'])
        self.assertEqual(claim['occurredAt'], '2026-10-10T09:00:00.000Z')
        for changed in ({'eventId': 'different-event'}, {'rating': 'again'}):
            with self.assertRaisesRegex(ValueError, 'claim-conflict'):
                self.store.claim({**request, **changed})
        self.assertEqual(self.store.read_claim_by_event('event-a')['claim'], claim)

    def test_claim_requires_final_source_fence_and_does_not_overwrite_history(self):
        self.resolved()
        self.available = False
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})
        self.assertIsNone(self.store.read_claim_by_event('event-a'))

    def test_admission_reads_claim_route_and_recheck_detects_later_change(self):
        self.resolved()
        claim = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})['claim']
        event = self.event(claim)
        recheck, route = self.store.admit(event)
        self.assertEqual(route, self.descriptor['route'])
        recheck()
        self.available = False
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            recheck()
        for field, value in (('correct', False), ('rating', 'again')):
            changed = copy.deepcopy(event)
            changed['attempt'][field] = value
            with self.assertRaisesRegex(ValueError, 'event-binding'):
                self.store.admit(changed)

    def test_original_identity_and_private_source_route_remain_distinct(self):
        capture = self.store.capture(self.query)
        self.assertEqual(capture['binding']['itemKey'], 'old-client-key')
        self.assertEqual(capture['binding']['contentHash'], 'b' * 64)
        self.assertEqual(capture['sourceBinding']['itemKey'], 'practice:authored')
        self.assertEqual(capture['sourceBinding']['contentHash'], 'a' * 64)
        submitted = self.submission(capture)
        self.store.submit(submitted)
        self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'evaluate-a'})
        claim = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})['claim']
        self.assertEqual(claim['binding'], submitted['binding'])
        self.assertEqual(claim['sourceBinding'], capture['sourceBinding'])
        self.assertEqual(self.store.admit(self.event(claim))[1], self.descriptor['route'])

    def test_confirmation_never_rewrites_original_submission_or_matches_new_question(self):
        self.available = False
        pending = self.store.capture(self.query)
        original = self.submission(pending)
        self.store.submit(original)
        self.available = True
        confirmed = self.store.capture(self.query)
        self.store.confirm({'attemptId': 'attempt-a', 'captureId': confirmed['captureId']})
        saved = self.store.read_attempt('attempt-a')
        self.assertEqual(saved['submission'], original)
        self.assertEqual(saved['binding'], original['binding'])
        self.assertEqual(saved['capture']['binding']['captureId'], confirmed['captureId'])
        self.query['presentation']['prompt'] = 'A different question.'
        other = self.store.capture(self.query)
        with self.assertRaisesRegex(ValueError, 'presentation-conflict'):
            self.store.confirm({'attemptId': 'attempt-a', 'captureId': other['captureId']})
        self.assertEqual(self.store.read_attempt('attempt-a')['submission'], original)

    def test_conflicting_or_unknown_grade_never_yields_rating(self):
        self.store.submit(self.submission())
        for index, grade in enumerate(({'correct': True, 'verdict': 'wrong'},
                                       {'correct': None, 'verdict': 'unknown'},
                                       {'status': 'pending', 'rating': 'easy'})):
            self.store.grade = lambda item, answer, result=grade: result
            evaluated = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': str(index)})
            self.assertEqual(evaluated['status'], 'pending')
            self.assertNotIn('correct', evaluated)
            self.assertNotIn('rating', evaluated)
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})

    def test_event_id_uniqueness_and_post_claim_mutation_are_rejected(self):
        self.resolved()
        claim = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})
        self.store.submit(self.submission(attemptId='second'))
        self.store.evaluate({'attemptId': 'second', 'requestId': 'second'})
        with self.assertRaisesRegex(ValueError, 'claim-conflict'):
            self.store.claim({'attemptId': 'second', 'eventId': 'event-a'})
        for operation in (lambda: self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'late'}),
                          lambda: self.store.confirm({'attemptId': 'attempt-a', 'captureId': claim['claim']['sourceCaptureId']})):
            with self.assertRaisesRegex(ValueError, 'claim-conflict'):
                operation()

    def test_older_evaluation_cannot_overwrite_a_newer_request(self):
        self.store.submit(self.submission())
        started, release = Event(), Event()
        calls = []
        def grade(item, answer):
            index = len(calls)
            calls.append(index)
            if index == 0:
                started.set()
                self.assertTrue(release.wait(5))
                return {'correct': True, 'verdict': 'correct'}
            return {'correct': False, 'verdict': 'wrong'}
        self.store.grade = grade
        with ThreadPoolExecutor(max_workers=1) as pool:
            older = pool.submit(self.store.evaluate, {'attemptId': 'attempt-a', 'requestId': 'older'})
            self.assertTrue(started.wait(5))
            try:
                self.now += timedelta(seconds=121)
                newer = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'newer'})
                self.assertFalse(newer['correct'])
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
                older.result(timeout=5)
        self.assertEqual(self.store.read_attempt('attempt-a')['evaluation'], newer)

    def test_stale_cached_evaluation_is_not_a_fresh_durable_grade(self):
        self.resolved()
        self.available = False
        retry = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'evaluate-a'})
        self.assertEqual(retry['status'], 'pending')
        self.assertFalse(retry['durable'])
        self.assertNotIn('correct', retry)

    def test_null_or_missing_correct_does_not_become_a_success(self):
        self.store.submit(self.submission())
        for index, result in enumerate(({'correct': None, 'verdict': 'correct'},
                                        {'verdict': 'correct'})):
            self.store.grade = lambda item, answer, output=result: output
            evaluated = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'null-' + str(index)})
            self.assertEqual(evaluated['status'], 'pending')
            self.assertNotIn('correct', evaluated)

    def test_new_inflight_evaluation_cannot_claim_the_previous_result(self):
        self.resolved()
        started, release = Event(), Event()
        def grade(item, answer):
            started.set()
            self.assertTrue(release.wait(5))
            return {'correct': False, 'verdict': 'wrong'}
        self.store.grade = grade
        with ThreadPoolExecutor(max_workers=1) as pool:
            newer = pool.submit(self.store.evaluate, {'attemptId': 'attempt-a', 'requestId': 'new-inflight'})
            self.assertTrue(started.wait(5))
            try:
                with self.assertRaisesRegex(ValueError, 'evaluation-required'):
                    self.store.claim({'attemptId': 'attempt-a', 'eventId': 'stale-claim'})
            finally:
                release.set()
            newer.result(timeout=5)

    def test_capture_commit_failure_does_not_return_or_store_confirmation(self):
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('synthetic capture commit failure')
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailedCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.capture(self.query)
        with closing(connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='nonword_source_captures'").fetchone()[0], 0)

    def test_evaluation_save_failure_does_not_acknowledge_durable_grade(self):
        self.store.submit(self.submission())
        connect = sqlite3.connect
        commits = []
        class FailSecondCommit(sqlite3.Connection):
            def commit(self):
                commits.append(1)
                if len(commits) == 2:
                    raise sqlite3.OperationalError('synthetic evaluation commit failure')
                super().commit()
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailSecondCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'save-failure'})
        self.assertIsNone(self.store.read_attempt('attempt-a')['evaluation'])
        retry = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'save-failure'})
        self.assertEqual(retry['status'], 'pending')
        self.assertFalse(retry['durable'])
        self.assertEqual(len(self.grade_calls), 1)
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'failed-grade'})


    def test_custom_lease_uses_injected_server_clock_and_rejects_unbounded_duration(self):
        for duration in (0, -1, float('inf'), float('nan'), True, 3601):
            with self.subTest(duration=duration):
                with self.assertRaisesRegex(ValueError, 'evaluation-lease'):
                    SourceAdmissionStore(self.path, 'owner-a', 'library-a', self.root,
                                         self.resolver, self.grade, lambda: self.now,
                                         evaluation_lease_seconds=duration)
        store = SourceAdmissionStore(self.path, 'owner-a', 'library-a', self.root,
                                     self.resolver, self.grade, lambda: self.now,
                                     evaluation_lease_seconds=3)
        store.submit(self.submission())
        store.grade = mock.Mock(side_effect=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            store.evaluate({'attemptId': 'attempt-a', 'requestId': 'short-lease'})
        store.grade = self.grade
        self.now += timedelta(seconds=2)
        self.assertFalse(store.evaluate({'attemptId': 'attempt-a', 'requestId': 'short-lease'})['durable'])
        self.assertEqual(self.grade_calls, [])
        self.now += timedelta(seconds=1)
        self.assertEqual(store.evaluate({'attemptId': 'attempt-a', 'requestId': 'short-lease'})['status'], 'resolved')
        self.assertEqual(len(self.grade_calls), 1)

    def test_lost_final_receipt_recovers_same_request_only_after_server_lease(self):
        submitted = self.submission()
        self.store.submit(submitted)
        connect = sqlite3.connect
        commits = []
        class FailFinalCommit(sqlite3.Connection):
            def commit(self):
                commits.append(1)
                if len(commits) == 2:
                    raise sqlite3.OperationalError('synthetic lost evaluation receipt')
                super().commit()
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailFinalCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'recover-me'})
        with closing(connect(self.path)) as db:
            self.assertIsNone(db.execute('SELECT receipt FROM nonword_source_evaluations').fetchone()[0])
        self.now += timedelta(seconds=119)
        pending = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'recover-me'})
        self.assertEqual(pending['status'], 'pending')
        self.assertFalse(pending['durable'])
        self.assertEqual(len(self.grade_calls), 1)
        self.assertEqual(self.store.read_attempt('attempt-a')['evaluationRequest'], 'recover-me')
        self.now += timedelta(seconds=1)
        recovered = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'recover-me'})
        self.assertEqual(recovered['status'], 'resolved')
        self.assertTrue(recovered['durable'])
        self.assertEqual(len(self.grade_calls), 2)
        self.assertEqual(self.store.read_attempt('attempt-a')['submission'], submitted)
        self.assertEqual(self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'recover-me'}), recovered)
        self.assertEqual(len(self.grade_calls), 2)
        self.store.claim({'attemptId': 'attempt-a', 'eventId': 'recovered-claim'})

    def test_interrupted_worker_does_not_allow_unexpired_new_id_to_grade(self):
        self.store.submit(self.submission())
        grade = self.store.grade
        self.store.grade = mock.Mock(side_effect=KeyboardInterrupt('synthetic process interruption'))
        with self.assertRaises(KeyboardInterrupt):
            self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'interrupted'})
        self.store.grade = grade
        other = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'different'})
        self.assertEqual(other['status'], 'pending')
        self.assertFalse(other['durable'])
        self.assertEqual(self.grade_calls, [])
        self.assertEqual(self.store.read_attempt('attempt-a')['evaluationRequest'], 'interrupted')
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'cannot-claim-inflight'})
        self.now += timedelta(seconds=120)
        resumed = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'interrupted'})
        self.assertEqual(resumed['status'], 'resolved')
        self.assertEqual(len(self.grade_calls), 1)

    def test_same_id_late_worker_cannot_overwrite_new_generation_or_claim(self):
        self.store.submit(self.submission())
        started, release = Event(), Event()
        calls = []
        def grade(item, answer):
            index = len(calls)
            calls.append(index)
            if index == 0:
                started.set()
                self.assertTrue(release.wait(5))
                return {'correct': True, 'verdict': 'correct'}
            return {'correct': False, 'verdict': 'wrong'}
        self.store.grade = grade
        with ThreadPoolExecutor(max_workers=1) as pool:
            old = pool.submit(self.store.evaluate, {'attemptId': 'attempt-a', 'requestId': 'same-id'})
            self.assertTrue(started.wait(5))
            try:
                duplicate = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'same-id'})
                self.assertEqual(duplicate['status'], 'pending')
                self.assertEqual(calls, [0])
                self.now += timedelta(seconds=120)
                fresh = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'same-id'})
                self.assertEqual(fresh['status'], 'resolved')
                self.assertFalse(fresh['correct'])
                claim = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'fresh-only'})
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
                old.result(timeout=5)
        self.assertEqual(self.store.read_attempt('attempt-a')['evaluation'], fresh)
        self.assertEqual(self.store.read_claim_by_event('fresh-only'), claim)

    def test_expired_worker_without_replacement_cannot_publish_a_grade(self):
        self.store.submit(self.submission())
        def grade(item, answer):
            self.now += timedelta(seconds=120)
            return {'correct': True, 'verdict': 'correct'}
        self.store.grade = grade
        with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
            self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'expired-worker'})
        self.assertIsNone(self.store.read_attempt('attempt-a')['evaluation'])
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': 'attempt-a', 'eventId': 'expired-cannot-claim'})
        self.store.grade = self.grade
        self.assertEqual(self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'expired-worker'})['status'], 'resolved')

    def test_confirmation_fences_old_generation_and_preserves_original_answer(self):
        original = self.submission()
        self.store.submit(original)
        started, release = Event(), Event()
        grade = self.store.grade
        def blocked(item, answer):
            started.set()
            self.assertTrue(release.wait(5))
            return grade(item, answer)
        self.store.grade = blocked
        with ThreadPoolExecutor(max_workers=1) as pool:
            old = pool.submit(self.store.evaluate, {'attemptId': 'attempt-a', 'requestId': 'old-source-worker'})
            self.assertTrue(started.wait(5))
            try:
                self.descriptor['sourceHash'] = 'c' * 64
                capture = self.store.capture(self.query)
                self.store.confirm({'attemptId': 'attempt-a', 'captureId': capture['captureId']})
                self.store.grade = grade
                fresh = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'new-source-worker'})
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
                old.result(timeout=5)
        self.assertEqual(self.store.read_attempt('attempt-a')['submission'], original)
        self.assertEqual(self.store.read_attempt('attempt-a')['evaluation'], fresh)
        self.assertEqual(fresh['sourceBinding']['contentHash'], 'c' * 64)

    def test_old_null_reservation_migrates_only_on_write_without_formal_changes(self):
        self.store.submit(self.submission())
        self.store.grade = mock.Mock(side_effect=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'legacy-null'})
        connect = sqlite3.connect
        with closing(connect(self.path)) as db:
            old = db.execute('SELECT owner,library,root,request_id,attempt_id,input_hash,receipt '
                             'FROM nonword_source_evaluations').fetchone()
            db.execute('DROP TABLE nonword_source_evaluations')
            db.execute('CREATE TABLE nonword_source_evaluations (owner TEXT,library TEXT,root TEXT,'
                       'request_id TEXT,attempt_id TEXT,input_hash TEXT,receipt TEXT,'
                       'PRIMARY KEY(owner,library,root,request_id))')
            db.execute('INSERT INTO nonword_source_evaluations VALUES (?,?,?,?,?,?,?)', old)
            db.execute('CREATE TABLE study_events_v3 (immutable TEXT)')
            db.execute("INSERT INTO study_events_v3 VALUES ('preserved formal history')")
            db.commit()
        queries = []
        def traced(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.set_trace_callback(queries.append)
            return db
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect', side_effect=traced):
            self.assertEqual(self.store.read_attempt('attempt-a')['evaluationRequest'], 'legacy-null')
            self.assertIsNone(self.store.read_claim_by_event('missing'))
        self.assertFalse(any(word in statement.upper() for statement in queries for word in ('CREATE ', 'ALTER ')))
        with closing(connect(self.path)) as db:
            self.assertNotIn('lease_until', [row[1] for row in db.execute('PRAGMA table_info(nonword_source_evaluations)')])
        self.store.grade = self.grade
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'legacy-null'})
        self.assertEqual(result['status'], 'resolved')
        with closing(connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT immutable FROM study_events_v3').fetchall(),
                             [('preserved formal history',)])
            self.assertIn('lease_until', [row[1] for row in db.execute('PRAGMA table_info(nonword_source_evaluations)')])

    def test_claim_commit_failure_leaves_no_claim_or_route_authority(self):
        self.resolved()
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('synthetic claim commit failure')
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailedCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})
        self.assertIsNone(self.store.read_claim_by_event('event-a'))

    def test_noncanonical_submission_time_cannot_create_a_claim(self):
        capture = self.store.capture(self.query)
        for stamp in ('2026-10-10T09:00:00Z', '2026-10-10T09:00:00.000+00:00',
                      '2026-10-10T17:00:00.000+08:00', '2026-10-10T09:00:00.000000Z'):
            with self.subTest(stamp=stamp):
                with self.assertRaisesRegex(ValueError, 'time'):
                    self.store.submit(self.submission(capture, submittedAt=stamp))
                self.assertIsNone(self.store.read_attempt('attempt-a'))
                self.assertIsNone(self.store.read_claim_by_event('event-a'))

    def test_claim_time_is_preserved_and_accepted_by_actual_v3_validator(self):
        self.resolved()
        claim = self.store.claim({'attemptId': 'attempt-a', 'eventId': 'event-a'})['claim']
        event = validate_study_event_v3(self.event(claim))
        self.assertEqual(event['occurredAt'], '2026-10-10T09:00:00.000Z')
        self.assertEqual(self.store.read_attempt('attempt-a')['submission']['submittedAt'],
                         event['occurredAt'])

    def test_unclaimed_event_cannot_select_a_route_with_caller_labels(self):
        event = {'eventId': 'unclaimed', 'item': {'key': 'practice:authored', 'kind': 'word'},
                 'attempt': {'correct': True, 'rating': 'easy'}, 'occurredAt': '2026-10-10T09:00:00.000Z'}
        with self.assertRaisesRegex(ValueError, 'claim-required'):
            self.store.admit(event)


if __name__ == '__main__':
    unittest.main()
