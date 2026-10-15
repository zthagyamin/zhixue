"""Loopback HTTP transport; business authorization remains in the handler."""
from http.server import ThreadingHTTPServer
import socket
import time


class CompanionHTTPServer(ThreadingHTTPServer):
    def shutdown_request(self, request):
        """Finish the response before a bounded discard of unread request bytes.

        Closing with unread TCP input can abort an already-sent rejection on
        Windows. This runs after the handler; bytes are never parsed or routed.
        A stalled or unlimited peer gets at most 50ms and 64KiB of discard.
        """
        try:
            request.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + 0.05
            remaining = 64 * 1024
            while remaining:
                wait = deadline - time.monotonic()
                if wait <= 0:
                    break
                request.settimeout(min(wait, 0.05))
                chunk = request.recv(min(8192, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            # EOF, timeout and disconnect all end transport cleanup.
            pass
        finally:
            self.close_request(request)
