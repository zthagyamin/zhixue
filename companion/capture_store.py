"""v1.0 Codex capture store: idempotent capture log with explicit/speculative split.

A capture is the structured record of a Codex learning session. Every capture
carries a ``captureId`` shared with its approved snapshot (``sources/approved``)
so the trail is end-to-end. Captures are persisted in the local D1/SQLite
database before any write-back happens; ``vault_root`` is used by later
tasks to route explicit evidence into the review queue and speculative
evidence into ``sources/pending/``.
"""
from __future__ import annotations
from study_day import study_day

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import plan_authority
import snapshot_schema

CAPTURE_SCHEMA = """
CREATE TABLE IF NOT EXISTS codex_captures (
  capture_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_note TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  ability_id TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  plugin_type TEXT NOT NULL,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL,
  summary TEXT,
  captured_at TEXT NOT NULL,
  processed_at TEXT,
  route_status TEXT,
  route_revision INTEGER
);
"""

VALID_EVIDENCE = {"explicit", "speculative"}
CAPTURE_DEFAULTS = {"sourceNote": "", "stateRef": "", "abilityId": "", "pluginType": "quiz",
                    "planRevision": 0, "evidence": "explicit", "summary": None}
CAPTURE_FIELDS = ("captureId", "itemId", "domain", "contentFingerprint", *CAPTURE_DEFAULTS)


def normalize_capture(capture: dict[str, Any]) -> dict[str, Any]:
    """Validate persisted fields before writes; retain the legacy ignored extra keys."""
    if not isinstance(capture, dict):
        raise ValueError("invalid-capture")
    value = {field: capture.get(field, CAPTURE_DEFAULTS.get(field)) for field in CAPTURE_FIELDS}
    snapshot_schema._validate_capture_id(value["captureId"])
    for field in ("itemId", "domain", "contentFingerprint", "sourceNote", "stateRef", "abilityId", "pluginType"):
        if not isinstance(value[field], str):
            raise ValueError(f"invalid-capture-field: {field}")
    if not value["itemId"].strip() or not value["contentFingerprint"].strip() or not value["pluginType"].strip():
        raise ValueError("invalid-capture-field")
    if value["summary"] is not None and not isinstance(value["summary"], str):
        raise ValueError("invalid-capture-field: summary")
    revision = value["planRevision"]
    if type(revision) is not int and (type(revision) is not str or not re.fullmatch(r"\s*[+-]?\d+\s*", revision)):
        raise ValueError("invalid-plan-revision")
    value["planRevision"] = int(revision)
    if not 0 <= value["planRevision"] <= 2**63 - 1:
        raise ValueError("invalid-plan-revision")
    value["evidence"] = capture_evidence(value)
    for field in ("sourceNote", "stateRef"):
        snapshot_schema._reject_traversal(value[field], field)
    # Serialization and UTF-8 failures must also precede schema/directory writes.
    json.dumps(value, ensure_ascii=False).encode("utf-8")
    return value


def _camel_case(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


def _row_to_dict(db: sqlite3.Connection, row: sqlite3.Row | tuple) -> dict[str, Any]:
    columns = [column[0] for column in db.execute("SELECT * FROM codex_captures WHERE 0").description]
    return {_camel_case(column): value for column, value in zip(columns, row)}


def ensure_schema(db: sqlite3.Connection) -> None:
    db.executescript(CAPTURE_SCHEMA)


def capture_evidence(capture: dict[str, Any]) -> str:
    evidence = capture.get("evidence", "explicit")
    if not isinstance(evidence, str) or evidence not in VALID_EVIDENCE:
        raise ValueError("invalid-evidence")
    return evidence


def store_capture(db: sqlite3.Connection, vault_root: Path, capture: dict[str, Any]) -> dict[str, Any]:
    """Idempotently persist a capture; returns the stored row (existing if any)."""
    capture = normalize_capture(capture)
    ensure_schema(db)
    row = db.execute("SELECT * FROM codex_captures WHERE capture_id = ?", (capture["captureId"],)).fetchone()
    if row is not None:
        stored = _row_to_dict(db, row)
        if any(stored[field] != capture[field] for field in CAPTURE_FIELDS):
            raise ValueError("capture-conflict")
        return stored
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.execute(
        "INSERT OR IGNORE INTO codex_captures(capture_id, item_id, domain, source_note, state_ref, "
        "ability_id, content_fingerprint, plugin_type, plan_revision, evidence, summary, captured_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (capture["captureId"], capture["itemId"], capture["domain"], capture["sourceNote"],
         capture["stateRef"], capture["abilityId"], capture["contentFingerprint"],
         capture["pluginType"], capture["planRevision"], capture["evidence"], capture["summary"], now),
    )
    db.commit()
    row = db.execute("SELECT * FROM codex_captures WHERE capture_id = ?", (capture["captureId"],)).fetchone()
    stored = _row_to_dict(db, row)
    if any(stored[field] != capture[field] for field in CAPTURE_FIELDS):
        raise ValueError("capture-conflict")
    return stored


