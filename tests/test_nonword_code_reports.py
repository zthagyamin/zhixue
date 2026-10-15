"""Shared report contracts and append-only declarations against temporary actual sources."""
import copy
import json
import sqlite3
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'companion'), str(Path(__file__).resolve().parent)]
import test_nonword_self_assessment as source_fixture
from infrastructure.source_protocol_hash import fingerprint


class ReportContractTests(unittest.TestCase):
    def test_shared_typescript_cases_have_exact_python_acceptance_and_normalization(self):
        from application.code_run_report import parse_code_run_report
        rows = json.loads((Path(__file__).parent / 'fixtures/code-run-report-contract-v1.json').read_text(encoding='utf-8'))['cases']
        for row in rows:
            with self.subTest(name=row['name']):
                if row['valid']:
                    self.assertEqual(parse_code_run_report(row['input']), row['normalized'])
                else:
                    with self.assertRaises(ValueError):
                        parse_code_run_report(row['input'])

    def test_combined_report_limit_and_nonfinite_or_boolean_counters_reject(self):
        from application.code_run_report import parse_code_run_report
        row = {'schemaVersion': 1, 'runId': 1, 'status': 'failed', 'phase': 'tests',
               'outcome': 'student-error', 'assertionsPassed': 0, 'assertionsExecuted': 1,
               'mapping': {'prefixLineCount': 0, 'originalLineCount': 1},
               'exception': {'kind': 'Error', 'message': 'x' * 4000, 'isAssertion': False},
               'firstFailure': {'caseId': 'sum', 'functionName': 'add',
                   'args': ['a' * 3950] * 4, 'kwargs': {key: 'b' * 3950 for key in ('a', 'b', 'c', 'd')},
                   'expected': ['c' * 3950] * 4, 'actual': ['d' * 3950] * 4, 'hint': 'h' * 2000}}
        with self.assertRaisesRegex(ValueError, 'code-report-size'):
            parse_code_run_report(row)
        row['firstFailure'] = {'caseId': 'sum', 'functionName': 'add', 'args': [1, 2],
                               'kwargs': {}, 'expected': 3, 'actual': 4}
        for counter in (True, float('inf'), float('nan'), -1, 0.5):
            with self.subTest(counter=counter), self.assertRaises(ValueError):
                parse_code_run_report({**row, 'assertionsExecuted': counter})



