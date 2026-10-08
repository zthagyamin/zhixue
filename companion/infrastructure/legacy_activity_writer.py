"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations
from study_day import study_day

import json
from datetime import datetime
from typing import Any
from application.activity_values import clean_markdown_cell


def accept_activity(payload: dict[str, Any], write_to_vault: bool = True, *, EVENT_ID_PATTERN, EVENT_DOMAINS, EVENT_OUTCOMES, LOCAL_TZ, DATA_LOCK, learning_vault_path, daily_dashboard, event_log_path, read_activity_events, render_daily_report, dashboard_activity_events, relative_note_path, now) -> dict[str, Any]:
    event_id = str(payload.get("eventId", "")).strip()
    if not EVENT_ID_PATTERN.fullmatch(event_id):
        raise ValueError("eventId 必须是 6–128 位的稳定字母数字标识。")
    domain = str(payload.get("domain", "")).strip()
    outcome = str(payload.get("outcome", "")).strip()
    if domain not in EVENT_DOMAINS:
        raise ValueError("不支持的学习领域。")
    if outcome not in EVENT_OUTCOMES:
        raise ValueError("不支持的学习结果。")
    occurred_raw = str(payload.get("occurredAt", "")).strip()
    try:
        occurred_at = datetime.fromisoformat(occurred_raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("occurredAt 必须是 ISO 8601 时间。") from error
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=LOCAL_TZ)
    event_day = study_day(occurred_at)
    duration = max(0, min(1440, int(payload.get("durationMin", 0) or 0)))
    title = clean_markdown_cell(payload.get("title"), 180)
    if not title:
        raise ValueError("学习事件缺少 title。")
    source_note = str(payload.get("sourceNote") or payload.get("relatedNote") or "").strip().replace("\\", "/")
    state_ref = str(payload.get("stateRef", "")).strip().replace("\\", "/")
    for field_name, note_ref in (("sourceNote", source_note), ("stateRef", state_ref)):
        if note_ref and write_to_vault:
            note_path = learning_vault_path(note_ref)
            if not note_path.exists() or note_path.suffix.lower() != ".md":
                raise ValueError(f"{field_name} 必须指向已授权 Vault 中存在的 Markdown 笔记。")
    ability_id = clean_markdown_cell(payload.get("abilityId"), 160)
    weak_points = payload.get("weakPoints", [])
    if not isinstance(weak_points, list):
        weak_points = []
    event = {
        "schemaVersion": 2,
        "eventId": event_id,
        "occurredAt": occurred_at.astimezone(LOCAL_TZ).isoformat(timespec="seconds"),
        "receivedAt": now().isoformat(timespec="seconds"),
        "domain": domain,
        "activityType": clean_markdown_cell(payload.get("activityType", "practice"), 80),
        "title": title,
        "outcome": outcome,
        "durationMin": duration,
        "correct": max(0, int(payload.get("correct", 0) or 0)),
        "total": max(0, int(payload.get("total", 0) or 0)),
        "hintUsed": bool(payload.get("hintUsed", False)),
        "weakPoints": [clean_markdown_cell(item, 160) for item in weak_points[:20] if clean_markdown_cell(item, 160)],
        "sourceNote": source_note,
        "stateRef": state_ref,
        "abilityId": ability_id,
    }
    if not write_to_vault:
        return {"accepted": True, "duplicate": False, "event": event, "dashboard": daily_dashboard(event_day)}
    with DATA_LOCK:
        log_path = event_log_path(event_day)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        existing = read_activity_events(event_day)
        duplicate = next((item for item in existing if item.get("eventId") == event_id), None)
        if duplicate:
            return {"accepted": True, "duplicate": True, "event": duplicate, "dashboard": daily_dashboard(event_day)}
        with log_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        report_path = render_daily_report(event_day, dashboard_activity_events(event_day))
    return {
        "accepted": True,
        "duplicate": False,
        "event": event,
        "dailyReport": relative_note_path(report_path),
        "dashboard": daily_dashboard(event_day),
    }
