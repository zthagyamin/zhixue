"""Explicit request-scoped service bindings; no server import or startup side effects."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import tzinfo
from pathlib import Path
from typing import Any, Callable, ContextManager


@dataclass(frozen=True)
class RouteServices:
    CONFIG: dict[str, Any]
    DATA_LOCK: ContextManager[Any]
    LOCAL_DATABASE_PATH: Path
    LOCAL_TZ: tzinfo
    NOTE_SOURCE_LOCK: ContextManager[Any]
    ROOT: Path
    STUDY_V3_SCHEMA_VERSION: int
    accept_activity: Callable[..., Any]
    accept_assistance_payload: Callable[..., Any]
    accept_study_event_v3: Callable[..., Any]
    ai_store: Callable[..., Any]
    allowed_origin: Callable[..., Any]
    attach_state_handles: Callable[..., Any]
    call_deepseek: Callable[..., Any]
    correct_card_deepseek: Callable[..., Any]
    daily_dashboard: Callable[..., Any]
    deepseek_key: Callable[..., Any]
    due_review_items: Callable[..., Any]
    effective_constraints: Callable[..., Any]
    effective_gateway: Callable[..., Any]
    get_account_sync_service: Callable[..., Any]
    get_hint_deepseek: Callable[..., Any]
    get_note_source_runtime: Callable[..., Any]
    grade_recall_deepseek: Callable[..., Any]
    indexed_study_payload: Callable[..., Any]
    installation_owner_hash: Callable[..., Any]
    local_database: Callable[..., Any]
    local_vault_library_id: Callable[..., Any]
    merge_source_area: Callable[..., Any]
    normalize_question_subjects: Callable[..., Any]
    paper_library_request: Callable[..., Any]
    paper_vocabulary_request: Callable[..., Any]
    reorder_plan_with_deepseek: Callable[..., Any]
    revoke_session: Callable[..., Any]
    run_change_scan_once: Callable[..., Any]
    safe_refresh: Callable[..., Any]
    save_deepseek_key: Callable[..., Any]
    set_state: Callable[..., Any]
    source_path: Callable[..., Any]
    store_local_activity: Callable[..., Any]
    study_event_stats_payload: Callable[..., Any]
    suggestion_ai: Callable[..., Any]
    validate_study_event_v3: Callable[..., Any]
    vault_mapping_request: Callable[..., Any]
    with_connections: Callable[..., Any]
    read_state: Callable[[], dict[str, Any]]

    @property
    def STATE(self) -> dict[str, Any]:
        # set_state replaces the dictionary during refresh; never capture it early.
        return self.read_state()
