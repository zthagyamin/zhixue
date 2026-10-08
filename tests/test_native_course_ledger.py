"""Request freeze, scoped budgets, CAS and durable SQLite recovery."""
import copy
import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from unittest import mock
from test_native_course_service import Harness
from infrastructure.course_grade_ledger import CourseGradeLedger
from native_course_schema import make_receipt


class NativeCourseLedgerTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def test_answer_revision_and_request_id_reuse_conflict_without_overwrite(self):
        request = self.h.request()
        original = self.h.app.grade(request)
        changed = copy.deepcopy(request)
        changed['submission']['answer'] = 'Changed answer'
        with self.assertRaisesRegex(ValueError, 'request-conflict'):
            self.h.app.grade(changed)
        changed['requestId'] = 'other'
        with self.assertRaisesRegex(ValueError, 'attempt-conflict'):
            self.h.app.grade(changed)
        self.assertEqual(self.h.app.grade(request), original)
        self.assertEqual(self.h.calls, 1)

    def test_auth_owner_library_and_root_isolation(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        self.h.app.claim(self.h.claim(request, receipt))
        for owner, library, root in (('2' * 64, self.h.identity['libraryId'], self.h.source.vault),
                                      ('1' * 64, 'other-library', self.h.source.vault),
                                      ('1' * 64, self.h.identity['libraryId'], self.h.source.vault.parent)):
            ledger = CourseGradeLedger(self.h.source.db, owner, library, root)
            self.assertIsNone(ledger.read_attempt('attempt-1'))
            self.assertIsNone(ledger.read_claim_by_event('event-1'))

    def test_actual_budget_limits_concurrent_and_daily_requests(self):
        first = self.h.request()
        self.h.ledger.begin(first)
        reserved = self.h.ledger.reserve(first, self.h.task, self.h.settings)
        self.assertGreater(reserved, 2000)
        second = self.h.request(attemptId='second', requestId='second')
        self.h.ledger.begin(second)
        with self.assertRaisesRegex(ValueError, 'concurrent-budget'):
            self.h.ledger.reserve(second, self.h.task, self.h.settings)
        self.h.now += 121
        with self.assertRaisesRegex(ValueError, 'daily-budget'):
            self.h.ledger.reserve(second, self.h.task, {**self.h.settings, 'dailyRequestLimit': 1})
        with self.assertRaisesRegex(ValueError, 'daily-budget'):
            self.h.ledger.reserve(second, self.h.task, {**self.h.settings, 'dailyTokenLimit': reserved})

    def test_budget_reservation_shared_across_owner_libraries(self):
        request = self.h.request()
        self.h.ledger.begin(request)
        self.h.ledger.reserve(request, self.h.task, self.h.settings)
        other = CourseGradeLedger(self.h.source.db, '1' * 64, 'other-library', self.h.source.vault,
                                  clock=lambda: self.h.now)
        second = self.h.request(requestId='second', attemptId='second')
        other.begin(second)
        with self.assertRaisesRegex(ValueError, 'concurrent-budget'):
            other.reserve(second, self.h.task, self.h.settings)

    def test_commit_failure_rolls_back_and_closes_database(self):
        connect = sqlite3.connect
        closed = []
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('simulated commit failure')
            def close(self):
                closed.append(True)
                super().close()
        def fail(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailedCommit)
        with mock.patch('infrastructure.course_grade_ledger.sqlite3.connect', side_effect=fail):
            with self.assertRaises(sqlite3.OperationalError):
                self.h.ledger.begin(self.h.request())
        self.assertTrue(closed)
        self.assertIsNone(self.h.ledger.read_attempt('attempt-1'))
        with closing(connect(self.h.source.db)) as db:
            db.execute('BEGIN IMMEDIATE')
            db.rollback()

    def test_stale_prepare_and_event_uniqueness_conflict(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        with self.assertRaisesRegex(ValueError, 'prepare-conflict'):
            self.h.ledger.prepare({**request, 'requestId': 'stale'}, receipt)
        self.h.app.claim(self.h.claim(request, receipt))
        second = self.h.request(attemptId='second', requestId='second')
        second['binding']['roundId'] = 'new-round'
        result = self.h.app.grade(second)
        with self.assertRaisesRegex(ValueError, 'event-conflict'):
            self.h.app.claim(self.h.claim(second, result))

    def test_first_formal_source_round_unique_new_attempt_namespace_cannot_replace(self):
        first = self.h.request(action='self-assess', selfStatus='correct')
        result = self.h.app.grade(first)
        accepted = self.h.app.claim(self.h.claim(first, result))
        second = self.h.request(action='self-assess', selfStatus='correct', attemptId='second', requestId='second')
        second['binding']['ownerId'] = 'other-browser-namespace'
        result2 = self.h.app.grade(second)
        with self.assertRaisesRegex(ValueError, 'formal-binding-conflict'):
            self.h.app.claim(self.h.claim(second, result2, eventId='event-2'))
        self.assertEqual(self.h.app.read_claim('attempt-1')['claimReceipt'], accepted)
        self.assertIsNone(self.h.app.read_claim('second'))
        third = self.h.request(action='self-assess', selfStatus='correct', attemptId='third', requestId='third')
        third['binding']['roundId'] = 'new-round'
        result3 = self.h.app.grade(third)
        self.assertEqual(self.h.app.claim(self.h.claim(third, result3, eventId='event-3'))['status'], 'accepted')

    def test_two_ledgers_concurrent_formal_source_round_admits_exactly_one(self):
        first = self.h.request(action='self-assess', selfStatus='correct')
        second = self.h.request(action='self-assess', selfStatus='correct', requestId='second', attemptId='second')
        first_result, second_result = self.h.app.grade(first), self.h.app.grade(second)
        ledger2 = CourseGradeLedger(self.h.source.db, '1' * 64, self.h.identity['libraryId'], self.h.source.vault)
        first_claim = self.h.claim(first, first_result)
        second_claim = self.h.claim(second, second_result, eventId='event-2')
        def attempt(ledger, claim):
            try:
                return ledger.save_claim(claim)['status']
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(attempt, self.h.ledger, first_claim)
            b = pool.submit(attempt, ledger2, second_claim)
            outcomes = (a.result(5), b.result(5))
        self.assertEqual(outcomes.count('accepted'), 1)
        self.assertEqual(outcomes.count('native-course-claim-formal-binding-conflict'), 1)
        self.assertEqual(sum(self.h.app.read_claim(i) is not None for i in ('attempt-1', 'second')), 1)

    def test_corrupt_receipt_status_old_hashes_and_raw_answer_are_rejected(self):
        request = self.h.request(action='self-assess', selfStatus='incorrect')
        receipt = self.h.app.grade(request)
        altered = copy.deepcopy(receipt)
        altered['diagnostic']['status'] = 'correct'
        with closing(sqlite3.connect(self.h.source.db)) as db, db:
            db.execute('UPDATE native_course_attempts SET receipt_json=?', (json.dumps(altered),))
        with self.assertRaisesRegex(ValueError, 'ledger-integrity'):
            self.h.app.read_attempt('attempt-1')
        with self.assertRaisesRegex(ValueError, 'ledger-integrity'):
            self.h.app.claim(self.h.claim(request, receipt, rating='good'))
        altered_request = copy.deepcopy(request)
        altered_request['submission']['answer'] = 'Different raw answer'
        with closing(sqlite3.connect(self.h.source.db)) as db, db:
            db.execute('UPDATE native_course_attempts SET receipt_json=?,request_json=?',
                       (json.dumps(receipt), json.dumps(altered_request)))
        with self.assertRaisesRegex(ValueError, 'ledger-integrity'):
            self.h.app.read_attempt('attempt-1')

    def test_corrupt_request_receipt_replay_is_rejected(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        altered = {**receipt, 'receiptHash': 'a' * 64}
        with closing(sqlite3.connect(self.h.source.db)) as db, db:
            db.execute('UPDATE native_course_requests SET receipt_json=?', (json.dumps(altered),))
        with self.assertRaisesRegex(ValueError, 'ledger-integrity'):
            self.h.app.grade(request)

    def test_claim_revalidates_captured_quotes_even_if_hashes_recomputed(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        diagnostic = copy.deepcopy(receipt['diagnostic'])
        diagnostic['pointEvidence'][0]['sourceQuote'] = 'Absent quote'
        altered = make_receipt(request, diagnostic, receipt['trace'])
        with closing(sqlite3.connect(self.h.source.db)) as db, db:
            db.execute('UPDATE native_course_attempts SET receipt_json=?', (json.dumps(altered),))
        with self.assertRaisesRegex(ValueError, 'quote-binding'):
            self.h.app.claim(self.h.claim(request, altered))
        self.assertIsNone(self.h.app.read_claim('attempt-1'))

    def test_explicit_self_assessment_after_pending_uses_saved_resolving_intent(self):
        self.h.settings['enabled'] = False
        first = self.h.request()
        self.h.app.grade(first)
        resolved = self.h.app.grade({**first, 'requestId': 'explicit-self', 'action': 'self-assess', 'selfStatus': 'correct'})
        saved = self.h.app.read_attempt('attempt-1')
        self.assertEqual(saved['request']['action'], 'evaluate')
        self.assertEqual(saved['diagnosisRequest']['selfStatus'], 'correct')
        self.assertEqual(self.h.app.claim(self.h.claim(first, resolved))['status'], 'accepted')

    def test_deterministic_claim_recomputes_option_collection_from_original_answer(self):
        quiz = Harness(mode='quiz')
        self.addCleanup(quiz.close)
        request = quiz.request()
        request['submission']['answer'] = '["b"]'
        receipt = quiz.app.grade(request)
        self.assertEqual(receipt['diagnostic']['status'], 'incorrect')
        diagnostic = copy.deepcopy(receipt['diagnostic'])
        diagnostic.update(status='correct', wrongOptionIds=[], missingOptionIds=[])
        altered = make_receipt(request, diagnostic, None)
        with closing(sqlite3.connect(quiz.source.db)) as db, db:
            db.execute('UPDATE native_course_attempts SET receipt_json=?', (json.dumps(altered),))
        with self.assertRaisesRegex(ValueError, 'inconsistent-course-quiz-diagnostic'):
            quiz.app.claim(quiz.claim(request, altered))


if __name__ == '__main__':
    unittest.main()
