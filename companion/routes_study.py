"""Authorized HTTP adapters; study policy lives in application.study."""
from __future__ import annotations
from typing import Any
from route_services import RouteServices
from application.study import StudyEventConflict
from infrastructure.study_adapter import create_study_application


def get_study_data(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).read(hashed_user))


def get_dashboard_today(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).dashboard(hashed_user))


def get_diagnostics(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    self.send_json(200, create_study_application(services).diagnostics(hashed_user))


def get_practice(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    if not services.allowed_origin(self.headers.get('Origin')):
        self.send_json(403, {'message': '该网页来源未被本地同步助手授权。'})
        return
    self.send_json(200, create_study_application(services).practice(hashed_user))


def post_activity(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    try:
        result = create_study_application(services).activity(hashed_user, payload)
    except StudyEventConflict as error:
        self.send_json(409, {'status': 'conflict', 'eventId': error.event_id})
        return
    self.send_json(200, result)


def post_assistance(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).assistance(hashed_user, payload))


def post_refresh(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).refresh(hashed_user))


def post_practice_grade(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).grade(payload))


def post_practice_variant(self, services: RouteServices, request_path: str, hashed_user: str, payload: Any = None) -> None:
    self.send_json(200, create_study_application(services).variant(payload))
