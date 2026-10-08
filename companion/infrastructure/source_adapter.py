"""Local source stores and existing source services behind request-scoped ports."""
from __future__ import annotations
from datetime import datetime
import sqlite3
import audit_diag
import capture_store
import change_detect
import companion_setup
import events_archive
import index_gateway
import note_source_api
import note_source_runtime
import snapshot_schema
from application.failures import SourceStorageFailure
from application.sources import SourceApplication, SourcePorts


def create_source_application(services) -> SourceApplication:
    selected = []

    def vault():
        if not selected:
            selected.append(services.source_path('learning_vault_root'))
        return selected[0]

    def storage(operation):
        try:
            return operation()
        except sqlite3.Error as error:
            raise SourceStorageFailure(str(error), getattr(error, 'no_write', False)) from error

    def configure(payload):
        runtime = services.get_note_source_runtime()
        with services.NOTE_SOURCE_LOCK, runtime.service.lock:
            updated = companion_setup.configure_workspace(services.ROOT, payload, has_history=lambda: note_source_runtime.has_history(services.LOCAL_DATABASE_PATH.parent))
            services.CONFIG.update(updated)
        return note_source_runtime.setup_status(services.ROOT)

    def write_notes(owner, payload):
        runtime = services.get_note_source_runtime()
        return note_source_api.dispatch(runtime.service, owner, 'POST', payload, deliver=runtime.deliver)

    def pending():
        with services.local_database() as database:
            return capture_store.pending_captures(database)

    def decide(change_id, decision, operator):
        root = vault()
        with services.local_database() as database:
            candidate = next((item for item in change_detect.detect_changes(database, root) if item.get('changeId') == change_id), None)
            if candidate is None:
                raise ValueError('资料变更已过期，请重新检查后再决定。')
            change_detect.decide_candidate(database, candidate, decision, operator, root)
            log = change_detect.decision_log(database, change_id)
            change_detect.scan_and_project(database, root)
        return log

    def initialize():
        root = vault()
        dirs = snapshot_schema.ensure_sources_dirs(root)
        return {'root': snapshot_schema.SOURCES_ROOT_NAME, 'dirs': {name: path.relative_to(root).as_posix() for name, path in dirs.items()}}

    def capture(payload):
        root = vault()
        with services.local_database() as database:
            return capture_store.route_capture(root, database, payload)

    return SourceApplication(SourcePorts(
        vault_available=lambda: vault().exists(),
        gateway_exists=lambda: (vault() / index_gateway.GATEWAY_ROOT).exists(),
        indexed=lambda owner: services.indexed_study_payload(vault(), owner),
        projection=lambda: change_detect.read_projection(vault()),
        scan=lambda: services.run_change_scan_once(),
        pending=pending,
        audit=lambda: audit_diag.audit_area(vault()),
        papers=lambda *args, **kwargs: storage(lambda: services.paper_library_request(*args, **kwargs)),
        vocabulary=lambda *args, **kwargs: storage(lambda: services.paper_vocabulary_request(*args, **kwargs)),
        read_notes=lambda owner: note_source_api.dispatch(services.get_note_source_runtime().service, owner, 'GET'),
        write_notes=write_notes,
        workspace_status=lambda: note_source_runtime.setup_status(services.ROOT),
        configure_workspace=configure,
        mapping=lambda *args: services.vault_mapping_request(*args),
        valid_decision=lambda value: value in change_detect.VALID_DECISIONS,
        decide=decide,
        archive=lambda year, month: events_archive.archive_old_months(vault(), year, month),
        now=lambda: datetime.now(services.LOCAL_TZ),
        summary=lambda year, month: str(events_archive.write_month_summary(vault(), year, month).relative_to(vault())),
        initialize=initialize,
        route_capture=capture,
        capture_evidence=capture_store.capture_evidence,
    ))
