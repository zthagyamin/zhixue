"""Read-only adapter for Agent learning-session records in the Obsidian Vault."""
from __future__ import annotations
from study_day import study_day

import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

SESSION_ROOT = Path("_System/Integrations/Study Loop/sessions")
ALLOWED_TYPES = {"recorded", "pending-sync", "needs-review"}
MAX_TEXT = 400


def _scalar(raw: str) -> Any:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
        value = value[1:-1]
    if value in {"[]", "[ ]"}:
        return []
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none", "~"}:
        return None
    return value


def _frontmatter(text: str) -> tuple[dict[str, Any], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    properties: dict[str, Any] = {}
    current_list: str | None = None
    end_index: int | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = index
            break
        list_item = re.match(r"^\s+-\s+(.*)$", line)
        if current_list and list_item:
            existing = properties.setdefault(current_list, [])
            if isinstance(existing, list):
                existing.append(_scalar(list_item.group(1)))
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not match:
            current_list = None
            continue
        key, raw = match.groups()
        if raw.strip():
            properties[key] = _scalar(raw)
            current_list = None
        else:
            properties[key] = []
            current_list = key
    body = "\n".join(lines[(end_index + 1) if end_index is not None else 0:])
    return properties, body


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _wikilink_target(value: str) -> str:
    match = re.fullmatch(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", value.strip())
    return match.group(1).strip() if match else value.strip()


def _title(path: Path, body: str) -> str:
    match = re.search(r"^#\s+(.+)$", body, flags=re.MULTILINE)
    return (match.group(1).strip() if match else path.stem)[:MAX_TEXT]


def _timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _session_day(properties: dict[str, Any]) -> date | None:
    raw = str(properties.get("session_date", "")).strip()
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        started = _timestamp(properties.get("started_at"))
        return study_day(started) if started else None


def parse_session(path: Path, vault_root: Path) -> dict[str, Any] | None:
    """Parse one schema-compliant session into the dashboard activity shape."""
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return None
    properties, body = _frontmatter(text)
    if properties.get("type") != "learning-session":
        return None
    session_id = str(properties.get("session_id", "")).strip()
    session_day = _session_day(properties)
    if not session_id or session_day is None:
        return None
    status = str(properties.get("status", "recorded")).strip()
    if status not in ALLOWED_TYPES:
        return None
    started = _timestamp(properties.get("started_at"))
    ended = _timestamp(properties.get("ended_at"))
    occurred = ended or started
    if occurred is None:
        occurred = datetime(session_day.year, session_day.month, session_day.day, tzinfo=timezone.utc)
    duration = 0
    if started and ended:
        duration = max(0, int((ended - started).total_seconds() // 60))
    domains = _as_list(properties.get("domain"))
    domain = domains[0] if domains else "other"
    source_notes = [_wikilink_target(value) for value in _as_list(properties.get("source_notes"))]
    state_refs = [_wikilink_target(value) for value in _as_list(properties.get("state_refs"))]
    ability_ids = _as_list(properties.get("ability_ids"))
    weak_points = _as_list(properties.get("weak_abilities"))
    relative_path = path.relative_to(vault_root).as_posix()
    return {
        "eventId": f"learning-session:{session_id}",
        "sessionId": session_id,
        "sessionPath": relative_path,
        "sessionDate": session_day.isoformat(),
        "occurredAt": occurred.isoformat(timespec="seconds"),
        "domain": domain,
        "activityType": "learning-session",
        "title": _title(path, body),
        "outcome": "needs-review" if status == "needs-review" else "completed",
        "durationMin": duration,
        "weakPoints": weak_points,
        "sourceNote": source_notes[0] if source_notes else "",
        "stateRef": state_refs[0] if state_refs else "",
        "abilityId": ability_ids[0] if ability_ids else "",
        "sessionStatus": status,
        "evidenceLevel": str(properties.get("evidence_level", "")),
        "mappingStatus": str(properties.get("mapping_status", "")),
    }


def read_session_events(vault_root: Path, target_day: date | None = None) -> list[dict[str, Any]]:
    """Read and deduplicate session records without mutating the Vault."""
    root = Path(vault_root) / SESSION_ROOT
    if not root.is_dir():
        return []
    sessions: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*.md")):
        activity = parse_session(path, Path(vault_root))
        if activity is None:
            continue
        if target_day is not None and activity["sessionDate"] != target_day.isoformat():
            continue
        sessions.setdefault(activity["sessionId"], activity)
    activities = list(sessions.values())
    activities.sort(key=lambda item: (item["occurredAt"], item["eventId"]))
    return activities
