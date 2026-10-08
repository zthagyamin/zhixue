"""Plan HTTP adapters; state transitions and storage order belong to application.planning."""
from __future__ import annotations
from typing import Any
from urllib.parse import parse_qs, urlsplit
from route_services import RouteServices
from application.failures import CompanionFailure
from infrastructure.planning_adapter import create_planning_application


def _run(self, services, operation):
    try:
        self.send_json(200, operation(create_planning_application(services)))
    except CompanionFailure as error:
        self.send_json(error.status, error.payload)


def get_tasks_events(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    _run(self, services, lambda app: app.task_events(hashed_user, lambda: parse_qs(urlsplit(self.path).query)))


def get_plan_evidence(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    _run(self, services, lambda app: app.evidence(hashed_user, lambda: parse_qs(urlsplit(self.path).query)))


def get_plan_context(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    _run(self, services, lambda app: app.context(hashed_user))


def get_plan_current(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    _run(self, services, lambda app: app.current())


def get_constraints(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    _run(self, services, lambda app: app.constraints(hashed_user))


def post_tasks_events(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.append_task(hashed_user, payload))


def post_plan_suggest(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.suggest(hashed_user, payload))


def post_plan_ai_reorder(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.reorder(payload))


def post_plan_apply(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.apply(hashed_user, payload))


def post_plan_reject(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.reject(hashed_user, payload))


def post_plan_restore(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.restore(hashed_user, payload))


def post_constraints(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    _run(self, services, lambda app: app.write_constraints(hashed_user, payload))
