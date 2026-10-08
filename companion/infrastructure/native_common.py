"""Shared native persistence primitives; no server dependency or startup work."""
from __future__ import annotations
from typing import Any
from pathlib import Path
import json
import sqlite3
import hashlib
import index_gateway
from study_event_schema import _require_known_keys, SCHEDULER_VERSION
from application.activity_values import clean_markdown_cell

def _validate_local_context(local_context: Any, vault_root: Path) -> dict[str, Any]:
    if local_context is None:
        return {}
    if not isinstance(local_context, dict):
        raise ValueError("invalid-localContext")
    _require_known_keys(
        local_context,
        {"title", "activityType", "durationMin", "weakPoints", "sourceNote", "stateRef", "abilityId"},
        "local-context",
    )
    context: dict[str, Any] = {}
    title = clean_markdown_cell(local_context.get("title"), 180)
    if title:
        context["title"] = title
    activity_type = clean_markdown_cell(local_context.get("activityType"), 80)
    if activity_type:
        context["activityType"] = activity_type
    duration = local_context.get("durationMin")
    if isinstance(duration, int) and not isinstance(duration, bool):
        context["durationMin"] = max(0, min(1440, duration))
    weak_points = local_context.get("weakPoints", [])
    if isinstance(weak_points, list):
        context["weakPoints"] = [clean_markdown_cell(item, 160) for item in weak_points[:20] if clean_markdown_cell(item, 160)]
    for field_name in ("sourceNote", "stateRef", "abilityId"):
        value = local_context.get(field_name)
        if value is not None:
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"invalid-local-{field_name}")
            context[field_name] = value.strip().replace("\\", "/")
    for field_name in ("sourceNote", "stateRef"):
        note_ref = context.get(field_name)
        if note_ref:
            note_path, _ = index_gateway.resolve_reference(vault_root, note_ref)
            if not note_path.exists() or note_path.suffix.lower() != ".md":
                raise ValueError(f"{field_name} 必须指向已授权 Vault 中存在的 Markdown 笔记。")
    return context


def _events_for_state(
    database: sqlite3.Connection,
    account_id: str,
    state_ref: str,
) -> dict[str, list[dict[str, Any]]]:
    rows = database.execute(
        "SELECT event_json, local_context_json FROM study_events_v3 WHERE account_id = ? ORDER BY occurred_at, event_id",
        (account_id,),
    ).fetchall()
    events: dict[str, list[dict[str, Any]]] = {}
    for event_json, context_json in rows:
        try:
            event = json.loads(event_json)
            context = json.loads(context_json) if context_json else {}
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or not isinstance(context, dict):
            continue
        ability_id = context.get("abilityId")
        if context.get("stateRef") == state_ref and isinstance(ability_id, str) and ability_id:
            events.setdefault(ability_id, []).append(event)
    return events


def _restore_bytes(path: Path, previous: bytes | None) -> None:
    if previous is None:
        path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(previous)


def study_event_stats_payload(database: sqlite3.Connection, account_id: str) -> dict[str, Any]:
    row = database.execute(
        "SELECT count(*), max(accepted_at) FROM study_events_v3 WHERE account_id = ?",
        (account_id,),
    ).fetchone()
    event_count = int(row[0] or 0)
    latest_accepted_at = str(row[1]) if row[1] else None
    stats = database.execute(
        "SELECT duplicate_count, conflict_count FROM study_event_stats WHERE account_id = ?",
        (account_id,),
    ).fetchone()
    duplicate_count = int(stats[0]) if stats else 0
    conflict_count = int(stats[1]) if stats else 0
    rows = database.execute(
        "SELECT event_id, core_hash FROM study_events_v3 WHERE account_id = ? ORDER BY event_id",
        (account_id,),
    ).fetchall()
    event_set_input = json.dumps([[event_id, core_hash] for event_id, core_hash in rows], ensure_ascii=False, separators=(",", ":"))
    event_set_hash = hashlib.sha256(event_set_input.encode("utf-8")).hexdigest()
    return {
        "schedulerVersion": SCHEDULER_VERSION,
        "eventCount": event_count,
        "latestAcceptedAt": latest_accepted_at,
        "duplicateCount": duplicate_count,
        "conflictCount": conflict_count,
        "eventSetHash": event_set_hash,
    }