def pending_captures(db: sqlite3.Connection) -> list[dict[str, Any]]:
    ensure_schema(db)
    rows = db.execute("SELECT * FROM codex_captures WHERE processed_at IS NULL ORDER BY captured_at").fetchall()
    return [_row_to_dict(db, row) for row in rows]


def mark_processed(db: sqlite3.Connection, capture_id: str) -> None:
    ensure_schema(db)
    db.execute("UPDATE codex_captures SET processed_at = ? WHERE capture_id = ?",
               (datetime.now(timezone.utc).isoformat(timespec="seconds"), capture_id))
    db.commit()


def _set_route(db: sqlite3.Connection, capture_id: str, status: str, revision: int | None = None) -> None:
    ensure_schema(db)
    db.execute(
        "UPDATE codex_captures SET route_status = ?, route_revision = ? WHERE capture_id = ?",
        (status, revision, capture_id),
    )
    db.commit()


def _finish_review_route(db: sqlite3.Connection, capture_id: str, revision: int) -> None:
    try:
        db.execute('UPDATE codex_captures SET processed_at = ?, route_status = ?, route_revision = ? WHERE capture_id = ?',
                   (datetime.now(timezone.utc).isoformat(timespec='seconds'), 'review', revision, capture_id))
        db.commit()
    except Exception:
        db.rollback()
        raise


def _write_pending_candidate(vault_root: Path, capture: dict[str, Any]) -> None:
    """Write a speculative capture to sources/pending/ as a candidate JSON."""
    from mapped_source_registry import _atomic
    snapshot = snapshot_schema.build_snapshot(
        {key: capture[key] for key in ("captureId", "itemId", "domain", "sourceNote", "stateRef",
                                       "abilityId", "contentFingerprint", "pluginType", "planRevision")
         if key in capture}
        | {"status": "pending", "approvedAt": capture["capturedAt"]}
    )
    snapshot_schema.validate_snapshot(snapshot)
    root = Path(vault_root).absolute()
    dirs = snapshot_schema.ensure_sources_dirs(root)
    target = snapshot_schema._snapshot_target(root, dirs["pending"], capture["captureId"], pending=True)
    if target.exists():
        try:
            previous = json.loads(target.read_bytes())
            # Historical candidates may omit optional defaults and have a different
            # creation timestamp. An equivalent retry preserves their original bytes.
            expected = {key: value for key, value in snapshot.items() if key != "approvedAt"}
            existing = {key: previous.get(key, CAPTURE_DEFAULTS.get(key)) for key in expected}
            if existing != expected:
                raise ValueError("capture-candidate-conflict")
        except (ValueError, AttributeError) as error:
            raise ValueError("capture-candidate-conflict") from error
        return
    payload = (json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic(root, target, payload, None)


def route_capture(
    vault_root: Path | None,
    db: sqlite3.Connection,
    capture: dict[str, Any],
) -> dict[str, Any]:
    """Persist a capture and route it by evidence (spec §6).

    - explicit with stateRef + abilityId -> review queue (plan managed block),
      capture marked processed.
    - speculative -> sources/pending/ candidate, stays pending.
    - explicit but unmapped -> pending, no formal state written.
    Idempotent per captureId: an already-processed capture replays its status.
    """
    stored = store_capture(db, vault_root, capture)
    if stored.get("processedAt"):
        return {"status": stored.get("routeStatus") or "review", "revision": stored.get("routeRevision")}

    capture = stored
    evidence = capture_evidence(capture)
    capture_id = capture["captureId"]
    if vault_root is None or not Path(vault_root).exists():
        _set_route(db, capture_id, "queued")
        return {"status": "queued", "revision": None}

    if evidence == "explicit":
        if not capture.get("stateRef") or not capture.get("abilityId"):
            _set_route(db, capture_id, "unmapped")
            return {"status": "unmapped", "revision": None}
        today = study_day(datetime.now(timezone.utc)).isoformat()
        item = {
            "itemId": capture["itemId"],
            "domain": capture.get("domain", ""),
            "sourceNote": capture.get("sourceNote", ""),
            "stateRef": capture["stateRef"],
            "abilityId": capture["abilityId"],
            "due": today,
            "reason": "显式捕获",
            "pluginType": capture.get("pluginType", "quiz"),
            "title": capture.get("summary") or capture["itemId"],
        }
        result = plan_authority.add_review_item(Path(vault_root), item, expected_revision=capture.get('planRevision') or None, capture_id=capture_id)
        _finish_review_route(db, capture_id, result['revision'])
        return {"status": "review", "revision": result["revision"]}

    _write_pending_candidate(Path(vault_root), capture)
    _set_route(db, capture_id, "candidate")
    return {"status": "candidate", "revision": None}
