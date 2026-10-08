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
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

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
    if evidence not in VALID_EVIDENCE:
        raise ValueError("invalid-evidence")
    return evidence


def store_capture(db: sqlite3.Connection, vault_root: Path, capture: dict[str, Any]) -> dict[str, Any]:
    """Idempotently persist a capture; returns the stored row (existing if any)."""
    ensure_schema(db)
    evidence = capture_evidence(capture)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.execute(
        "INSERT OR IGNORE INTO codex_captures(capture_id, item_id, domain, source_note, state_ref, "
        "ability_id, content_fingerprint, plugin_type, plan_revision, evidence, summary, captured_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (capture["captureId"], capture["itemId"], capture["domain"], capture.get("sourceNote", ""),
         capture.get("stateRef", ""), capture.get("abilityId", ""), capture["contentFingerprint"],
         capture.get("pluginType", "quiz"), int(capture.get("planRevision", 0)),
         evidence, capture.get("summary"), now),
    )
    db.commit()
    row = db.execute("SELECT * FROM codex_captures WHERE capture_id = ?", (capture["captureId"],)).fetchone()
    return _row_to_dict(db, row)


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
    dirs = snapshot_schema.ensure_sources_dirs(vault_root)
    snapshot = snapshot_schema.build_snapshot(
        {key: capture[key] for key in ("captureId", "itemId", "domain", "sourceNote", "stateRef",
                                       "abilityId", "contentFingerprint", "pluginType", "planRevision")
         if key in capture}
        | {"status": "pending"}
    )
    target = dirs["pending"] / f"{capture['captureId']}.json"
    target.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
