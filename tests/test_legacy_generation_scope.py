"""Real application/cache with controlled normal generation and no provider calls."""
import copy
import contextlib
import io
import json
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event
from unittest import mock

import test_companion as fixtures
from application.failures import CompanionFailure
from infrastructure.ai_adapter import create_ai_application
import routes_ai
import companion_setup
from infrastructure.source_adapter import create_source_application

server = fixtures.server


class LegacyGenerationScopeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompanionSyncTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.other = self.fixture.vault / 'other-library'
        self.other.mkdir()
        self.current = {'source': {'title': 'Current B'}, 'subjects': []}
        self.generated = {'source': {'title': 'Generated A'}, 'subjects': []}

    def app(self, generate):
        services = replace(server.route_services(), call_deepseek=generate,
                           with_connections=lambda value: copy.deepcopy(value))
        return create_ai_application(services)

    def test_source_switch_during_generation_preserves_the_current_cache(self):
        def generate(*args):
            server.CONFIG['learning_vault_root'] = str(self.other)
            server.set_state(copy.deepcopy(self.current))
            return copy.deepcopy(self.generated)

        with self.assertRaises(CompanionFailure) as caught:
            self.app(generate).generate({'content': 'Synthetic original material', 'title': 'Original A'})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(server.STATE, self.current)

    def test_unchanged_source_preserves_the_existing_generation_result(self):
        calls = []

        def generate(*args):
            calls.append(args)
            return copy.deepcopy(self.generated)

        result = self.app(generate).generate({'content': 'Synthetic original material', 'title': 'Original A'})
        self.assertEqual(result, self.generated)
        self.assertEqual(server.STATE, self.generated)
        self.assertEqual(calls, [('Synthetic original material', '', 'Original A', '用户临时导入')])

    def test_later_generation_wins_with_either_provider_completion_order(self):
        for first_to_finish in ('old', 'new'):
            with self.subTest(first_to_finish=first_to_finish):
                old_started, new_started, release_old, release_new = (Event() for _ in range(4))
                before = copy.deepcopy(server.STATE)

                def generate(content, _next, title, _scope):
                    if title == 'Old':
                        old_started.set()
                        self.assertTrue(release_old.wait(5))
                        return {'source': {'title': 'Old'}, 'subjects': []}
                    new_started.set()
                    self.assertTrue(release_new.wait(5))
                    return {'source': {'title': 'New'}, 'subjects': []}

                with ThreadPoolExecutor(max_workers=2) as pool:
                    old = pool.submit(self.app(generate).generate, {'content': 'Old material', 'title': 'Old'})
                    self.assertTrue(old_started.wait(5))
                    new = pool.submit(self.app(generate).generate, {'content': 'New material', 'title': 'New'})
                    try:
                        self.assertTrue(new_started.wait(5))
                        if first_to_finish == 'old':
                            release_old.set()
                            with self.assertRaises(CompanionFailure):
                                old.result(timeout=5)
                            self.assertEqual(server.STATE, before)
                        release_new.set()
                        result = new.result(timeout=5)
                        self.assertEqual(result['source']['title'], 'New')
                    finally:
                        release_old.set()
                        release_new.set()
                    with self.assertRaises(CompanionFailure):
                        old.result(timeout=5)
                self.assertEqual(server.STATE, result)

    def test_source_is_checked_inside_the_actual_cache_commit(self):
        entered, release = Event(), Event()
        original = server.set_state

        def delayed_set(value, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(value, **kwargs)

        services = replace(server.route_services(), call_deepseek=lambda *_: copy.deepcopy(self.generated),
                           set_state=delayed_set, with_connections=lambda value: value)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(create_ai_application(services).generate, {'content': 'Original A'})
            try:
                self.assertTrue(entered.wait(5))
                server.CONFIG['learning_vault_root'] = str(self.other)
                original(copy.deepcopy(self.current))
            finally:
                release.set()
            with self.assertRaises(CompanionFailure):
                future.result(timeout=5)
        self.assertEqual(server.STATE, self.current)

    def test_unconfigured_vault_and_normal_vocabulary_content_remain_compatible(self):
        server.CONFIG['learning_vault_root'] = str(self.other / 'not-configured')
        word = copy.deepcopy(server.STATE)
        self.assertEqual(self.app(lambda *_: word).generate({'content': 'Synthetic vocabulary'}), word)
        self.assertEqual(server.STATE, word)

    def test_real_route_preserves_scope_error_and_does_not_send_a_success(self):
        sent = []
        request = mock.Mock(headers={'Origin': 'https://fixture.invalid', 'X-Study-Loop-Session': 'synthetic-session'})
        request.send_json.side_effect = lambda status, value: sent.append((status, value))

        def generate(*args):
            server.CONFIG['learning_vault_root'] = str(self.other)
            server.set_state(copy.deepcopy(self.current))
            return self.generated

        services = replace(server.route_services(), call_deepseek=generate,
                           allowed_origin=lambda value: value == 'https://fixture.invalid',
                           authenticate_session=lambda value: 'synthetic-owner')
        routes_ai.post_generate(request, services, '/v1/generate', 'synthetic-owner', {'content': 'Original A'})
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], 409)
        self.assertEqual(sent[0][1]['error'], 'ai-generation-stale')
        self.assertEqual(server.STATE, self.current)

    def test_authority_change_during_generation_does_not_commit(self):
        before = copy.deepcopy(server.STATE)
        current = [True]

        def authorize():
            if not current[0]:
                raise CompanionFailure(401, {'error': 'ai-generation-authority-changed'})

        def generate(*args):
            current[0] = False
            return self.generated

        services = replace(server.route_services(), call_deepseek=generate)
        with self.assertRaises(CompanionFailure) as caught:
            create_ai_application(services, authorize=authorize).generate({'content': 'Original A'})
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(server.STATE, before)

    def test_actual_http_returns_scope_or_session_error_without_replacing_current_material(self):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        origin = f'http://127.0.0.1:{httpd.server_port}'
        server.CONFIG['allowed_origins'] = [origin]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                session = server.pair_account('A1B2C3', 'synthetic-generation-owner')['sessionToken']
            for change, status, code in [('root', 409, 'ai-generation-stale'),
                                         ('session', 401, 'ai-generation-authority-changed')]:
                with self.subTest(change=change):
                    server.CONFIG['learning_vault_root'] = str(self.fixture.vault)
                    server.set_state(copy.deepcopy(self.current))

                    def generate(*args):
                        if change == 'root':
                            server.CONFIG['learning_vault_root'] = str(self.other)
                        else:
                            self.assertTrue(server.revoke_session(session))
                        return copy.deepcopy(self.generated)

                    request = urllib.request.Request(origin + '/v1/generate', method='POST',
                        headers={'Origin': origin, 'Content-Type': 'application/json', 'X-Study-Loop-Session': session},
                        data=json.dumps({'content': 'Synthetic original material', 'title': 'Original A'}).encode())
                    with mock.patch.object(server, 'call_deepseek', side_effect=generate):
                        with self.assertRaises(urllib.error.HTTPError) as caught:
                            urllib.request.urlopen(request, timeout=5)
                    with caught.exception as error:
                        self.assertEqual(error.code, status)
                        self.assertEqual(json.load(error)['error'], code)
                    self.assertEqual(server.STATE, self.current)
        finally:
            httpd.shutdown()
            thread.join(3)
            httpd.server_close()
            self.assertFalse(thread.is_alive())

    def setup_application(self):
        installation = self.fixture.vault / 'synthetic-installation'
        installation.mkdir()
        (installation / 'config.local.json').write_text(json.dumps({
            'learning_vault_root': str(self.fixture.vault), 'workspace_generation': 0}), encoding='utf-8')
        runtime = mock.Mock()
        runtime.service.lock = threading.RLock()
        services = replace(server.route_services(), ROOT=installation,
                           get_note_source_runtime=lambda: runtime)
        app = create_source_application(services)

        def configure(root):
            _, revision = companion_setup.settings(installation)
            return app.ports.configure_workspace({'expectedRevision': revision, 'mode': 'existing',
                                                  'path': str(root), 'confirmed': True})

        return configure

    def test_real_switch_out_and_back_keeps_the_old_generation_obsolete(self):
        configure = self.setup_application()

        def generate(*args):
            configure(self.other)
            configure(self.fixture.vault)
            server.set_state(copy.deepcopy(self.current))
            return self.generated

        with self.assertRaises(CompanionFailure) as caught:
            self.app(generate).generate({'content': 'Original A'})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(server.CONFIG['workspace_generation'], 2)
        self.assertEqual(server.STATE, self.current)

    def test_real_setup_waits_for_the_source_check_and_cache_commit(self):
        configure = self.setup_application()
        entered, release, setup_started, setup_finished = (Event() for _ in range(4))
        original = server.local_vault_library_id
        calls, ownership = [], []

        def checked(root):
            value = original(root)
            calls.append(True)
            if len(calls) == 2:
                ownership.append(companion_setup.CONFIGURATION_LOCK._is_owned())
                entered.set()
                self.assertTrue(release.wait(5))
            return value

        def switch():
            setup_started.set()
            value = configure(self.other)
            setup_finished.set()
            return value

        services = replace(server.route_services(), local_vault_library_id=checked,
                           call_deepseek=lambda *_: copy.deepcopy(self.generated),
                           with_connections=lambda value: value)
        with ThreadPoolExecutor(max_workers=2) as pool:
            generated = pool.submit(create_ai_application(services).generate, {'content': 'Original A'})
            future = None
            try:
                self.assertTrue(entered.wait(5))
                future = pool.submit(switch)
                self.assertTrue(setup_started.wait(5))
                self.assertEqual(ownership, [True])
                self.assertFalse(setup_finished.is_set())
            finally:
                release.set()
            self.assertEqual(generated.result(timeout=5), self.generated)
            self.assertIsNotNone(future)
            future.result(timeout=5)
        self.assertTrue(setup_finished.is_set())
        self.assertEqual(server.CONFIG['learning_vault_root'], str(self.other.resolve()))

    def test_generation_waiting_for_cache_lock_does_not_hold_the_note_source_lock(self):
        original = server.DATA_LOCK
        waiting = Event()

        class ObservedLock:
            def __enter__(self):
                waiting.set()
                original.acquire()
                return self

            def __exit__(self, *args):
                original.release()

        with mock.patch.object(server, 'DATA_LOCK', ObservedLock()):
            app = self.app(lambda *_: copy.deepcopy(self.generated))
            with ThreadPoolExecutor(max_workers=1) as pool:
                with original:
                    future = pool.submit(app.generate, {'content': 'Original A'})
                    self.assertTrue(waiting.wait(5))
                    acquired = server.NOTE_SOURCE_LOCK.acquire(blocking=False)
                    try:
                        self.assertTrue(acquired, 'generation must leave the native DATA→NOTE path available')
                    finally:
                        if acquired:
                            server.NOTE_SOURCE_LOCK.release()
                self.assertEqual(future.result(timeout=5), self.generated)


if __name__ == '__main__':
    unittest.main()
