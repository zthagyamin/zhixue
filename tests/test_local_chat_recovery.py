"""Actual application/SQLite with synthetic providers and no external network."""
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import test_companion as fixtures
from application.failures import CompanionFailure
from infrastructure.ai_adapter import create_ai_application
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.code_review_ledger import CodeReviewLedger
from local_chat_transport_fixture import inline_chat_transport

server = fixtures.server
FIXTURE = json.loads((Path(__file__).parent/'fixtures/local-chat-recovery-v1.json').read_text(encoding='utf-8'))
REQUEST, SETTINGS, DONE = (FIXTURE[key] for key in ('request', 'settings', 'done'))

@contextmanager
def database(path):
    with closing(sqlite3.connect(path)) as db:
        with db:
            yield db


class LocalChatRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompanionSyncTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.vault
        self.owner = 'owner-one'
        self.library = server.local_vault_library_id(self.root)
        self.secret = 'synthetic-provider-secret'
        self.store = SimpleNamespace(snapshot=lambda *_args:(copy.deepcopy(SETTINGS), self.secret))
        self.snapshot = mock.patch.object(server, 'ai_store', return_value=self.store)
        self.snapshot.start()
        self.addCleanup(self.snapshot.stop)
        self.services = replace(server.route_services(),local_chat_transport=inline_chat_transport)
        self.app = create_ai_application(self.services)
        self.deny = mock.patch('urllib.request.build_opener', side_effect=AssertionError('external-network-denied'))
        self.deny.start()
        self.addCleanup(self.deny.stop)

    def chat(self, request=None, app=None):
        return (app or self.app).configured(self.owner, 'chat',
            {'libraryId':self.library,'request':copy.deepcopy(request or REQUEST)}).events

    def test_done_replay_uses_saved_result_without_resolving_another_key(self):
        calls = []
        def provider(*_args):
            calls.append(True)
            yield {'type':'delta','text':'中文 hint'}
            yield DONE
        with mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=provider):
            first = list(self.chat())
            with mock.patch.object(self.store, 'snapshot', side_effect=AssertionError('replay-must-not-resolve-key')):
                self.assertEqual(list(self.chat()), first)
        self.assertEqual(calls, [True])
        with database(server.LOCAL_DATABASE_PATH) as db:
            request, settings, result = db.execute('SELECT request,settings,result FROM study_chat_requests').fetchone()
            self.assertNotIn(self.secret, request+settings+result)
            self.assertEqual(json.loads(request), REQUEST)
            self.assertEqual(db.execute('SELECT count(*) FROM study_chat_budget').fetchone()[0], 1)

    def test_partial_is_saved_before_emission_and_cancel_is_unknown_without_resend(self):
        calls, closed = [], []
        def provider(*_args):
            calls.append(True)
            try:
                yield {'type':'delta','text':'partial 中文'}
                yield DONE
            finally:
                closed.append(True)
        with mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=provider):
            stream = self.chat()
            self.assertEqual(next(stream), {'type':'delta','text':'partial 中文'})
            with database(server.LOCAL_DATABASE_PATH) as db:
                self.assertEqual(db.execute('SELECT text FROM study_chat_requests').fetchone()[0], 'partial 中文')
            stream.close()
            retried = copy.deepcopy(REQUEST)
            retried['requestId'] = 'another-id'
            expected = [{'type':'delta','text':'partial 中文'}, {'type':'error','error':'ai-request-indeterminate'}]
            self.assertEqual(list(self.chat()), expected)
            self.assertEqual(list(self.chat(retried)), expected)
        self.assertEqual((calls, closed), ([True], [True]))

    def test_same_id_different_input_is_rejected_without_second_send(self):
        with mock.patch.object(server.study_ai_provider, 'stream_chat', return_value=iter([DONE])) as provider:
            list(self.chat())
            changed = copy.deepcopy(REQUEST)
            changed['messages'][0]['content'] = 'different'
            with self.assertRaisesRegex(ValueError, 'ai-request-conflict'):
                self.chat(changed)
            self.assertEqual(provider.call_count, 1)

    def test_storage_failure_before_preflight_prevents_provider_dispatch(self):
        with mock.patch.object(LocalChatLedger, 'begin', side_effect=OSError('synthetic-save-failure')), \
                mock.patch.object(server.study_ai_provider, 'stream_chat') as provider:
            with self.assertRaises(CompanionFailure) as blocked:
                self.chat()
            self.assertEqual(blocked.exception.payload, {'error':'ai-chat-storage-unavailable'})
            provider.assert_not_called()

    def test_final_receipt_failure_preserves_partial_and_never_emits_done(self):
        with mock.patch.object(server.study_ai_provider, 'stream_chat', return_value=iter([
                {'type':'delta','text':'saved text'}, DONE])) as provider:
            stream = self.chat()
            self.assertEqual(next(stream)['text'], 'saved text')
            with mock.patch.object(LocalChatLedger, 'complete', side_effect=OSError('synthetic-commit-failure')):
                with self.assertRaises(OSError):
                    next(stream)
            reply = list(self.chat())
            self.assertEqual(reply[-1], {'type':'error','error':'ai-request-indeterminate'})
            self.assertFalse(any(event['type']=='done' for event in reply))
            self.assertEqual(provider.call_count, 1)

    def test_missing_final_marker_keeps_unknown(self):
        with mock.patch.object(server.study_ai_provider, 'stream_chat', return_value=iter([
                {'type':'delta','text':'incomplete'}])) as provider:
            with self.assertRaisesRegex(ValueError, 'ai-stream-incomplete'):
                list(self.chat())
            self.assertEqual(list(self.chat())[-1]['error'], 'ai-request-indeterminate')
            self.assertEqual(provider.call_count, 1)

    def test_authority_change_before_dispatch_releases_unspent_reservation(self):
        allowed = [True]
        def guard():
            if not allowed[0]:
                raise CompanionFailure(401, {'error':'ai-chat-authority-changed'})
        app = create_ai_application(self.services, authorize=guard)
        with mock.patch.object(server.study_ai_provider, 'stream_chat') as provider:
            stream = self.chat(app=app)
            allowed[0] = False
            with self.assertRaises(CompanionFailure):
                next(stream)
            provider.assert_not_called()
        with database(server.LOCAL_DATABASE_PATH) as db:
            self.assertEqual(db.execute('SELECT reserved FROM study_chat_budget').fetchone()[0], 0)

    def test_library_change_after_provider_delta_does_not_emit_or_save_it(self):
        def provider(*_args):
            server.CONFIG['learning_vault_root'] = str(self.root.parent/'other-library')
            yield {'type':'delta','text':'must-not-leak'}
        with mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=provider):
            with self.assertRaises(CompanionFailure):
                next(self.chat())
        with database(server.LOCAL_DATABASE_PATH) as db:
            self.assertEqual(db.execute('SELECT text,state FROM study_chat_requests').fetchone(), ('','unknown'))

    def test_old_request_without_id_has_stable_compatibility_identity(self):
        request = copy.deepcopy(REQUEST)
        request.pop('requestId')
        with mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=lambda *_args:iter([DONE])) as provider:
            self.assertEqual(list(self.chat(request)), list(self.chat(request)))
            self.assertEqual(provider.call_count, 1)

    def test_compatibility_identity_does_not_change_old_request_size_validation(self):
        request = copy.deepcopy(REQUEST)
        request.pop('requestId')
        request['context']['question'] = ''
        request['context']['question'] = 'x'*(50000-len(json.dumps(request)))
        self.assertEqual(len(json.dumps(request)), 50000)
        selected = {**SETTINGS,'dailyTokenLimit':1000000}
        server.study_ai_provider.chat_body(selected, request)
        def provider(settings, _key, sent):
            self.assertNotIn('requestId', sent)
            server.study_ai_provider.chat_body(settings, sent)
            yield DONE
        with mock.patch.object(self.store, 'snapshot', return_value=(selected,self.secret)), \
                mock.patch.object(server.study_ai_provider, 'stream_chat', side_effect=provider):
            self.assertEqual(list(self.chat(request)), [DONE])


class LocalChatBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root/'synthetic.sqlite'
        self.now = [1000]
        self.ledger = LocalChatLedger(self.path, 'owner', 'library', self.root, lambda:self.now[0])

    def test_stale_preflight_is_unsent_and_old_generation_cannot_dispatch(self):
        old = self.ledger.begin(REQUEST, SETTINGS)
        self.now[0] += 121
        new = self.ledger.begin(REQUEST, SETTINGS)
        self.assertGreater(new['generation'], old['generation'])
        with self.ledger.execution(old):
            with self.assertRaisesRegex(ValueError, 'ai-request-conflict'):
                self.ledger.dispatch(old)
        with self.ledger.execution(new):
            self.ledger.dispatch(new)
        with database(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM study_chat_budget WHERE reserved>0').fetchone()[0], 1)

    def test_simultaneous_same_request_has_one_reservation(self):
        gate = threading.Barrier(2)
        def call():
            gate.wait(3)
            return self.ledger.begin(REQUEST, SETTINGS)['kind']
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(call) for _ in range(2)]
            self.assertEqual(sorted(f.result(5) for f in futures), ['start','wait'])
        with database(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM study_chat_budget').fetchone()[0], 1)

    def test_still_running_chat_keeps_concurrency_after_preflight_age(self):
        ticket = self.ledger.begin(REQUEST, SETTINGS)
        with self.ledger.execution(ticket):
            self.ledger.dispatch(ticket)
            self.now[0] += 121
            changed = copy.deepcopy(REQUEST)
            changed['requestId'] = 'different-chat'
            changed['messages'][0]['content'] = 'another question'
            with self.assertRaisesRegex(ValueError, 'account-ai-concurrency-limit'):
                self.ledger.begin(changed, SETTINGS)

    def test_chat_reservation_blocks_code_and_code_reservation_blocks_chat(self):
        self.ledger.begin(REQUEST, SETTINGS)
        code = CodeReviewLedger(self.path, 'owner', 'library', self.root, lambda:self.now[0])
        binding = {'ownerId':'owner','libraryId':'library'}
        data = {'attemptId':'code-attempt','binding':binding,'sourceBinding':binding,'code':'synthetic'}
        ticket = code.begin('code-request', data, SETTINGS)
        with self.assertRaisesRegex(ValueError, 'code-review-concurrent-budget'):
            code.reserve(ticket)
        with database(self.path) as db:
            db.execute("DELETE FROM study_chat_budget")
            db.execute("DELETE FROM study_chat_requests")
        code.reserve(ticket)
        with self.assertRaisesRegex(ValueError, 'account-ai-concurrency-limit'):
            self.ledger.begin(REQUEST, SETTINGS)

    def test_daily_budget_is_shared_across_libraries_but_separate_by_owner(self):
        selected = {**SETTINGS,'dailyRequestLimit':1}
        self.ledger.begin(REQUEST, selected)
        other_library = LocalChatLedger(self.path, 'owner', 'another-library', self.root, lambda:self.now[0])
        with self.assertRaisesRegex(ValueError, 'account-ai-daily-limit'):
            other_library.begin(REQUEST, selected)
        other_owner = LocalChatLedger(self.path, 'another-owner', 'library', self.root, lambda:self.now[0])
        self.assertEqual(other_owner.begin(REQUEST, selected)['kind'], 'start')

    def test_done_replay_has_no_new_reservation_and_partial_corruption_blocks(self):
        ticket = self.ledger.begin(REQUEST, SETTINGS)
        with self.ledger.execution(ticket):
            self.ledger.dispatch(ticket)
            self.ledger.append(ticket, 'kept')
            self.ledger.complete(ticket, DONE)
        self.assertEqual(self.ledger.lookup(REQUEST)['kind'], 'done')
        self.ledger.abandon(ticket)
        with database(self.path) as db:
            self.assertEqual(db.execute('SELECT state FROM study_chat_requests').fetchone()[0], 'done')
            self.assertEqual(db.execute('SELECT count(*) FROM study_chat_budget').fetchone()[0], 1)
            db.execute("UPDATE study_chat_requests SET text='tampered'")
        with self.assertRaisesRegex(ValueError, 'ai-chat-integrity'):
            self.ledger.lookup(REQUEST)


if __name__ == '__main__':
    unittest.main()
