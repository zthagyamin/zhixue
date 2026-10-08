"""Selected-provider transport and bounded retry, with no server/config import."""
from __future__ import annotations
import json
import time
import urllib.request
import urllib.error
import study_ai_provider


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
                return study_ai_provider.open_request(normalized, timeout=timeout)
            except urllib.error.HTTPError:
                # Provider responses (including auth/model errors) are actionable
                # and must keep their status code/body handling at the call site.
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as error:
                last_error = error
                if attempt + 1 < self.attempts:
                    time.sleep(self.delay)
        raise self.unavailable(
            "当前 AI API 暂时无法访问（网络连接被重置或代理拦截）。"
            " Companion 仍然在线，请检查网络后点击“立即同步”。"
        ) from last_error
