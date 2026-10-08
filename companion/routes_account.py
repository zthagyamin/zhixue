"""Account routes. Called only after the HTTP boundary authorizes the request."""
from __future__ import annotations

from route_services import RouteServices
from typing import Any
import account_sync_local_api


def get_account_sync_status(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    status, body = account_sync_local_api.dispatch(services.get_account_sync_service, 'GET', request_path, hashed_user,
        self.headers.get('Origin'), services.CONFIG.get('allowed_origins', []))
    self.send_json(status, body)
    return


def post_account_sync(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    status, body = account_sync_local_api.dispatch(services.get_account_sync_service, 'POST', request_path, hashed_user,
        self.headers.get('Origin'), services.CONFIG.get('allowed_origins', []), payload)
    self.send_json(status, body)
    return


def post_session_revoke(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    revoked = services.revoke_session(self.headers.get("X-Study-Loop-Session"))
    self.send_json(200, {"revoked": revoked})
    return
