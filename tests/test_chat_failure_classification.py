"""Provider error categories survive the owned worker and preserve pending data."""
import copy
import errno
import http.client
import json
import os
import socket
import sqlite3
import struct
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import study_ai_provider
from application.local_chat import execute_chat
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.managed_chat import ManagedChatExecutor

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/local-chat-recovery-v1.json').read_text(encoding='utf-8'))


class ChatFailureClassificationTests(unittest.TestCase):
    def test_specific_stream_codes_survive_each_error_boundary(self):
        for code in ('ai-stream-incomplete', 'ai-stream-limit'):
            with self.subTest(code=code):
                self.assertEqual(study_ai_provider.failure_code(ValueError(code)), code)
                self.assertEqual(study_ai_provider.failure_code(ValueError(
                    study_ai_provider.failure_code(ValueError(code)))), code)

    def test_native_connection_failures_are_network_failures(self):
        for kind, number in ((ConnectionAbortedError, errno.ECONNABORTED),
                             (ConnectionResetError, errno.ECONNRESET),
                             (BrokenPipeError, errno.EPIPE)):
            with self.subTest(kind=kind.__name__):
                self.assertEqual(study_ai_provider.failure_code(kind(number, 'synthetic-private-detail')),
                                 'ai-provider-network')

    def test_truncated_http_response_is_incomplete_without_exposing_body(self):
        error = http.client.IncompleteRead(b'synthetic-private-partial', 100)
        self.assertEqual(study_ai_provider.failure_code(error), 'ai-stream-incomplete')

    def test_timeout_and_unrelated_errors_keep_their_distinct_categories(self):
        self.assertEqual(study_ai_provider.failure_code(TimeoutError('synthetic')), 'ai-provider-timeout')
        for error in (PermissionError(errno.EACCES, 'synthetic-file'),
                      ValueError('synthetic-private-detail'),
                      OSError(errno.EIO, 'synthetic-storage')):
            with self.subTest(kind=type(error).__name__):
                self.assertEqual(study_ai_provider.failure_code(error), 'ai-provider-error')

    def run_incomplete_worker(self, *, chunked=False, reset_after_partial=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        calls = []
        reset = threading.Event()
        reset_attempted = threading.Event()
        reset_finished = threading.Event()
        reset_errors = []
        delta = b'data: {"choices":[{"delta":{"content":"saved partial"}}]}\n\n'

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Connection', 'close')
                if chunked:
                    self.send_header('Transfer-Encoding', 'chunked')
                elif not reset_after_partial:
                    self.send_header('Content-Length', str(len(delta)))
                self.end_headers()
                if chunked:
                    # A declared chunk with missing bytes is a real HTTP truncation.
                    self.wfile.write(b'100\r\n' + delta)
                else:
                    self.wfile.write(delta)
                self.wfile.flush()
                if reset_after_partial:
                    if not reset.wait(5):
                        reset_errors.append('reset-trigger-not-received')
                        return
                    reset_attempted.set()
                    try:
                        linger = struct.pack('HH' if os.name == 'nt' else 'ii', 1, 0)
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
                        self.connection.close()
                    except Exception as error:
                        reset_errors.append(type(error).__name__)
                    finally:
                        reset_finished.set()

        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        request = copy.deepcopy(FIXTURE['request'])
        settings = {**FIXTURE['settings'], 'baseUrl': f'http://127.0.0.1:{httpd.server_port}/v1'}
        ledger = LocalChatLedger(root / 'synthetic.sqlite', 'owner', 'library', root)
        ticket = ledger.begin(request, settings)
        worker = ManagedChatExecutor(ledger, ticket, settings, 'synthetic-key', request, seconds=10)
        self.addCleanup(worker.close)
        self.addCleanup(reset.set)
        stream = execute_chat(ledger, ticket, worker.events, lambda: None, executor=worker).events
        if not chunked:
            self.assertEqual(next(stream), {'type': 'delta', 'text': 'saved partial'})
        if reset_after_partial:
            with closing(sqlite3.connect(ledger.path)) as db:
                self.assertEqual(db.execute('SELECT state,text FROM study_chat_requests').fetchone(),
                                 ('dispatched', 'saved partial'))
            reset.set()
        # Windows may report a connection reset before a short response reaches
        # clean EOF. Both classifications must remain specific and pending.
        expected = '^(ai-stream-incomplete|ai-provider-network)$' if chunked or reset_after_partial else '^ai-stream-incomplete$'
        with self.assertRaisesRegex(ValueError, expected):
            list(stream)
        if reset_after_partial:
            self.assertTrue(reset_finished.wait(2), 'Controlled reset path did not finish')
            self.assertTrue(reset_attempted.is_set())
            self.assertEqual(reset_errors, [])
        self.assertIsNotNone(worker.process.poll())
        with closing(sqlite3.connect(ledger.path)) as db:
            state, text, result = db.execute('SELECT state,text,result FROM study_chat_requests').fetchone()
            self.assertEqual(state, 'unknown')
            self.assertIsNone(result)
            if not chunked:
                self.assertEqual(text, 'saved partial')
            self.assertEqual(db.execute('SELECT state FROM study_chat_budget').fetchone()[0], 'unknown')
        self.assertEqual(ledger.begin(request, settings)['kind'], 'unknown')
        self.assertEqual(len(calls), 1)

    def test_owned_worker_preserves_partial_on_missing_final_marker(self):
        self.run_incomplete_worker()

    def test_owned_worker_keeps_truncated_http_transport_specific_and_pending(self):
        self.run_incomplete_worker(chunked=True)

    def test_actual_socket_reset_preserves_confirmed_partial_without_reissuing(self):
        self.run_incomplete_worker(reset_after_partial=True)


if __name__ == '__main__':
    unittest.main()
