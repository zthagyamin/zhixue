"""Selected-provider transport and bounded retry, with no server/config import."""
from __future__ import annotations
import json
import http.client
import socket
import time
import urllib.request
import urllib.error
import study_ai_provider

MAX_RESPONSE_BYTES = 100000

class BoundedProviderResponse:
    """Bound cumulative reads; retain existing response bytes and context lifetime."""
    def __init__(self,response,maximum=MAX_RESPONSE_BYTES):
        self.response,self.maximum,self.consumed=response,maximum,0

    def _size(self,size):
        if size is None: size=-1
        if type(size) is not int or size < -1: raise ValueError('invalid-provider-read-size')
        remaining=self.maximum-self.consumed
        return remaining+1 if size<0 else min(size,remaining+1)

    def _consume(self,raw):
        if type(raw) is not bytes:
            self.close();raise RuntimeError('ai-provider-invalid-response')
        self.consumed+=len(raw)
        if self.consumed>self.maximum:
            self.close();raise RuntimeError('ai-provider-output-limit')
        return raw

    def read(self,size=-1):
        bounded=self._size(size)
        expected=self.response.length if isinstance(self.response,http.client.HTTPResponse) else None
        raw=self.response.read(bounded)
        if expected is not None and len(raw)<min(expected,bounded):
            self.close();raise http.client.IncompleteRead(raw,min(expected,bounded)-len(raw))
        return self._consume(raw)
    def readline(self,size=-1):return self._consume(self.response.readline(self._size(size)))
    def close(self):self.response.close()
    def __enter__(self):return self
    def __exit__(self,*args):self.close();return False
    def __iter__(self):return self
    def __next__(self):
        line=self.readline()
        if not line:raise StopIteration
        return line


class LegacyProviderTransport:
    def __init__(self, *, settings, key, attempts, delay, unavailable):
        self.settings = settings
        self.key = key
        self.attempts = attempts
        self.delay = delay
        self.unavailable = unavailable

    def open(self, request: urllib.request.Request, timeout: float):
        """Compatibility entrypoint: normalize every study helper through the selected provider."""
        with study_ai_provider.SETTINGS_LOCK:
            settings = self.settings()
            normalized = study_ai_provider.build_request(settings, self.key(), json.loads(request.data or b'{}'))
        last_error: BaseException | None = None
        for attempt in range(self.attempts):
            try:
                return BoundedProviderResponse(study_ai_provider.open_request(normalized, timeout=timeout))
            except urllib.error.HTTPError:
                # Provider responses (including auth/model errors) are actionable
                # and must keep their status code/body handling at the call site.
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as error:
                last_error = error
                # Only DNS failure is known to precede a connection. A timeout,
                # reset or generic I/O error may occur after a paid POST arrived.
                before_connection = isinstance(error,urllib.error.URLError) and isinstance(error.reason,socket.gaierror)
                if before_connection and attempt + 1 < self.attempts:
                    time.sleep(self.delay)
                else:
                    break
        raise self.unavailable(
            "当前 AI API 暂时无法访问（网络连接被重置或代理拦截）。"
            " Companion 仍然在线，请检查网络后点击“立即同步”。"
        ) from last_error
