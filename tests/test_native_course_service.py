"""Controlled native grading against registered temporary vaults; no models."""
import copy
import json
import sqlite3
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import test_course_source_capture as source_fixture
from account_sync_schema import study_hash
from application.native_course import NativeCourseApplication, NativeCoursePorts
from course_study_domain import course_task_hash, resolve_course_task
from infrastructure.course_grade_ledger import CourseGradeLedger
from native_course_schema import native_course_rules

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/course-study-diagnostics-v1.json').read_text(encoding='utf-8'))


class Harness:
    def __init__(self, mode='recall', support_id='definition'):
        self.source = source_fixture.NativeCourseSourceTests()
        self.source.setUp()
        self.source.support = copy.deepcopy(FIXTURE['quizSupport'] if mode == 'quiz' else FIXTURE['supports'][support_id])
        self.source.source(mode=mode)
        self.identity = self.source.identity()
        self.capture = self.source.service.capture(self.identity)
        self.task = resolve_course_task(self.capture['item'])
        self.now = 1700000000.0
        self.ledger = CourseGradeLedger(self.source.db, source_fixture.OWNER,
                                        self.identity['libraryId'], self.source.vault,
                                        clock=lambda: self.now)
        self.calls = 0
        self.provider_hook = None
        self.settings = {'enabled': True, 'configured': True, 'provider': 'deepseek',
                         'model': 'synthetic', 'revision': 0, 'dailyRequestLimit': 10,
                         'dailyTokenLimit': 20000, 'concurrentLimit': 1, 'maxOutputTokens': 2000}
        self.app = self.application()

    def close(self):
        self.source.tearDown()

    def provider(self, task, answer, request_id, settings, reservation):
        self.calls += 1
        if self.provider_hook:
            return self.provider_hook(task, answer, request_id, settings, reservation)
        return self.result(task, answer, request_id, settings, reservation)

    def result(self, task, answer, request_id, settings, reservation):
        return {'diagnostic': {'schemaVersion': 1, 'status': 'correct', 'source': 'model',
                'feedback': '合成核对通过。', 'matchedPointIds': [p['id'] for p in task['criteria']],
                'missedPointIds': [], 'errorPointIds': [], 'wrongOptionIds': [], 'missingOptionIds': [],
                'pointEvidence': [{'pointId': p['id'], 'sourceId': p['sourceIds'][0],
                    'sourceQuote': next(s['excerpt'] for s in task['sources'] if s['sourceId'] == p['sourceIds'][0]),
                    'answerQuote': answer, 'reason': 'Synthetic test evidence.'} for p in task['criteria']]},
                'trace': {'provider': 'deepseek', 'modelId': 'synthetic',
                          'promptVersion': 'course-task-json-v1', 'ruleVersion': 'course-diagnostic-v1',
                          'requestId': request_id}, 'usageTokens': 100}

    def application(self):
        return NativeCourseApplication(NativeCoursePorts(
            rules=native_course_rules(),
            library_id=lambda: self.identity['libraryId'], read_source=self.source.service.read,
            capture_source=self.source.service.verify_current, read_attempt=self.ledger.read_attempt,
            begin=self.ledger.begin, reserve=self.ledger.reserve, prepare=self.ledger.prepare,
            finish=self.ledger.finish, read_claim=self.ledger.read_claim,
            read_claim_by_event=self.ledger.read_claim_by_event, save_claim=self.ledger.save_claim,
            settings=lambda: copy.deepcopy(self.settings), provider=self.provider))

    def request(self, **patch):
        result = {'schemaVersion': 1, 'action': 'evaluate', 'requestId': 'request-1',
                  'binding': {'ownerId': 'browser-workspace', 'libraryId': self.identity['libraryId'],
                              'snapshotId': 'local', 'itemKey': self.identity['itemKey'],
                              'contentHash': self.identity['contentHash'], 'groupId': 'course', 'roundId': 'round-1'},
                  'identity': copy.deepcopy(self.identity), 'captureId': self.capture['captureId'],
                  'attemptId': 'attempt-1', 'purpose': 'first', 'parentAttemptId': None,
                  'parentDiagnosticHash': None, 'taskId': self.task['taskId'],
                  'taskHash': course_task_hash(self.task),
                  'submission': {'answer': '["a","c"]' if self.task['mode'] == 'quiz' else '后放进去的先取出来。',
                                 'answerRevision': 1, 'submittedAt': '2026-10-06T01:00:00.000Z',
                                 'assistance': 'independent'}}
        return {**result, **copy.deepcopy(patch)}

    def claim(self, request, receipt, **patch):
        return {**{key: copy.deepcopy(request[key]) for key in ('schemaVersion', 'binding', 'identity', 'captureId', 'attemptId')},
                'diagnosticHash': receipt['diagnosticHash'], 'attemptEvaluationHash': receipt['attemptEvaluationHash'],
                'eventId': 'event-1', 'occurredAt': request['submission']['submittedAt'], 'rating': 'good', **patch}


class NativeCourseServiceTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def test_lost_receipt_restart_and_new_request_preserve_original_diagnosis(self):
        request = self.h.request()
        originals = {path: path.read_bytes() for path in self.h.source.vault.rglob('*.md')}
        receipt = self.h.app.grade(request)
        self.assertEqual(self.h.application().grade(request), receipt)
        second = self.h.app.grade({**request, 'requestId': 'request-2'})
        self.assertEqual(second['originRequestId'], 'request-1')
        self.assertEqual(second['requestId'], 'request-2')
        for field in ('diagnosticHash', 'trace', 'attemptEvaluationHash'):
            self.assertEqual(second[field], receipt[field])
        self.assertEqual(self.h.calls, 1)
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertEqual(receipt['receiptHash'], study_hash({k: v for k, v in receipt.items() if k != 'receiptHash'}))

    def test_pending_same_request_replay_new_request_resolves_original_answer(self):
        def fail(*args):
            raise TimeoutError('synthetic')
        self.h.provider_hook = fail
        request = self.h.request()
        pending = self.h.app.grade(request)
        self.assertIsNone(pending['attemptEvaluationHash'])
        self.h.provider_hook = None
        self.assertEqual(self.h.app.grade(request), pending)
        resolved = self.h.app.grade({**request, 'requestId': 'retry'})
        self.assertEqual(resolved['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.calls, 2)
        self.assertEqual(self.h.app.read_attempt('attempt-1')['request']['submission'], request['submission'])
        self.assertEqual(self.h.app.grade(request), pending)

    def test_inflight_new_request_forbidden_and_expired_never_reinvokes(self):
        request = self.h.request()
        self.h.ledger.begin(request)
        with self.assertRaisesRegex(ValueError, 'inflight'):
            self.h.app.grade({**request, 'requestId': 'new'})
        self.h.now += 121
        receipt = self.h.app.grade({**request, 'requestId': 'new'})
        self.assertEqual(receipt['diagnostic']['status'], 'undetermined')
        self.h.app.grade(request)
        self.assertEqual(self.h.calls, 0)

    def test_concurrent_same_attempt_and_other_attempt_do_not_double_call_provider(self):
        entered, release = threading.Event(), threading.Event()
        original_provider = self.h.result
        def blocked(task, answer, request_id, settings, reservation):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic test provider was not released')
            self.h.provider_hook = None
            return original_provider(task, answer, request_id, settings, reservation)
        self.h.provider_hook = blocked
        request = self.h.request()
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.h.app.grade, request)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaisesRegex(ValueError, 'inflight'):
                    self.h.app.grade({**request, 'requestId': 'same-attempt'})
                second = self.h.app.grade(self.h.request(attemptId='other', requestId='other'))
                self.assertEqual(second['diagnostic']['status'], 'undetermined')
            finally:
                release.set()
            self.assertEqual(first.result(5)['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.calls, 1)
        self.assertEqual(self.h.app.grade(request)['diagnostic']['status'], 'correct')

    def test_prepared_result_survives_finish_failure_and_restart(self):
        request = self.h.request()
        def fail_finish(value):
            raise sqlite3.OperationalError('simulated receipt commit failure')
        app = self.h.application()
        object.__setattr__(app.ports, 'finish', fail_finish)
        with self.assertRaises(sqlite3.OperationalError):
            app.grade(request)
        self.assertEqual(self.h.ledger.read_attempt('attempt-1')['state'], 'prepared')
        receipt = self.h.application().grade(request)
        self.assertEqual(receipt['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.calls, 1)

    def test_actual_finish_commit_failure_recovers_without_second_provider_call(self):
        connect = sqlite3.connect
        commits = []
        class FailedFourthCommit(sqlite3.Connection):
            def commit(self):
                commits.append(True)
                if len(commits) == 4:
                    raise sqlite3.OperationalError('fourth transaction commit failed')
                return super().commit()
        def fail(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailedFourthCommit)
        request = self.h.request()
        with mock.patch('infrastructure.course_grade_ledger.sqlite3.connect', side_effect=fail):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'fourth'):
                self.h.app.grade(request)
        self.assertEqual(self.h.ledger.read_attempt('attempt-1')['state'], 'prepared')
        receipt = self.h.application().grade(request)
        self.assertEqual(receipt['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.calls, 1)

    def test_failed_preparation_commit_retains_inflight_then_seals_unknown(self):
        prepare = self.h.ledger.prepare
        def fail_prepare(*args):
            raise sqlite3.OperationalError('provider result persistence failed')
        app = self.h.application()
        object.__setattr__(app.ports, 'prepare', fail_prepare)
        request = self.h.request()
        with self.assertRaises(sqlite3.OperationalError):
            app.grade(request)
        self.assertEqual(self.h.ledger.read_attempt('attempt-1')['state'], 'inflight')
        with self.assertRaisesRegex(ValueError, 'inflight'):
            self.h.application().grade(request)
        self.h.now += 121
        pending = self.h.application().grade(request)
        self.assertEqual(pending['diagnostic']['status'], 'undetermined')
        self.assertEqual(self.h.calls, 1)

    def test_old_prepared_pending_request_does_not_rerun_or_overwrite_new_resolution(self):
        request = self.h.request()
        self.h.provider_hook = lambda *args: (_ for _ in ()).throw(TimeoutError('synthetic'))
        app = self.h.application()
        object.__setattr__(app.ports, 'finish', lambda request: (_ for _ in ()).throw(sqlite3.OperationalError('finish failed')))
        with self.assertRaises(sqlite3.OperationalError):
            app.grade(request)
        replay = self.h.app.grade({**request, 'requestId': 'recover-pending'})
        self.assertEqual(replay['diagnostic']['status'], 'undetermined')
        self.h.provider_hook = None
        resolved = self.h.app.grade({**request, 'requestId': 'resolve'})
        self.assertEqual(resolved['diagnostic']['status'], 'correct')
        old = self.h.app.grade(request)
        self.assertEqual(old['diagnostic']['status'], 'undetermined')
        self.assertEqual(self.h.app.read_attempt('attempt-1')['state'], 'resolved')
        self.assertEqual(self.h.app.read_attempt('attempt-1')['receipt'], resolved)
        self.assertEqual(self.h.calls, 2)

    def test_old_pending_finish_cannot_downgrade_new_prepared_model_resolution(self):
        request = self.h.request()
        fail_finish = lambda request: (_ for _ in ()).throw(sqlite3.OperationalError('finish failed'))
        failing = self.h.application()
        object.__setattr__(failing.ports, 'finish', fail_finish)
        self.h.provider_hook = lambda *args: (_ for _ in ()).throw(TimeoutError('synthetic'))
        with self.assertRaises(sqlite3.OperationalError):
            failing.grade(request)
        self.h.app.grade({**request, 'requestId': 'recover-pending'})
        self.h.provider_hook = None
        with self.assertRaises(sqlite3.OperationalError):
            failing.grade({**request, 'requestId': 'resolve'})
        self.assertEqual(self.h.app.read_attempt('attempt-1')['state'], 'prepared')
        old = self.h.app.grade(request)
        self.assertEqual(old['diagnostic']['status'], 'undetermined')
        self.assertEqual(self.h.app.read_attempt('attempt-1')['state'], 'prepared')
        resolved = self.h.app.grade({**request, 'requestId': 'resolve-retry'})
        self.assertEqual(resolved['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.app.read_attempt('attempt-1')['state'], 'resolved')
        self.assertEqual(self.h.app.claim(self.h.claim(request, resolved))['status'], 'accepted')
        self.assertEqual(self.h.calls, 2)

    def test_source_change_during_provider_abstains_and_keeps_answer(self):
        original = self.h.result
        def changed(task, answer, request_id, settings, reservation):
            self.h.provider_hook = None
            result = original(task, answer, request_id, settings, reservation)
            self.h.source.source(answer='Changed source reference')
            return result
        self.h.provider_hook = changed
        request = self.h.request()
        receipt = self.h.app.grade(request)
        self.assertEqual(receipt['diagnostic']['reason'], 'source-conflict')
        self.assertIsNone(receipt['attemptEvaluationHash'])
        self.assertEqual(self.h.ledger.read_attempt('attempt-1')['request']['submission'], request['submission'])

    def test_untrusted_task_or_parent_cannot_grade_or_receive_formal_claim(self):
        request = self.h.request(taskHash='a' * 64)
        receipt = self.h.app.grade(request)
        self.assertEqual(receipt['diagnostic']['status'], 'undetermined')
        self.assertEqual(self.h.calls, 0)
        with self.assertRaises(ValueError):
            self.h.app.claim(self.h.claim(request, receipt, attemptEvaluationHash='a' * 64))

    def test_claim_exact_replay_timestamp_rating_event_and_scope(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        for patch in ({'rating': 'easy'}, {'occurredAt': '2026-10-06T01:00:01.000Z'}, {'diagnosticHash': 'a' * 64}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.h.app.claim(self.h.claim(request, receipt, **patch))
        claim = self.h.claim(request, receipt)
        accepted = self.h.app.claim(claim)
        self.assertEqual(accepted, self.h.app.claim(claim))
        self.assertEqual(accepted['claimHash'], study_hash(claim))
        basis = self.h.app.read_claim_by_event('event-1')
        self.assertEqual(basis['request']['submission'], request['submission'])
        self.assertEqual(basis['receipt'], receipt)
        self.h.source.source(answer='source changed after claim')
        self.assertEqual(accepted, self.h.app.claim(claim))
        with self.assertRaises(ValueError):
            self.h.app.claim({**claim, 'eventId': 'other'})

    def test_claim_assistance_caps_lower_ratings_and_guided_block(self):
        for level, rating in ((2, 'hard'), (3, 'again')):
            request = self.h.request(attemptId=f'attempt-{level}', requestId=f'request-{level}')
            request['binding']['roundId'] = f'round-{level}'
            request['submission'].update(assistance='observed', maxPreHintLevel=level)
            receipt = self.h.app.grade(request)
            with self.assertRaises(ValueError):
                self.h.app.claim(self.h.claim(request, receipt, eventId=f'event-{level}'))
            self.h.app.claim(self.h.claim(request, receipt, rating=rating, eventId=f'event-{level}'))
        request = self.h.request(attemptId='guided', requestId='guided', purpose='guided')
        receipt = self.h.app.grade(request)
        with self.assertRaises(ValueError):
            self.h.app.claim(self.h.claim(request, receipt, eventId='guided'))

    def test_child_is_selected_from_saved_trusted_parent_and_never_claimed(self):
        request = self.h.request(action='self-assess', selfStatus='incorrect')
        receipt = self.h.app.grade(request)
        # Explicit self-assess has no point evidence, so authored selection falls
        # back to the original task rather than inventing a missing criterion.
        child = self.h.request(attemptId='child', requestId='child', purpose='remediation',
                               parentAttemptId='attempt-1', parentDiagnosticHash=receipt['diagnosticHash'])
        child_receipt = self.h.app.grade(child)
        self.assertEqual(child_receipt['taskHash'], request['taskHash'])
        with self.assertRaises(ValueError):
            self.h.app.claim(self.h.claim(child, child_receipt))

    def test_authored_child_hash_fixed_from_saved_model_parent(self):
        original_provider = self.h.result
        def incorrect(task, answer, request_id, settings, reservation):
            self.h.provider_hook = None
            result = original_provider(task, answer, request_id, settings, reservation)
            result['diagnostic'].update(status='incorrect', matchedPointIds=[], errorPointIds=['key'])
            return result
        self.h.provider_hook = incorrect
        request = self.h.request()
        parent = self.h.app.grade(request)
        selected_id = self.h.source.support['task']['remediations'][0]['taskId']
        self.assertEqual(parent['remediationTaskId'], selected_id)
        task = resolve_course_task(self.h.capture['item'], selected_id)
        child = self.h.request(attemptId='child', requestId='child', purpose='remediation',
                               parentAttemptId='attempt-1', parentDiagnosticHash=parent['diagnosticHash'],
                               taskId=selected_id, taskHash=course_task_hash(task))
        receipt = self.h.app.grade(child)
        self.assertEqual(receipt['taskHash'], course_task_hash(task))
        self.assertEqual(receipt['diagnostic']['status'], 'correct')
        self.assertEqual(self.h.app.grade(child), receipt)
        forged = self.h.request(attemptId='forged', requestId='forged', purpose='remediation',
                                parentAttemptId='attempt-1', parentDiagnosticHash=parent['diagnosticHash'])
        self.assertEqual(self.h.app.grade(forged)['diagnostic']['status'], 'undetermined')

    def test_unknown_diagnostic_with_unknown_assistance_never_claimed(self):
        self.h.provider_hook = lambda *args: {'diagnostic': {'bad': True}, 'trace': None}
        request = self.h.request()
        request['submission'].update(assistance='unknown', maxPreHintLevel=0, answerRevealed=False)
        receipt = self.h.app.grade(request)
        self.assertEqual(receipt['diagnostic']['status'], 'undetermined')
        self.assertIsNone(receipt['attemptEvaluationHash'])
        with self.assertRaises(ValueError):
            self.h.app.claim(self.h.claim(request, receipt, attemptEvaluationHash='a' * 64))
        self.assertIsNone(self.h.app.read_claim('attempt-1'))

    def test_standard_host_unknown_assistance_preserves_metadata_and_claims_performance(self):
        for status, rating in (('correct', 'good'), ('partial', 'hard'), ('incorrect', 'again')):
            with self.subTest(status=status):
                h = Harness(support_id='partial')
                self.addCleanup(h.close)
                def result(task, answer, request_id, settings, reservation):
                    value = h.result(task, answer, request_id, settings, reservation)
                    diagnostic = value['diagnostic']
                    points = [point['id'] for point in task['criteria']]
                    if status == 'partial':
                        diagnostic.update(status='partial', matchedPointIds=points[:1], missedPointIds=points[1:])
                        diagnostic['pointEvidence'] = diagnostic['pointEvidence'][:1]
                    elif status == 'incorrect':
                        diagnostic.update(status='incorrect', matchedPointIds=[], missedPointIds=points, pointEvidence=[])
                    return value
                h.provider_hook = result
                request = h.request()
                request['submission'].update(assistance='unknown', maxPreHintLevel=0, answerRevealed=False)
                receipt = h.app.grade(request)
                self.assertEqual(receipt['diagnostic']['status'], status)
                claim = h.claim(request, receipt, rating=rating)
                accepted = h.app.claim(claim)
                self.assertEqual(accepted['status'], 'accepted')
                self.assertEqual(h.app.claim(claim), accepted)
                saved = h.app.read_claim_by_event(claim['eventId'])
                self.assertEqual(saved['request']['submission'], request['submission'])
                self.assertEqual(saved['request']['submission']['assistance'], 'unknown')
                with closing(sqlite3.connect(h.source.db)) as db:
                    raw = db.execute('SELECT request_json FROM native_course_attempts').fetchone()[0]
                    recorded = json.loads(raw)
                self.assertEqual(recorded['submission'], request['submission'])
                self.assertEqual(recorded['submission']['assistance'], 'unknown')

    def test_deterministic_and_self_assessment_never_charge_or_invoke_provider(self):
        request = self.h.request(action='self-assess', selfStatus='partial')
        receipt = self.h.app.grade(request)
        self.assertEqual(receipt['diagnostic']['source'], 'self-assess')
        self.assertEqual(self.h.calls, 0)
        quiz = Harness(mode='quiz')
        self.addCleanup(quiz.close)
        receipt = quiz.app.grade(quiz.request())
        self.assertEqual(receipt['diagnostic']['source'], 'deterministic')
        self.assertEqual(quiz.calls, 0)


if __name__ == '__main__':
    unittest.main()
