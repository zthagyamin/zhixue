"""AI HTTP response adapters, including explicit SSE stream cleanup."""
from __future__ import annotations
from typing import Any
import json
from route_services import RouteServices
from application.ai import LocalChat
from application.failures import CompanionFailure
from infrastructure.ai_adapter import create_ai_application


def post_hint(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_ai_application(services).hint(payload))


def post_correct_card(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_ai_application(services).correct(payload))


def post_generate(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    def authorize():
        if (not services.allowed_origin(self.headers.get('Origin')) or
                services.authenticate_session(self.headers.get('X-Study-Loop-Session')) != hashed_user):
            raise CompanionFailure(401, {'error': 'ai-generation-authority-changed', 'message': '会话已变更，请重新配对。'})

    try:
        result = create_ai_application(services, authorize=authorize).generate(payload)
    except CompanionFailure as error:
        self.send_json(error.status, error.payload)
        return
    self.send_json(200, result)


def post_ai_settings(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    def authorize():
        if (not services.allowed_origin(self.headers.get('Origin')) or
                services.authenticate_session(self.headers.get('X-Study-Loop-Session')) != hashed_user):
            raise CompanionFailure(401, {'error': 'ai-chat-authority-changed'})
    app = create_ai_application(services, authorize=authorize)
    try:
        result = app.configured(hashed_user, request_path.rsplit('/', 1)[1], payload)
    except CompanionFailure as error:
        self.send_json(error.status, error.payload)
        return
    if not isinstance(result, LocalChat):
        self.send_json(200, result)
        return
    previous_timeout = None
    timeout_observed = False
    result_closed = False
    try:
        origin = services.allowed_origin(self.headers.get('Origin'))
        if not origin:
            if result.cancel_prepared:
                result.cancel_prepared()
            close = getattr(result.events, 'close', None)
            if close:
                close()
            result_closed = True
            self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
            return
        self.close_connection = True
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.end_headers()
        if result.remaining:
            previous_timeout = self.connection.gettimeout()
            timeout_observed = True
        for event in result.events:
            if result.remaining:
                self.connection.settimeout(min(10,result.remaining()))
            self.wfile.write(('data: '+json.dumps(event, ensure_ascii=False)+'\n\n').encode('utf-8'))
            self.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    except Exception as error:
        try:
            if result.remaining:
                # A final status has a separate bounded write after execution stops.
                self.connection.settimeout(1)
            self.wfile.write(('data: '+json.dumps({'type': 'error', 'error': app.ports.failure_code(error)})+'\n\n').encode('utf-8'))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
    finally:
        try:
            if not result_closed and result.cancel_prepared:
                result.cancel_prepared()
        finally:
            if not result_closed:
                close = getattr(result.events, 'close', None)
                if close:
                    close()
            if timeout_observed:
                self.connection.settimeout(previous_timeout)


def post_settings_deepseek(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_ai_application(services).save_legacy(hashed_user, payload))
