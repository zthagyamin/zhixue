"""Origin/session compatibility and SSE handoff checks with synthetic local data."""
import json
import sqlite3
import sys
import time
import types
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from dataclasses import replace
from unittest import mock

import test_pm_route_compatibility as fixtures
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.managed_chat import create_managed_chat_transport
from infrastructure.math_grade_ledger import MathGradeLedger
from infrastructure.course_grade_ledger import CourseGradeLedger
from application.local_chat import execute_chat
from local_chat_transport_fixture import inline_chat_transport
import test_native_math_service as math_fixtures
import test_native_course_service as course_fixtures
import test_local_chat_recovery as chat_fixtures

server = fixtures.server
ORIGIN = fixtures.ORIGIN
OTHER_ORIGIN = 'https://unregistered-origin.invalid'
NATIVE_GET = {'/v1/study-data', '/v1/dashboard/today'}


class CompanionOriginPolicyTests(unittest.TestCase):
    def setUp(self):
        self.harness = fixtures.RouteCompatibilityTests()
        self.harness.setUp()
        self.addCleanup(self.harness.tearDown)
        self.identity = mock.patch.object(server, 'runtime_instance_id', return_value='synthetic-origin-test')
        self.identity.start()
        self.addCleanup(self.identity.stop)

    def request(self, method, path, payload=None, *, origin=ORIGIN, session=None):
        headers = {'Content-Type': 'application/json'}
        if origin is not None:
            headers['Origin'] = origin
        if session is None:
            session = self.harness.session
        if session:
            headers['X-Study-Loop-Session'] = session
        request = urllib.request.Request(self.harness.base + path, method=method, headers=headers,
            data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = self.harness.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read().decode('utf-8')
            return response.status, response.headers, raw

    def assert_cors(self, headers, origin):
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), ORIGIN if origin == ORIGIN else None)

    def test_private_get_matrix_keeps_native_reads_and_route_origin_guards(self):
        self.assertTrue(NATIVE_GET < set(server.http_routes.GET_ROUTES))
        for origin in (ORIGIN, OTHER_ORIGIN, None, 'null'):
            for path in sorted(server.http_routes.GET_ROUTES):
                for session in ('', 'invalid-synthetic-session', self.harness.session):
                    # Successful guarded route bodies are covered by their own integration tests.
                    if origin == ORIGIN and session == self.harness.session and path not in NATIVE_GET:
                        continue
                    with self.subTest(origin=origin, path=path, paired=session == self.harness.session):
                        status, headers, raw = self.request('GET', path, origin=origin, session=session)
                        expected = 401 if session != self.harness.session else 200 if path in NATIVE_GET else 403
                        self.assertEqual(status, expected)
                        self.assert_cors(headers, origin)
                        self.assertIsInstance(json.loads(raw), dict)

    def test_post_matrix_requires_origin_before_pairing_or_private_dispatch(self):
        private = sorted(set(server.http_routes.POST_ROUTES) | {
            '/v1/account-sync/prepare', '/v1/account-sync/start', '/v1/account-sync/stop'})
        with mock.patch.object(server.http_routes, 'dispatch', side_effect=AssertionError('must-not-dispatch')):
            for origin in (ORIGIN, OTHER_ORIGIN, None, 'null'):
                for session in ('', 'invalid-synthetic-session', self.harness.session):
                    if origin == ORIGIN and session == self.harness.session:
                        continue
                    for path in private:
                        with self.subTest(origin=origin, path=path, paired=session == self.harness.session):
                            status, headers, _ = self.request('POST', path, {}, origin=origin, session=session)
                            self.assertEqual(status, 401 if origin == ORIGIN else 403)
                            self.assert_cors(headers, origin)
        with mock.patch.object(server, 'pair_account', side_effect=AssertionError('must-not-pair')):
            for origin in (OTHER_ORIGIN, None, 'null'):
                self.assertEqual(self.request('POST', '/v1/pair', {}, origin=origin, session='')[0], 403)

    def test_preflight_and_public_health_do_not_grant_private_access(self):
        for origin in (ORIGIN, OTHER_ORIGIN, None, 'null'):
            with self.subTest(origin=origin):
                status, headers, _ = self.request('OPTIONS', '/v1/ai/chat', origin=origin, session='')
                self.assertEqual(status, 204 if origin == ORIGIN else 403)
                self.assert_cors(headers, origin)
                status, headers, raw = self.request('GET', '/v1/health', origin=origin, session='')
                self.assertEqual(status, 200)
                self.assert_cors(headers, origin)
                health = json.loads(raw)
                self.assertTrue(health['pairingRequired'])
                self.assertNotIn('sessionToken', health)
                self.assertEqual(self.request('GET', '/v1/study-data', origin=origin, session='')[0], 401)

    def configure_chat(self):
        secrets = {}
        keyring = types.SimpleNamespace(
            get_password=lambda _service, name: secrets.get(name),
            set_password=lambda _service, name, value: secrets.__setitem__(name, value))
        patch = mock.patch.dict(sys.modules, {'keyring': keyring})
        patch.start()
        self.addCleanup(patch.stop)
        self.library = server.local_vault_library_id(self.harness.fixture.vault)
        self.chat_request = {'requestId': 'origin-policy-request', 'provider': 'chatgpt',
            'model': 'fixture-model', 'settingsRevision': 1,
            'context': {'id': 'synthetic-question', 'title': 'Synthetic question'},
            'messages': [{'role': 'user', 'content': 'Explain the synthetic example.'}]}
        status, _, _ = self.request('POST', '/v1/ai/configure', {'libraryId': self.library,
            'settings': {'provider': 'chatgpt', 'model': 'fixture-model',
                'baseUrl': 'https://api.openai.com/v1', 'enabled': True, 'confirmCosts': True,
                'providerKey': 'synthetic-key', 'expectedRevision': 0}})
        self.assertEqual(status, 200)

    def post_chat(self):
        return self.request('POST', '/v1/ai/chat', {'libraryId': self.library, 'request': self.chat_request})

    def bind_transport(self, transport):
        original = server.route_services
        patch = mock.patch.object(server, 'route_services',
            side_effect=lambda: replace(original(), local_chat_transport=transport))
        patch.start()
        self.addCleanup(patch.stop)

    def test_allowed_sse_stream_and_duplicate_replay_keep_one_result(self):
        self.configure_chat()
        self.bind_transport(inline_chat_transport)
        events = [{'type': 'delta', 'text': 'Synthetic explanation.'},
                  {'type': 'done', 'model': 'fixture-model', 'provider': 'chatgpt'}]
        with mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=lambda *_: iter(events)) as provider:
            for _ in range(2):
                status, headers, raw = self.post_chat()
                self.assertEqual(status, 200)
                self.assertEqual(headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
                self.assert_cors(headers, ORIGIN)
                self.assertEqual(headers.get('Vary'), 'Origin')
                self.assertIn('Synthetic explanation.', raw)
                self.assertIn('"type": "done"', raw)
            provider.assert_called_once()
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT count(*), state FROM study_chat_requests').fetchone(), (1, 'done'))

    def test_origin_revoked_after_chat_preparation_never_starts_stream_or_provider(self):
        self.configure_chat()
        prepared = []

        def revoke_after_prepare(*args):
            transport = create_managed_chat_transport(*args)
            prepared.append(transport.executor)
            server.CONFIG['allowed_origins'] = []
            return transport

        self.bind_transport(revoke_after_prepare)
        with mock.patch('infrastructure.managed_chat.subprocess.Popen',
                        side_effect=AssertionError('provider-process-must-not-start')) as process:
            status, headers, raw = self.post_chat()
            self.assertEqual(status, 403)
            self.assert_cors(headers, None)
            self.assertNotIn('text/event-stream', headers.get('Content-Type', ''))
            self.assertNotIn('data:', raw)
            self.assertEqual(json.loads(raw)['message'], '该网页来源未被本地同步助手授权。')
            self.assertIsNone(prepared[0].process)
            self.assertTrue(prepared[0].stopped)
            process.assert_not_called()
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT state, text, result FROM study_chat_requests').fetchone(),
                             ('abandoned', '', None))
            self.assertEqual(database.execute('SELECT state, reserved FROM study_chat_budget').fetchone(),
                             ('released', 0))
            self.assertEqual(database.execute('SELECT count(*) FROM study_chat_executors').fetchone()[0], 0)

    def test_rejected_preparation_allows_immediate_same_request_retry(self):
        self.configure_chat()
        now = [time.time()]
        preparations = []

        def transport(*args):
            preparations.append(args[1]['generation'])
            if len(preparations) == 1:
                server.CONFIG['allowed_origins'] = []
            return inline_chat_transport(*args)

        self.bind_transport(transport)
        events = [{'type': 'delta', 'text': 'Resumed synthetic answer.'},
                  {'type': 'done', 'model': 'fixture-model', 'provider': 'chatgpt'}]
        with mock.patch.object(LocalChatLedger, '_now', side_effect=lambda: now[0]), \
                mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=lambda *_: iter(events)) as provider:
            self.assertEqual(self.post_chat()[0], 403)
            provider.assert_not_called()
            server.CONFIG['allowed_origins'] = [ORIGIN]
            for _ in range(2):
                status, headers, raw = self.post_chat()
                self.assertEqual(status, 200)
                self.assert_cors(headers, ORIGIN)
                self.assertIn('Resumed synthetic answer.', raw)
                self.assertIn('"type": "done"', raw)
            provider.assert_called_once()
        self.assertEqual(preparations, [1, 2])
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT count(*), state, generation FROM study_chat_requests').fetchone(),
                             (1, 'done', 2))
            self.assertEqual(database.execute('SELECT count(*), state FROM study_chat_budget').fetchone(), (1, 'finished'))
        self.assertEqual(list(self.harness.fixture.vault.rglob('*.jsonl')), [])

    def test_rejected_chat_releases_budget_for_math_and_course(self):
        self.configure_chat()

        def revoke_after_prepare(*args):
            server.CONFIG['allowed_origins'] = []
            return inline_chat_transport(*args)

        self.bind_transport(revoke_after_prepare)
        self.assertEqual(self.post_chat()[0], 403)
        owner = server.authenticate_session(self.harness.session)
        math_fixture = math_fixtures.NativeMathServiceTests()
        math_fixture.setUp()
        self.addCleanup(math_fixture.tearDown)
        math = MathGradeLedger(server.LOCAL_DATABASE_PATH, owner,
            math_fixture.service.library, math_fixture.vault)
        math.claim(math_fixture.claim)
        math.begin(math_fixture.request)
        settings = {'maxOutputTokens': 10, 'dailyRequestLimit': 10,
                    'dailyTokenLimit': 100000, 'concurrentLimit': 1}
        self.assertGreater(math.reserve(math_fixture.request['requestId'], {}, settings), 0)
        math.finish_budget(math_fixture.request['requestId'], 0)
        course_fixture = course_fixtures.Harness()
        self.addCleanup(course_fixture.close)
        course = CourseGradeLedger(server.LOCAL_DATABASE_PATH, owner,
            course_fixture.identity['libraryId'], course_fixture.source.vault)
        request = course_fixture.request()
        course.begin(request)
        self.assertGreater(course.reserve(request, course_fixture.task, settings), 0)

    def test_cancel_prepared_preserves_dispatched_and_completed_results(self):
        ledger = LocalChatLedger(server.LOCAL_DATABASE_PATH, 'synthetic-owner',
            'synthetic-library', self.harness.fixture.vault)
        ticket = ledger.begin(chat_fixtures.REQUEST, chat_fixtures.SETTINGS)
        result = execute_chat(ledger, ticket,
            lambda: iter([{'type': 'delta', 'text': 'Kept partial'}, chat_fixtures.DONE]), lambda: None)
        self.addCleanup(result.events.close)
        self.assertEqual(next(result.events), {'type': 'delta', 'text': 'Kept partial'})
        result.cancel_prepared()
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT state, text FROM study_chat_requests').fetchone(),
                             ('dispatched', 'Kept partial'))
            self.assertEqual(database.execute('SELECT state FROM study_chat_budget').fetchone()[0], 'inflight')
        self.assertEqual(list(result.events), [chat_fixtures.DONE])
        result.cancel_prepared()
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT state, text FROM study_chat_requests').fetchone(),
                             ('done', 'Kept partial'))
            self.assertEqual(database.execute('SELECT state FROM study_chat_budget').fetchone()[0], 'finished')

    def test_stale_preparation_cancel_cannot_release_new_generation(self):
        now = [1000]
        ledger = LocalChatLedger(server.LOCAL_DATABASE_PATH, 'synthetic-owner',
            'synthetic-library', self.harness.fixture.vault, clock=lambda: now[0])
        old = ledger.begin(chat_fixtures.REQUEST, chat_fixtures.SETTINGS)
        result = execute_chat(ledger, old,
            lambda: (_ for _ in ()).throw(AssertionError('provider-must-not-run')), lambda: None)
        self.addCleanup(result.events.close)
        now[0] += 121
        current = ledger.begin(chat_fixtures.REQUEST, chat_fixtures.SETTINGS)
        result.cancel_prepared()
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT state, generation FROM study_chat_requests').fetchone(),
                             ('preflight', current['generation']))
            self.assertEqual(database.execute('SELECT state FROM study_chat_budget').fetchone()[0], 'inflight')


if __name__ == '__main__':
    unittest.main()
