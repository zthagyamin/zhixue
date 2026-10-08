"""Schema v3 canonical hashing and strict validation shared with the web protocol.

Importing this module never reads installation config or opens a local database.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

STUDY_V3_SCHEMA_VERSION = 3
SCHEDULER_VERSION = "ts-fsrs-5.4.1-default-v1"
STUDY_V3_RATINGS = {"again", "hard", "good", "easy"}
STUDY_V3_DOMAINS = {"ielts", "python", "differential-review"}
STUDY_V3_ITEM_KINDS = {"word", "python", "due"}
STUDY_V3_EVENT_TYPES = {"practice-attempt", "review-baseline"}
STUDY_V3_FORBIDDEN_KEYS = {"sourceNote", "stateRef", "vaultPath", "localPath", "apiKey", "token"}
STUDY_V3_HASH_EXCLUDED_KEYS = {"coreHash", "clientStateAfter", "delivery", "localContext"}
MAX_EVENT_BYTES = 32 * 1024
MAX_IDENTIFIER_CHARACTERS = 200
STUDY_V3_SCHEMA = """
CREATE TABLE IF NOT EXISTS study_events_v3 (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  core_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  local_context_json TEXT,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE TABLE IF NOT EXISTS state_handles (
  account_id TEXT NOT NULL,
  state_handle TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  ability_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, state_handle),
  UNIQUE (account_id, state_ref, ability_id)
);
CREATE TABLE IF NOT EXISTS study_event_projections (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE TABLE IF NOT EXISTS study_event_bindings (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE TABLE IF NOT EXISTS study_event_stats (
  account_id TEXT PRIMARY KEY,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
"""


def canonicalize_json(value: Any) -> str:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize_json(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = sorted(value.items(), key=lambda pair: pair[0])
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + canonicalize_json(child) for key, child in entries) + "}"
    raise ValueError("non-canonical-json-value")


def study_event_hash_input(event: dict[str, Any]) -> dict[str, Any]:
    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: clean(child) for key, child in value.items() if key not in STUDY_V3_HASH_EXCLUDED_KEYS}
        if isinstance(value, list):
            return [clean(child) for child in value]
        return value

    return clean(event)


def compute_study_event_core_hash(event: dict[str, Any]) -> str:
    canonical = canonicalize_json(study_event_hash_input(event))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ensure_study_v3_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(STUDY_V3_SCHEMA)


def scan_forbidden_cloud_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in STUDY_V3_FORBIDDEN_KEYS:
                raise ValueError("forbidden-cloud-field")
            scan_forbidden_cloud_keys(child)
    elif isinstance(value, list):
        for child in value:
            scan_forbidden_cloud_keys(child)


def _require_string(value: Any, label: str, max_length: int | None = None) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"invalid-{label}")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label}-too-long")
    return value


def _require_iso_date(value: Any, label: str) -> str:
    text = _require_string(value, label, 40)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid-{label}") from error
    if parsed.tzinfo is None:
        raise ValueError(f"invalid-{label}")
    canonical = parsed.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if canonical != text:
        raise ValueError(f"invalid-{label}")
    return text


def _require_known_keys(record: dict[str, Any], known: set[str], label: str) -> None:
    unknown = set(record) - known
    if unknown:
        raise ValueError(f"unknown-{label}-key")


def _parse_item(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid-item")
    _require_known_keys(value, {"kind", "key", "stateHandle"}, "item")
    kind = _require_string(value.get("kind"), "item-kind", 32)
    if kind not in STUDY_V3_ITEM_KINDS:
        raise ValueError("invalid-item-kind")
    key = _require_string(value.get("key"), "item-key", MAX_IDENTIFIER_CHARACTERS)
    item: dict[str, Any] = {"kind": kind, "key": key}
    if "stateHandle" in value:
        item["stateHandle"] = _require_string(value["stateHandle"], "state-handle", 160)
    return item


def _parse_attempt(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid-attempt")
    _require_known_keys(value, {"rating", "correct", "stageBefore", "stageAfter"}, "attempt")
    rating = _require_string(value.get("rating"), "rating", 16)
    if rating not in STUDY_V3_RATINGS:
        raise ValueError("invalid-rating")
    correct = value.get("correct")
    if not isinstance(correct, bool):
        raise ValueError("invalid-correct")
    stage_before = value.get("stageBefore")
    stage_after = value.get("stageAfter")
    if not isinstance(stage_before, int) or isinstance(stage_before, bool) or stage_before < 0:
        raise ValueError("invalid-stageBefore")
    if not isinstance(stage_after, int) or isinstance(stage_after, bool) or stage_after < 0:
        raise ValueError("invalid-stageAfter")
    return {"rating": rating, "correct": correct, "stageBefore": stage_before, "stageAfter": stage_after}


def _parse_scheduling(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid-scheduling")
    _require_known_keys(value, {"reviewedAt", "schedulerVersion", "clientStateAfter"}, "scheduling")
    reviewed_at = _require_iso_date(value.get("reviewedAt"), "reviewed-at")
    scheduler_version = _require_string(value.get("schedulerVersion"), "scheduler-version", 64)
    if scheduler_version != SCHEDULER_VERSION:
        raise ValueError("unsupported-scheduler-version")
    parsed: dict[str, Any] = {"reviewedAt": reviewed_at, "schedulerVersion": scheduler_version}
    if "clientStateAfter" in value:
        if not isinstance(value["clientStateAfter"], dict):
            raise ValueError("invalid-clientStateAfter")
        parsed["clientStateAfter"] = value["clientStateAfter"]
    return parsed


def _parse_baseline_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid-baselineState")
    _require_known_keys(value, {
        "due", "stability", "difficulty", "elapsedDays", "scheduledDays",
        "learningSteps", "reps", "lapses", "state", "lastReview",
    }, "baseline")
    due = _require_iso_date(value.get("due"), "baseline-due")
    if "lastReview" in value:
        _require_iso_date(value["lastReview"], "baseline-last-review")
    for key in ("stability", "difficulty"):
        text = _require_string(value.get(key), f"baseline-{key}", 64)
        try:
            float(text)
        except ValueError as error:
            raise ValueError(f"invalid-baseline-{key}") from error
    state = value.get("state")
    if not isinstance(state, int) or isinstance(state, bool) or state not in (0, 1, 2, 3):
        raise ValueError("invalid-baseline-state")
    return value


def validate_study_event_v3(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("invalid-study-event-v3")
    size = len(json.dumps(raw, ensure_ascii=False).encode("utf-8"))
    if size > MAX_EVENT_BYTES:
        raise ValueError("event-too-large")
    scan_forbidden_cloud_keys(raw)
    event_type = _require_string(raw.get("eventType"), "event-type", 32)
    if event_type not in STUDY_V3_EVENT_TYPES:
        raise ValueError("invalid-event-type")
    base_keys = {"schemaVersion", "eventId", "coreHash", "occurredAt", "domain", "eventType", "item"}
    _require_known_keys(
        raw,
        base_keys | ({"attempt", "scheduling"} if event_type == "practice-attempt" else {"schedulerVersion", "baselineState"}),
        "event",
    )
    if raw.get("schemaVersion") != STUDY_V3_SCHEMA_VERSION:
        raise ValueError("unsupported-schema-version")
    event_id = _require_string(raw.get("eventId"), "event-id", MAX_IDENTIFIER_CHARACTERS)
    core_hash = _require_string(raw.get("coreHash"), "core-hash", 64)
    if len(core_hash) != 64:
        raise ValueError("invalid-core-hash")
    occurred_at = _require_iso_date(raw.get("occurredAt"), "occurred-at")
    domain = _require_string(raw.get("domain"), "domain", 32)
    if domain not in STUDY_V3_DOMAINS:
        raise ValueError("invalid-domain")
    item = _parse_item(raw.get("item"))
    event: dict[str, Any] = {
        "schemaVersion": STUDY_V3_SCHEMA_VERSION,
        "eventId": event_id,
        "coreHash": core_hash,
        "occurredAt": occurred_at,
        "domain": domain,
        "eventType": event_type,
        "item": item,
    }
    if event_type == "practice-attempt":
        event["attempt"] = _parse_attempt(raw.get("attempt"))
        if "scheduling" in raw:
            event["scheduling"] = _parse_scheduling(raw.get("scheduling"))
    else:
        scheduler_version = _require_string(raw.get("schedulerVersion"), "scheduler-version", 64)
        if scheduler_version != SCHEDULER_VERSION:
            raise ValueError("unsupported-scheduler-version")
        event["schedulerVersion"] = scheduler_version
        event["baselineState"] = _parse_baseline_state(raw.get("baselineState"))
    if compute_study_event_core_hash(event) != core_hash:
        raise ValueError("invalid-study-event-core-hash")
    return event
