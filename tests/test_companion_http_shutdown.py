"""Bounded transport close, using synthetic sockets and actual loopback HTTP."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from infrastructure.http_server import CompanionHTTPServer
import infrastructure.http_server as transport


class SyntheticSocket:
    def __init__(self, chunks=(), error=None):
        self.chunks = iter(chunks)
        self.error = error
        self.received = 0
        self.timeouts = []
        self.closed = 0
        self.shutdowns = []

    def shutdown(self, direction):
        self.shutdowns.append(direction)

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def recv(self, size):
        if self.error:
            raise self.error
        chunk = next(self.chunks, b'')
        self.received += len(chunk)
        return chunk

    def close(self):
        self.closed += 1


class CompanionHTTPShutdownTests(unittest.TestCase):
    def close(self, socket):
        server = CompanionHTTPServer.__new__(CompanionHTTPServer)
        server.shutdown_request(socket)

    def test_response_is_half_closed_before_discarding_unread_small_body(self):
        request = SyntheticSocket([b'{}', b''])
        self.close(request)
        self.assertEqual(request.received, 2)
        self.assertEqual(request.closed, 1)
        self.assertEqual(len(request.shutdowns), 1)
        self.assertTrue(request.timeouts)
        self.assertTrue(all(0 < value <= 0.05 for value in request.timeouts))

    def test_unlimited_peer_is_bounded_by_64k_without_parsing_or_dispatch(self):
        request = SyntheticSocket([b'x' * 8192] * 100)
        self.close(request)
        self.assertEqual(request.received, 64 * 1024)
        self.assertEqual(request.closed, 1)

    def test_stalled_peer_timeout_still_closes(self):
        request = SyntheticSocket(error=TimeoutError('synthetic-timeout'))
        self.close(request)
        self.assertTrue(request.timeouts)
        self.assertEqual(request.closed, 1)

    def test_total_deadline_is_not_restarted_by_each_chunk(self):
        request = SyntheticSocket([b'{}'] * 100)
        with mock.patch.object(transport.time, 'monotonic', side_effect=[0, 0.04, 0.06]):
            self.close(request)
        self.assertEqual(request.received, 2)
        self.assertEqual(request.closed, 1)


if __name__ == '__main__':
    unittest.main()
