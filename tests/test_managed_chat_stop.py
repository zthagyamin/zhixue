"""Terminal pipe cleanup must not weaken owned-process exit verification."""
import errno
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from infrastructure.managed_chat import ManagedChatExecutor


class ManagedChatStopTests(unittest.TestCase):
    def executor(self):
        ledger = SimpleNamespace(path=Path(tempfile.gettempdir()) / 'synthetic-stop.sqlite', scope=('owner', 'library'))
        return ManagedChatExecutor(ledger, {'requestId': 'synthetic-request'}, {}, 'synthetic-key', {})

    def process(self, error=None):
        return SimpleNamespace(poll=mock.Mock(return_value=0), wait=mock.Mock(return_value=0),
                               kill=mock.Mock(), stdin=SimpleNamespace(close=mock.Mock(side_effect=error)),
                               stdout=SimpleNamespace(close=mock.Mock()))

    def test_terminal_broken_pipe_cleanup_keeps_verified_stop(self):
        for code in (errno.EPIPE, errno.EINVAL):
            with self.subTest(errno=code):
                worker = self.executor()
                worker.process = self.process(OSError(code, 'synthetic terminal pipe'))
                worker.stop()
                self.assertTrue(worker.stopped)
                self.assertTrue(worker._closed.is_set())
                worker.process.stdout.close.assert_called_once()
                worker.process.kill.assert_not_called()
                worker.stop()
                worker.process.stdin.close.assert_called_once()

    def test_unrelated_pipe_failure_is_not_suppressed(self):
        worker = self.executor()
        worker.process = self.process(OSError(errno.EIO, 'synthetic unrelated failure'))
        with self.assertRaises(OSError) as caught:
            worker.stop()
        self.assertEqual(caught.exception.errno, errno.EIO)
        worker.process.stdout.close.assert_called_once()

    def test_unconfirmed_child_exit_never_reports_stopped(self):
        worker = self.executor()
        worker.process = self.process()
        worker.process.poll.return_value = None
        worker.process.wait.side_effect = subprocess.TimeoutExpired('synthetic', 5)
        with self.assertRaisesRegex(ValueError, 'ai-chat-execution-unverified'):
            worker.stop()
        self.assertFalse(worker.stopped)
        self.assertFalse(worker._closed.is_set())
        worker.process.stdin.close.assert_not_called()

    def test_real_worker_stop_terminates_lock_owner_before_long_watchdog(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = SimpleNamespace(path=Path(root) / 'synthetic.sqlite',
                                     scope=('owner', 'library', root))
            worker = ManagedChatExecutor(ledger, {'requestId': 'synthetic-request'},
                                         {}, 'synthetic-key', {}, seconds=120)
            receive = worker._receive
            frames = []
            def record_ready():
                frame = receive()
                frames.append(frame)
                return frame
            try:
                # Acquire holds the real worker's lock without sending start;
                # no provider or network call can run in this regression.
                with mock.patch.object(worker, '_receive', side_effect=record_ready):
                    self.assertTrue(worker.acquire())
                self.assertEqual(set(frames[0]), {'type', 'device', 'inode', 'pid'})
                self.assertEqual(frames[0]['pid'], worker.process.pid)
                self.assertIsNone(worker.process.poll())
            finally:
                started = time.monotonic()
                worker.stop()
            self.assertLess(time.monotonic() - started, 4)
            self.assertTrue(worker.stopped)
            self.assertIsNotNone(worker.process.poll())
            try:
                self.assertTrue(worker.witness.acquire(create=False),
                                'Stopped worker must release its actual OS execution lock')
            finally:
                worker.witness.close()

    def test_real_worker_ready_pid_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = SimpleNamespace(path=Path(root) / 'synthetic.sqlite',
                                     scope=('owner', 'library', root))
            worker = ManagedChatExecutor(ledger, {'requestId': 'synthetic-request'},
                                         {}, 'synthetic-key', {}, seconds=120)
            receive = worker._receive
            def mismatched_ready():
                return {**receive(), 'pid': worker.process.pid + 1}
            try:
                with mock.patch.object(worker, '_receive', side_effect=mismatched_ready):
                    with self.assertRaisesRegex(ValueError, 'ai-chat-execution-unverified'):
                        worker.acquire()
                self.assertFalse(worker.ready)
                self.assertTrue(worker.stopped)
                self.assertIsNotNone(worker.process.poll())
                self.assertTrue(worker.witness.acquire(create=False))
            finally:
                worker.stop()
                worker.witness.close()
