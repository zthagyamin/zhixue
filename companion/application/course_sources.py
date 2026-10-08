"""Authenticated native course source intent, separate from scores and HTTP."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class CourseSourcePorts:
    library_id: Callable[[], str]
    capture: Callable[[dict], dict]
    read: Callable[[dict, str], dict]


class CourseSourceApplication:
    def __init__(self, ports: CourseSourcePorts):
        self.ports = ports

    def execute(self, action: str, payload: Any) -> dict:
        if action not in ('capture', 'read'):
            raise ValueError('unsupported-course-source-action')
        required = {'schemaVersion', 'identity'} | ({'captureId'} if action == 'read' else set())
        if (type(payload) is not dict or set(payload) != required
                or type(payload['schemaVersion']) is not int or payload['schemaVersion'] != 1):
            raise ValueError('invalid-course-source-request')
        identity = payload['identity']
        if type(identity) is not dict or identity.get('libraryId') != self.ports.library_id():
            raise ValueError('course-source-library-changed')
        if action == 'read':
            capture_id = payload['captureId']
            if type(capture_id) is not str:
                raise ValueError('invalid-course-capture-id')
            value = self.ports.read(identity, capture_id)
        else:
            value = self.ports.capture(identity)
        # A configured root switch cannot turn an old-root read into a new library receipt.
        if identity.get('libraryId') != self.ports.library_id():
            raise ValueError('course-source-library-changed')
        return {'schemaVersion': 1, 'durable': True, 'capture': value}