class CodeReportStoreTests(unittest.TestCase):
    def setUp(self):
        self.h = source_fixture.SelfAssessmentTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        subject = self.h.h.subject('original-code', 'code')
        self.support = {'schemaVersion': 1, 'type': 'code', 'functionNames': ['add'],
                        'cases': [{'id': 'sum', 'functionName': 'add', 'args': [1, 2], 'expected': 3}]}
        self.h.source = self.h.h.write(subject + '/code.md',
            '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: code\nzhixue_format: code\n---\n'
            '| ID | prompt | initialCode | testCode | learningSupport |\n|---|---|---|---|---|\n'
            '| q1 | Implement add. | def add(a,b): return 4 | | ' + json.dumps(self.support) + ' |\n')
        import index_gateway
        from infrastructure.nonword_source_resolver import exercise_presentation
        self.h.item = next(item for subject in index_gateway.load_gateway(self.h.root)['subjects']
                           for item in subject['items'] if item['pluginType'] == 'code')
        self.h.query = {'itemKey': 'practice:' + self.h.item['itemId'], 'contentHash': self.h.item['contentHash'],
                        'presentation': exercise_presentation(self.h.item)}
        capture = self.h.store.capture(self.h.query)
        self.submission = {'attemptId': 'code-original', 'binding': capture['binding'], 'answerRevision': 0,
                           'answer': 'def add(a,b): return 4', 'submittedAt': '2026-10-10T09:00:00.000Z',
                           'purpose': 'first', 'parentAttemptId': None, 'assistance': 'unknown'}
        self.h.store.submit(self.submission)

    def report(self, run=1, success=False):
        result = {'schemaVersion': 1, 'runId': run,
                  'identity': {'attemptId': 'code-original', 'revision': 0,
                               'sourceVersion': self.submission['binding']['contentHash'],
                               'testVersion': self.submission['binding']['contentHash']},
                  'status': 'passed' if success else 'failed', 'phase': 'tests',
                  'outcome': 'success' if success else 'student-error',
                  'assertionsPassed': 1 if success else 0, 'assertionsExecuted': 1,
                  'mapping': {'prefixLineCount': 0, 'originalLineCount': 1}}
        if not success:
            result['firstFailure'] = {'caseId': 'sum', 'functionName': 'add', 'args': [1, 2],
                                      'kwargs': {}, 'expected': 3, 'actual': 4}
        return result

    def request(self, report=None, **updates):
        return {'schemaVersion': 1, 'attemptId': self.submission['attemptId'],
                'binding': self.submission['binding'], 'answerRevision': 0,
                'submittedAt': self.submission['submittedAt'], 'report': report or self.report(), **updates}

    def test_first_and_recovery_reports_are_append_only_and_never_claim_success(self):
        first = self.request()
        receipt = self.h.store.record_code_report(first)
        self.assertEqual(receipt, {'schemaVersion': 1, 'durable': True,
            'reportId': 'code-report:' + fingerprint(first), 'evidence': first,
            'evidenceHash': fingerprint(first), 'provenance': 'client-public-tests'})
        self.assertEqual(self.h.store.record_code_report(copy.deepcopy(first)), receipt)
        second = self.h.store.record_code_report(self.request(self.report(2, True)))
        stored = self.h.store.read_attempt('code-original')
        self.assertEqual(stored['codeReports'], [receipt, second])
        self.assertEqual(stored['submission'], self.submission)
        self.assertEqual(self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'still-no-specialist'})['status'], 'pending')
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.h.store.claim({'attemptId': 'code-original', 'eventId': 'not-server-executed'})

    def test_structured_failure_must_match_actual_capture_case(self):
        for key, value in (('caseId', 'other'), ('functionName', 'other'), ('args', [2, 2]),
                           ('kwargs', {'x': 1}), ('expected', 99)):
            request = self.request()
            request['report']['firstFailure'][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'code-report-source'):
                self.h.store.record_code_report(request)
        self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], [])

    def test_unknown_source_records_only_original_version_and_first_immutable_report(self):
        self.h.available = False
        capture = self.h.store.capture(self.h.query)
        submission = {**self.submission, 'attemptId': 'unknown-code', 'binding': capture['binding']}
        self.h.store.submit(submission)
        report = self.report()
        report['identity']['attemptId'] = 'unknown-code'
        request = {**self.request(report), 'attemptId': 'unknown-code', 'binding': submission['binding']}
        original = self.h.store.record_code_report(request)
        self.h.available = True
        confirmed = self.h.store.capture(self.h.query)
        self.h.store.confirm({'attemptId': 'unknown-code', 'captureId': confirmed['captureId']})
        stored = self.h.store.read_attempt('unknown-code')
        self.assertEqual(stored['codeReports'], [original])
        self.assertEqual(stored['submission'], submission)
        self.assertNotEqual(stored['capture']['binding']['captureId'], request['binding']['captureId'])
        self.assertEqual(self.h.store.evaluate({'attemptId': 'unknown-code', 'requestId': 'not-a-grade'})['status'], 'pending')

    def test_outer_scope_time_revision_and_report_identity_match_original_submission(self):
        changes = [{'answerRevision': 1}, {'answerRevision': False},
                   {'submittedAt': '2026-10-10T09:01:00.000Z'}, {'submittedAt': '2026-10-10T09:00:00Z'},
                   {'attemptId': 'missing'}, {'schemaVersion': True}]
        changes += [{'binding': {**self.submission['binding'], key: value}} for key, value in (
            ('ownerId', 'other'), ('libraryId', 'other'), ('itemKey', 'other'),
            ('contentHash', 'b' * 64), ('captureId', 'other'))]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.h.store.record_code_report(self.request(**change))
        for key, value in (('attemptId', 'other'), ('revision', 1), ('sourceVersion', 'b' * 64), ('testVersion', 'b' * 64)):
            request = self.request()
            request['report']['identity'][key] = value
            with self.subTest(identity=key), self.assertRaisesRegex(ValueError, 'code-report-identity'):
                self.h.store.record_code_report(request)
        for store in (self.h.make_store(owner='other'), self.h.make_store(library='other'),
                      self.h.make_store(root=self.h.root.parent)):
            with self.assertRaises(ValueError):
                store.record_code_report(self.request())
        self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], [])
        self.assertEqual(self.h.store.read_attempt('code-original')['submission'], self.submission)

    def test_lost_receipt_and_exact_retry_keep_first_and_current_pending_evaluation(self):
        request = self.request()
        original = self.h.store.record_code_report(request)
        # Receipt was committed; delivery loss must not authorize another append.
        evaluation = self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'pending-grade'})
        self.assertEqual(self.h.store.record_code_report(copy.deepcopy(request)), original)
        stored = self.h.store.read_attempt('code-original')
        self.assertEqual(stored['codeReports'], [original])
        self.assertEqual(stored['evaluation'], evaluation)
        self.assertEqual(stored['evaluationRequest'], 'pending-grade')

    def test_new_report_invalidates_pending_request_without_overwriting_first(self):
        first = self.h.store.record_code_report(self.request())
        old = self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'old-grade'})
        self.assertEqual(old['status'], 'pending')
        second = self.h.store.record_code_report(self.request(self.report(2, True)))
        self.assertIsNone(self.h.store.read_attempt('code-original')['evaluation'])
        with self.assertRaisesRegex(ValueError, 'request-conflict'):
            self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'old-grade'})
        self.assertEqual(self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'fresh-grade'})['status'], 'pending')
        self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], [first, second])
        self.h.grade.assert_not_called()

    def test_late_previous_worker_cannot_replace_report_bound_evaluation(self):
        started, release = threading.Event(), threading.Event()
        current, calls = self.h.store._current, []
        def block(capture):
            calls.append(1)
            if len(calls) == 1:
                started.set()
                self.assertTrue(release.wait(5))
            return current(capture)
        with mock.patch.object(self.h.store, '_current', block), ThreadPoolExecutor(max_workers=1) as pool:
            old = pool.submit(self.h.store.evaluate, {'attemptId': 'code-original', 'requestId': 'late-grade'})
            self.assertTrue(started.wait(5))
            try:
                receipt = self.h.store.record_code_report(self.request())
                fresh = self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'report-grade'})
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, 'evaluation-conflict'):
                old.result(timeout=5)
        self.assertEqual(self.h.store.read_attempt('code-original')['evaluation'], fresh)
        self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], [receipt])

    def test_terminal_resolved_and_claim_allow_only_exact_report_replay(self):
        first = self.h.store.record_code_report(self.request())
        # Synthetic immutable prior validated result; no grader or V3 writer is invoked.
        attempt = self.h.store.read_attempt('code-original')
        result = self.h.store._evaluation(attempt, 'prior-validated', {
            'status': 'resolved', 'outcome': 'correct', 'correct': True,
            'explanation': 'Synthetic preexisting validated terminal evidence.'})
        with closing(sqlite3.connect(self.h.path)) as db:
            db.execute('UPDATE nonword_source_attempts SET evaluation=?,evaluation_request=?',
                       (json.dumps(result), 'prior-validated'))
            db.commit()
        self.assertEqual(self.h.store.record_code_report(self.request()), first)
        with self.assertRaisesRegex(ValueError, 'code-report-fixed'):
            self.h.store.record_code_report(self.request(self.report(2, True)))
        prior = self.h.store.claim({'attemptId': 'code-original', 'eventId': 'prior-formal-code'})
        self.assertEqual(self.h.store.record_code_report(self.request()), first)
        with self.assertRaisesRegex(ValueError, 'code-report-fixed'):
            self.h.store.record_code_report(self.request(self.report(3, True)))
        self.assertEqual(self.h.store.read_claim_by_event('prior-formal-code'), prior)
        self.assertEqual(self.h.store.read_attempt('code-original')['evaluation'], result)
        self.assertEqual(self.h.store.read_attempt('code-original')['submission'], self.submission)

    def test_failed_report_commit_preserves_submission_and_pending_result(self):
        old = self.h.store.evaluate({'attemptId': 'code-original', 'requestId': 'before-failure'})
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('synthetic code-report commit failure')
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect',
                        side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FailedCommit)):
            with self.assertRaises(sqlite3.OperationalError):
                self.h.store.record_code_report(self.request())
        saved = self.h.store.read_attempt('code-original')
        self.assertEqual(saved['codeReports'], [])
        self.assertEqual(saved['evaluation'], old)
        self.assertEqual(saved['submission'], self.submission)

    def test_cumulative_public_limit_refuses_new_report_without_dropping_first(self):
        reports = []
        for run in range(1, 100):
            request = self.request(self.report(run, True))
            request['report'].update(status='failed', phase='program', outcome='unknown',
                                    assertionsPassed=0, assertionsExecuted=0,
                                    exception={'kind': 'Error', 'message': '🧠' * 2000, 'isAssertion': False})
            try:
                reports.append(self.h.store.record_code_report(request))
            except ValueError as error:
                self.assertEqual(str(error), 'source-admission-code-report-limit')
                break
        else:
            self.fail('Append-only public evidence must have a finite recovery envelope.')
        self.assertGreater(len(reports), 1)
        self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], reports)
        self.assertEqual(self.h.store.record_code_report(reports[0]['evidence']), reports[0])
        self.assertEqual(self.h.store.read_attempt('code-original')['submission'], self.submission)

    def test_legacy_read_has_no_ddl_or_implicit_code_report_table(self):
        with closing(sqlite3.connect(self.h.path)) as db:
            db.execute('DROP TABLE nonword_source_code_reports')
            db.commit()
        connect, statements = sqlite3.connect, []
        def traced(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.set_trace_callback(statements.append)
            return db
        with mock.patch('infrastructure.nonword_source_store.sqlite3.connect', side_effect=traced):
            self.assertEqual(self.h.store.read_attempt('code-original')['codeReports'], [])
        self.assertFalse(any(word in statement.upper() for statement in statements
                             for word in ('CREATE ', 'ALTER ', 'INSERT ', 'UPDATE ')))
        with closing(connect(self.h.path)) as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='nonword_source_code_reports'").fetchone())

    def test_confirmed_noncode_rejects_report_declaration(self):
        import index_gateway
        from infrastructure.nonword_source_resolver import exercise_presentation
        item = next(item for subject in index_gateway.load_gateway(self.h.root)['subjects']
                    for item in subject['items'] if item['pluginType'] == 'flashcard')
        query = {'itemKey': 'practice:' + item['itemId'], 'contentHash': item['contentHash'],
                 'presentation': exercise_presentation(item)}
        capture = self.h.store.capture(query)
        submission = {**self.submission, 'attemptId': 'card', 'binding': capture['binding']}
        self.h.store.submit(submission)
        request = {**self.request(), 'attemptId': 'card', 'binding': capture['binding']}
        request['report']['identity'] = {'attemptId': 'card', 'revision': 0,
            'sourceVersion': capture['binding']['contentHash'], 'testVersion': capture['binding']['contentHash']}
        with self.assertRaisesRegex(ValueError, 'code-report-kind'):
            self.h.store.record_code_report(request)
        self.assertEqual(self.h.store.read_attempt('card')['codeReports'], [])

    def test_ordinary_script_cannot_relabel_nonassertion_test_failure_as_student_error(self):
        from application.code_run_report import parse_code_run_report
        ordinary = self.report()
        ordinary.pop('firstFailure')
        ordinary['exception'] = {'kind': 'NameError', 'message': 'Wrong test name.', 'isAssertion': False,
                                 'location': {'origin': 'tests', 'file': '<题目测试>', 'line': 1}}
        with self.assertRaisesRegex(ValueError, 'untrusted-code-attribution'):
            self.h.store.record_code_report(self.request(ordinary))
        ordinary['outcome'] = 'unknown'
        self.assertEqual(parse_code_run_report(ordinary)['outcome'], 'unknown')
        receipt = self.h.store.record_code_report(self.request(ordinary))
        self.assertEqual(receipt['evidence']['report']['outcome'], 'unknown')


class CodeReportRouteTests(unittest.TestCase):
    def setUp(self):
        import test_native_course_routes as http_fixture
        self.transport = http_fixture.NativeCourseRouteTests()
        self.transport.setUp()
        self.h = CodeReportStoreTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        self.h.h.store = self.h.h.make_store(owner=self.transport.owner)
        capture = self.h.h.store.capture(self.h.h.query)
        self.h.submission = {**self.h.submission, 'binding': capture['binding']}
        self.h.h.store.submit(self.h.submission)

    def request(self, action, body, **options):
        return self.transport.request('unused', path='/v1/nonword/source',
            payload={'schemaVersion': 1, 'action': action, 'request': body}, **options)

    def test_authenticated_envelope_records_real_store_receipt_and_reads_public_evidence_only(self):
        import routes_nonword_source
        raw = self.h.request()
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=self.h.h.store) as factory:
            status, receipt = self.request('code-report', raw)
            self.assertEqual(status, 200)
            self.assertEqual(receipt['evidence'], raw)
            self.assertEqual(receipt['evidenceHash'], fingerprint(raw))
            self.assertEqual(factory.call_args.args[1], self.transport.owner)
            status, read = self.request('read', {'attemptId': 'code-original'})
            self.assertEqual(status, 200)
            self.assertEqual(read['codeReports'], [receipt])
            self.assertNotIn('"route"', json.dumps(read))
            self.assertNotIn(str(self.h.h.root), json.dumps(read))


    def test_lost_http_reply_after_commit_retries_original_report_without_second_append(self):
        import routes_nonword_source
        raw = self.h.request()
        class LostReply:
            def send_json(self, status, body):
                if status == 200:
                    raise OSError('synthetic receipt loss after commit')
                raise AssertionError(body)
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=self.h.h.store):
            with self.assertRaises(OSError):
                routes_nonword_source.post_nonword_source(LostReply(), object(), '/v1/nonword/source',
                    self.transport.owner, {'schemaVersion': 1, 'action': 'code-report', 'request': raw})
            status, receipt = self.request('code-report', raw)
        self.assertEqual(status, 200)
        self.assertEqual(receipt['evidence'], raw)
        self.assertEqual(self.h.h.store.read_attempt('code-original')['codeReports'], [receipt])

    def test_pairing_origin_and_owner_binding_fail_before_report_write(self):
        import routes_nonword_source
        with mock.patch.object(routes_nonword_source, 'create_source_admission') as factory:
            for token in ('', 'expired', 'unpaired'):
                self.assertEqual(self.request('code-report', self.h.request(), token=token)[0], 401)
            for origin in (None, 'null', 'https://other.example'):
                self.assertEqual(self.request('code-report', self.h.request(), origin=origin)[0], 403)
            factory.assert_not_called()
        raw = self.h.request()
        raw['binding'] = {**raw['binding'], 'ownerId': 'body-selected-owner'}
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=self.h.h.store):
            self.assertEqual(self.request('code-report', raw)[0], 409)
        self.assertEqual(self.h.h.store.read_attempt('code-original')['codeReports'], [])


if __name__ == '__main__':
    unittest.main()
