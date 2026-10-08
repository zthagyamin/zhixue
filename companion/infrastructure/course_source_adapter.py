"""Bind the authenticated owner and configured vault to immutable native captures."""
from __future__ import annotations

from application.course_sources import CourseSourceApplication, CourseSourcePorts
from infrastructure.course_source_capture import NativeCourseSources


def create_course_source_application(services, owner: str) -> CourseSourceApplication:
    root = services.source_path('learning_vault_root')
    sources = NativeCourseSources(root, owner, services.effective_gateway, services.LOCAL_DATABASE_PATH)
    return CourseSourceApplication(CourseSourcePorts(
        library_id=lambda: services.local_vault_library_id(services.source_path('learning_vault_root')),
        capture=sources.capture,
        read=sources.read,
    ))
