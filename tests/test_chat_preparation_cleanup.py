"""Unsent chat preparation failures release only their own reservation."""
import io
import sqlite3
import types
import unittest
from contextlib import closing
from dataclasses import replace
from unittest import mock

import test_companion_origin_policy as origin_fixtures
from infrastructure.ai_adapter import create_ai_application
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.managed_chat import create_managed_chat_transport
from application.failures import CompanionFailure
import routes_ai

server = origin_fixtures.server


class ChatPreparationCleanupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = origin_fixtures.CompanionOriginPolicyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.configure_chat()
        self.owner = server.authenticate_session(self.fixture.harness.session)
        self.services = server.route_services()
        self.payload = {'libraryId': self.fixture.library, 'request': self.fixture.chat_request}
        self.ledger = LocalChatLedger(server.LOCAL_DATABASE_PATH, self.owner,
            self.fixture.library, self.fixture.harness.fixture.vault)

    def assert_released(self):
        with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            request = database.execute('SELECT state, text, result, generation FROM study_chat_requests').fetchone()
            budget = database.execute('SELECT state, reserved FROM study_chat_budget').fetchone()
        self.assertEqual(request[:3], ('abandoned', '', None))
        self.assertEqual(budget, ('released', 0))
        with self.services.local_database() as database:
            settings, _key = self.services.ai_store(database).snapshot(self.owner, self.fixture.library)
        retry = self.ledger.begin(self.fixture.chat_request, settings)
        self.assertEqual(retry['kind'], 'start')
        self.assertEqual(retry['generation'], request[3] + 1)
        self.ledger.abandon(retry, unsent_only=True)
        self.assertEqual(list(self.fixture.harness.fixture.vault.rglob('*.jsonl')), [])

    def handler(self):
        return types.SimpleNamespace(
            headers={'Origin': origin_fixtures.ORIGIN,
                     'X-Study-Loop-Session': self.fixture.harness.session},
            send_response=mock.Mock(), send_header=mock.Mock(), end_headers=mock.Mock(),
            send_json=mock.Mock(), close_connection=False, wfile=io.BytesIO(),
            connection=types.SimpleNamespace(gettimeout=mock.Mock(return_value=5), settimeout=mock.Mock()))

    def test_header_disconnect_releases_unsent_request_without_provider(self):
        handler = self.handler()
        handler.end_headers.side_effect = BrokenPipeError('synthetic disconnected peer')
        services = replace(self.services, local_chat_transport=create_managed_chat_transport)
        with mock.patch('infrastructure.managed_chat.subprocess.Popen') as process, \
                mock.patch.object(server.study_ai_provider, 'stream_chat') as provider:
            try:
                routes_ai.post_ai_settings(handler, services, '/v1/ai/chat', self.owner, self.payload)
            except BrokenPipeError:
                pass
            process.assert_not_called()
            provider.assert_not_called()
        self.assert_released()

    def test_connection_setup_failure_releases_unsent_request(self):
        handler = self.handler()
        handler.connection.gettimeout.side_effect = ConnectionResetError('synthetic closed socket')
        services = replace(self.services, local_chat_transport=create_managed_chat_transport)
        with mock.patch('infrastructure.managed_chat.subprocess.Popen') as process:
            try:
                routes_ai.post_ai_settings(handler, services, '/v1/ai/chat', self.owner, self.payload)
            except ConnectionResetError:
                pass
            process.assert_not_called()
        self.assert_released()

    def test_transport_construction_failure_releases_unsent_request(self):
        def failed_transport(*_args):
            raise ValueError('invalid-ai-chat')
        app = create_ai_application(replace(self.services, local_chat_transport=failed_transport))
        with self.assertRaisesRegex(ValueError, 'invalid-ai-chat'):
            app.configured(self.owner, 'chat', self.payload)
        self.assert_released()

    def test_unexpected_transport_failure_keeps_storage_error_and_releases_reservation(self):
        def failed_transport(*_args):
            raise OSError('synthetic preparation failure')
        app = create_ai_application(replace(self.services, local_chat_transport=failed_transport))
        with self.assertRaises(CompanionFailure) as caught:
            app.configured(self.owner, 'chat', self.payload)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.payload['error'], 'ai-chat-storage-unavailable')
        self.assert_released()

    def test_actual_managed_frame_limit_releases_preparation_without_starting_child(self):
        # The configured URL is duplicated in the snapshot; use accepted synthetic
        # local settings to exercise the real frame bound, without a network call.
        status, _, _ = self.fixture.request('POST', '/v1/ai/configure', {
            'libraryId': self.fixture.library,
            'settings': {'provider': 'chatgpt', 'model': 'fixture-model',
                'baseUrl': 'http://127.0.0.1/' + 'a' * 140000, 'enabled': True,
                'confirmCosts': True, 'providerKey': 'synthetic-key', 'expectedRevision': 1}})
        self.assertEqual(status, 200)
        self.fixture.chat_request['settingsRevision'] = 2
        app = create_ai_application(replace(self.services, local_chat_transport=create_managed_chat_transport))
        with mock.patch('infrastructure.managed_chat.subprocess.Popen') as process:
            with self.assertRaisesRegex(ValueError, 'invalid-ai-chat'):
                app.configured(self.owner, 'chat', self.payload)
            process.assert_not_called()
        self.assert_released()


if __name__ == '__main__':
    unittest.main()
