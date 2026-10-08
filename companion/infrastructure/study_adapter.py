"""Bind the existing local stores to the narrow study application ports."""
from __future__ import annotations
from study_day import study_day

from datetime import datetime
import change_detect
import practice_engine
from application.study import StudyApplication, StudyPorts


def create_study_application(services) -> StudyApplication:
    root = None

    def vault():
        nonlocal root
        if root is None:
            root = services.source_path('learning_vault_root')
        return root

    def cached():
        nonlocal root
        with services.DATA_LOCK:
            # Legacy fallback is a new read stage after the indexed probe.
            root = services.source_path('learning_vault_root')
            return dict(services.STATE)

    def refresh_legacy():
        nonlocal root
        services.safe_refresh()
        # Refresh may select a new source and STATE. Bind that new read stage,
        # while keeping every document/identity in either stage on one root.
        root = None

    def indexed(owner, refresh):
        if refresh:
            return services.indexed_study_payload(vault(), owner, refresh=True)
        return services.indexed_study_payload(vault(), owner)

    def approved_documents():
        with services.local_database() as database:
            return change_detect.approved_source_documents(database, vault())

    def accept_native(owner, payload):
        with services.local_database() as database:
            root = vault()
            return services.accept_study_event_v3(database, root, owner, payload, write_to_vault=root.exists())

    def diagnostics(owner):
        with services.local_database() as database:
            return services.study_event_stats_payload(database, owner)

    return StudyApplication(StudyPorts(
        indexed=indexed,
        cached=cached,
        attach_handles=lambda value, owner: services.attach_state_handles(value, owner),
        library_id=lambda: services.local_vault_library_id(vault()),
        vault_available=lambda: vault().exists(),
        approved_documents=approved_documents,
        merge_sources=lambda value, documents: services.merge_source_area(value, vault(), documents),
        normalize=lambda value: services.normalize_question_subjects(value),
        practice=lambda: practice_engine.practice_items(vault(), legacy_items=services.due_review_items(study_day(datetime.now(services.LOCAL_TZ)))),
        decorate=lambda value: services.with_connections(value),
        legacy_dashboard=lambda: services.daily_dashboard(),
        refresh_legacy=refresh_legacy,
        set_cached=lambda value: services.set_state(value),
        schema_version=lambda: services.STUDY_V3_SCHEMA_VERSION,
        accept_native=accept_native,
        accept_legacy=lambda value: services.accept_activity(value, write_to_vault=vault().exists()),
        store_activity=lambda owner, value: services.store_local_activity(owner, value),
        assistance=lambda owner, value: services.accept_assistance_payload(owner, value),
        diagnostics=diagnostics,
        grade=lambda item, answer: practice_engine.grade_answer(item, answer, ai_available=bool(services.deepseek_key()), recall_grader=services.grade_recall_deepseek),
        variant=lambda item, attempt: practice_engine.variant_for(item, attempt),
    ))
