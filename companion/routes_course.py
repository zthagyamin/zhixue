"""Native course source routes; pairing and Origin checks remain in the HTTP boundary."""
from __future__ import annotations

from typing import Any
import re
from route_services import RouteServices
from infrastructure.course_source_adapter import create_course_source_application
from infrastructure.course_grade_adapter import create_native_course_application


def post_course_source(self, services: RouteServices, request_path: str, hashed_user: str,
                       payload: Any = None) -> None:
    action = request_path.rsplit('/', 1)[1]
    try:
        result = create_course_source_application(services, hashed_user).execute(action, payload)
    except ValueError as error:
        code = str(error)
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,100}', code):
            code = 'course-source-unavailable'
        self.send_json(409 if code.startswith(('native-course-', 'course-source-')) else 400,
                       {'error': code})
        return
    except Exception:
        # Source/database failures may contain private paths; do not send them to a page.
        self.send_json(503, {'error': 'course-source-storage-unavailable'})
        return
    self.send_json(200, result)


def post_course_grade(self, services: RouteServices, request_path: str, hashed_user: str,
                      payload: Any = None) -> None:
    try:
        app = create_native_course_application(services, hashed_user)
        result = app.claim(payload) if request_path.endswith('/claim') else app.grade(payload)
    except ValueError as error:
        code = str(error)
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,100}', code):
            code = 'native-course-unavailable'
        self.send_json(409 if code.startswith('native-course-') else 400, {'error': code})
        return
    except Exception:
        self.send_json(503, {'error': 'native-course-storage-unavailable'})
        return
    self.send_json(200, result)
