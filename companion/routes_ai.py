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
    self.send_json(200, create_ai_application(services).generate(payload))


def post_ai_settings(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    app = create_ai_application(services)
    try:
        result = app.configured(hashed_user, request_path.rsplit('/', 1)[1], payload)
    except CompanionFailure as error:
        self.send_json(error.status, error.payload)
        return
    if not isinstance(result, LocalChat):
        self.send_json(200, result)
        return
    self.send_response(200)
    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    self.send_header('Cache-Control', 'no-store')
    self.send_header('Connection', 'close')
    self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin'))
    self.send_header('Vary', 'Origin')
    self.end_headers()
    self.close_connection = True
    try:
        for event in result.events:
            self.wfile.write(('data: '+json.dumps(event, ensure_ascii=False)+'\n\n').encode('utf-8'))
            self.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    except Exception as error:
        try:
            self.wfile.write(('data: '+json.dumps({'type': 'error', 'error': app.ports.failure_code(error)})+'\n\n').encode('utf-8'))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
    finally:
        close = getattr(result.events, 'close', None)
        if close:
            close()


def post_settings_deepseek(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_ai_application(services).save_legacy(hashed_user, payload))
