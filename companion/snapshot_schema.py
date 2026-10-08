"""Approved snapshot schema for Codex learning captures (v1.0).

A Codex learning session ends by writing an *approved snapshot*: a
machine-readable JSON record of what was learned, where it came from, and
which learning state and plan revision it reflects. Snapshots live under
``<vault>/sources/approved/`` (v1.0 spec §7):

- ``approved/``  — snapshots the user (or Codex, with authority) approved.
- ``pending/``   — captures awaiting review (e.g. plugin suggestions).
- ``rejected/``  — captures the user declined, kept for audit.

Each snapshot is written with the same ``captureId`` as the capture event so
the trail can be followed end to end.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SOURCES_ROOT_NAME = "sources"
SUBFOLDERS = ("approved", "pending", "rejected")

REQUIRED_FIELDS = (
    "captureId",      # stable id shared with the capture event
    "itemId",         # StudyItem id (e.g. "zhx-word-pooling")
    "domain",         # domain tag, e.g. "ielts"
    "sourceNote",     # relative path of the source note in the vault
    "stateRef",       # relative path of the learning-state note
    "abilityId",      # FSRS ability id the state applies to
    "contentFingerprint",  # deterministic hash of captured content
    "approvedAt",     # ISO-8601 UTC timestamp of approval
    "pluginType",     # capture plugin that produced this snapshot
    "planRevision",   # revision of the plan the state belongs to
)

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def sources_root(vault_root: str | Path) -> Path:
    """Return the sources directory path under the vault root."""
    return Path(vault_root) / SOURCES_ROOT_NAME


def ensure_sources_dirs(vault_root: str | Path) -> dict[str, Path]:
    """Create ``sources/{approved,pending,rejected}`` and return their paths."""
    root = sources_root(vault_root)
    root.mkdir(parents=True, exist_ok=True)
    dirs: dict[str, Path] = {}
    for name in SUBFOLDERS:
        path = root / name
        path.mkdir(parents=True, exist_ok=True)
        dirs[name] = path
    return dirs


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_snapshot(fields: dict[str, Any]) -> dict[str, Any]:
    """Build a valid snapshot dict from capture fields.

    ``approvedAt`` defaults to the current UTC time when not provided.
    """
    snapshot: dict[str, Any] = {"schemaVersion": SCHEMA_VERSION}
    snapshot.update(fields)
    snapshot.setdefault("approvedAt", _utc_now_iso())
    return snapshot


def _reject_traversal(value: Any, field: str) -> str:
    text = str(value)
    if text.startswith(("/", "\\")) or ".." in text.replace("\\", "/").split("/"):
        raise ValueError(
            f"{field}: path must stay inside the vault, got {text!r}"
        )
    return text


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    """Validate required fields and path safety. Raises ValueError on failure."""
    for field in REQUIRED_FIELDS:
        if field not in snapshot:
            raise ValueError(f"missing required field: {field}")
    for field in ("sourceNote", "stateRef"):
        _reject_traversal(snapshot[field], field)
    if not isinstance(snapshot["planRevision"], int) or snapshot["planRevision"] < 0:
        raise ValueError("planRevision must be a non-negative integer")


def _safe_filename(capture_id: str) -> str:
    cleaned = _FILENAME_SAFE_RE.sub("-", str(capture_id)).strip("-")
    if not cleaned:
        raise ValueError(f"captureId yields no safe filename: {capture_id!r}")
    return f"{cleaned}.json"


def write_approved_snapshot(
    vault_root: str | Path, snapshot: dict[str, Any]
) -> Path:
    """Validate and atomically write an approved snapshot to ``sources/approved``."""
    validate_snapshot(snapshot)
    dirs = ensure_sources_dirs(vault_root)
    target = dirs["approved"] / _safe_filename(snapshot["captureId"])
    payload = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, target)
    return target


def read_approved_snapshot(vault_root: str | Path, name: str) -> dict[str, Any]:
    """Read and validate one approved snapshot by filename."""
    path = sources_root(vault_root) / "approved" / name
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    validate_snapshot(snapshot)
    return snapshot


def approved_snapshots(vault_root: str | Path) -> list[dict[str, Any]]:
    """List all valid approved snapshots, skipping unreadable/invalid files."""
    directory = sources_root(vault_root) / "approved"
    if not directory.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            snapshot = json.loads(path.read_text(encoding="utf-8"))
            validate_snapshot(snapshot)
        except (ValueError, OSError, json.JSONDecodeError):
            continue
        result.append(snapshot)
    return result
