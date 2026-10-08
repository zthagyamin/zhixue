"""Source HTTP adapters. No database operations or source policy in these handlers."""
from __future__ import annotations
from typing import Any
from urllib.parse import parse_qs, urlsplit
from route_services import RouteServices
from application.failures import CompanionFailure
from infrastructure.source_adapter import create_source_application


def _origin(self, services):
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return False
    return True


def _run(self, services, operation, passthrough=False):
    try:
        result = operation(create_source_application(services))
        self.send_json(*result) if passthrough else self.send_json(200, result)
    except CompanionFailure as error:
        self.send_json(error.status, error.payload)


def get_note_sources(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    if hashed_user != services.installation_owner_hash():
        self.send_json(403, {'message': '请切回此安装已配对的账号，或使用独立安装。'})
        return
    if request_path == '/v1/note-sources':
        _run(self, services, lambda app: app.read_notes(hashed_user), passthrough=True)
    else:
        _run(self, services, lambda app: app.workspace_status())


def post_note_sources(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if hashed_user != services.installation_owner_hash():
        self.send_json(403, {'message': '请切回此安装已配对的账号，或使用独立安装。'})
        return
    if request_path == '/v1/note-sources':
        _run(self, services, lambda app: app.write_notes(hashed_user, payload), passthrough=True)
    else:
        _run(self, services, lambda app: app.configure_workspace(payload))


def get_papers(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.papers(hashed_user, 'catalog', read_query=lambda: parse_qs(urlsplit(self.path).query)))


def get_vocabulary_target(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.vocabulary(hashed_user, read_query=lambda: parse_qs(urlsplit(self.path).query)))


def get_vault_mapping(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.mapping(hashed_user))


def get_changes(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.changes(hashed_user))


def get_capture(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.capture_list())


def get_audit(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not _origin(self, services):
        return
    _run(self, services, lambda app: app.audit())


def post_papers_read(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.papers(hashed_user, request_path.rsplit('/', 1)[1], payload))


def post_vocabulary_append(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.vocabulary(hashed_user, payload=payload))


def post_vault_mapping(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.mapping(hashed_user, payload, write=True))


def post_changes_scan(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.scan())


def post_changes_decide(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.decide(hashed_user, payload))


def post_events_archive(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.archive(payload))


def post_sources_init(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.initialize())


def post_capture(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.capture(payload))
