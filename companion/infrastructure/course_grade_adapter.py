"""Compose authenticated native source, settings, ledger and model ports."""
from __future__ import annotations

from contextlib import closing
import sqlite3
from account_sync_schema import study_hash
from application.native_course import NativeCourseApplication, NativeCoursePorts
from infrastructure.course_source_capture import NativeCourseSources
from infrastructure.course_grade_ledger import CourseGradeLedger
from infrastructure.course_grade_provider import evaluate_course
from native_course_schema import native_course_rules
import study_ai_provider


def create_native_course_application(services, authenticated_owner):
    root = services.source_path('learning_vault_root')
    sources = NativeCourseSources(root, authenticated_owner, services.effective_gateway,
                                  services.LOCAL_DATABASE_PATH)
    ledger = CourseGradeLedger(services.LOCAL_DATABASE_PATH, authenticated_owner, sources.library, root)

    def snapshot():
        with study_ai_provider.SETTINGS_LOCK:
            # Explicit closure also applies when SettingsStore performs reads.
            with closing(sqlite3.connect(services.LOCAL_DATABASE_PATH, timeout=10)) as db, db:
                return services.ai_store(db).snapshot(authenticated_owner, sources.library)

    def provider(task, answer, request_id, frozen, reservation):
        with study_ai_provider.SETTINGS_LOCK:
            current, key = snapshot()
            if study_hash(current) != study_hash(frozen):
                raise ValueError('ai-settings-stale')
            # Build captures the selected endpoint/model/key atomically before
            # transport, without putting credentials into a public receipt.
            return evaluate_course(current, key, task, answer, request_id, reservation)

    return NativeCourseApplication(NativeCoursePorts(
        rules=native_course_rules(),
        library_id=lambda: services.local_vault_library_id(services.source_path('learning_vault_root')),
        read_source=sources.read, capture_source=sources.verify_current, read_attempt=ledger.read_attempt,
        begin=ledger.begin, reserve=ledger.reserve, prepare=ledger.prepare, finish=ledger.finish,
        read_claim=ledger.read_claim, read_claim_by_event=ledger.read_claim_by_event,
        save_claim=ledger.save_claim, settings=lambda: snapshot()[0], provider=provider,
    ))
