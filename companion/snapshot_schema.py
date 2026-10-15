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

import hashlib
import json
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

_FILENAME_SAFE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_DIGEST_FILENAME_PREFIX = "capture-sha256-"
_WINDOWS_RESERVED_RE = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)


def _validate_capture_id(capture_id: Any) -> None:
    if (not isinstance(capture_id, str) or not capture_id.strip() or len(capture_id) > 180
            or any(char in capture_id for char in "/\\")
            or any(ord(char) < 32 or ord(char) == 127 for char in capture_id)):
        raise ValueError("invalid-captureId")
    try:
        capture_id.encode("utf-8")
    except UnicodeError as error:
        raise ValueError("invalid-captureId") from error


def sources_root(vault_root: str | Path) -> Path:
    """Return the sources directory path under the vault root."""
    return Path(vault_root) / SOURCES_ROOT_NAME


def ensure_sources_dirs(vault_root: str | Path) -> dict[str, Path]:
    """Create ``sources/{approved,pending,rejected}`` and return their paths."""
    from mapped_source_registry import _safe
    vault = Path(vault_root).absolute()
    root = _safe(vault, sources_root(vault))
    dirs = {name: _safe(vault, root / name) for name in SUBFOLDERS}
    root.mkdir(parents=True, exist_ok=True)
    _safe(vault, root)
    for path in dirs.values():
        _safe(vault, path)
        path.mkdir(parents=True, exist_ok=True)
        _safe(vault, path)
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
    if not isinstance(value, str):
        raise ValueError(f"{field}: expected a relative path")
    text = value
    if (text.startswith(("/", "\\")) or ":" in text
            or any(ord(char) < 32 for char in text)
            or ".." in text.replace("\\", "/").split("/")):
        raise ValueError(
            f"{field}: path must stay inside the vault, got {text!r}"
        )
    return text


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    """Validate required fields and path safety. Raises ValueError on failure."""
    if not isinstance(snapshot, dict):
        raise ValueError("invalid-snapshot")
    for field in REQUIRED_FIELDS:
        if field not in snapshot:
            raise ValueError(f"missing required field: {field}")
    _validate_capture_id(snapshot["captureId"])
    for field in ('itemId', 'domain', 'abilityId', 'contentFingerprint', 'approvedAt', 'pluginType'):
        if not isinstance(snapshot[field], str):
            raise ValueError(f'{field}: expected text')
    for field in ("sourceNote", "stateRef"):
        _reject_traversal(snapshot[field], field)
    if type(snapshot["planRevision"]) is not int or snapshot["planRevision"] < 0:
        raise ValueError("planRevision must be a non-negative integer")


def _safe_filename(capture_id: str) -> str:
    _validate_capture_id(capture_id)
    # Keep ordinary names; long identities leave space for the shared atomic suffix.
    if (len(capture_id) <= 100 and _FILENAME_SAFE_RE.fullmatch(capture_id) and not capture_id.endswith(".")
            and not _WINDOWS_RESERVED_RE.match(capture_id)
            and not capture_id.casefold().startswith(_DIGEST_FILENAME_PREFIX)):
        return f"{capture_id}.json"
    return _DIGEST_FILENAME_PREFIX + hashlib.sha256(capture_id.encode("utf-8")).hexdigest() + ".json"


def _validate_approved(snapshot: dict[str, Any]) -> None:
    validate_snapshot(snapshot)
    if snapshot.get("status") in ("pending", "rejected"):
        raise ValueError("snapshot-not-approved")


def _snapshot_target(vault: Path, directory: Path, capture_id: str, *, pending: bool = False) -> Path:
    """Reuse a safe legacy name only when its stored identity is the same.

    No file is renamed or migrated. A legacy cleaning collision belongs to its
    original capture; a different capture receives the new collision-safe name.
    """
    from mapped_source_registry import _safe
    target = _safe(vault, directory / _safe_filename(capture_id))
    if target.exists():
        return target
    legacy = capture_id if pending else re.sub(r"[^A-Za-z0-9._-]+", "-", capture_id).strip("-")
    if (not legacy or legacy.endswith(".") or _WINDOWS_RESERVED_RE.match(legacy)
            or (pending and any(char in legacy for char in ':*?"<>|'))):
        return target
    previous = _safe(vault, directory / f"{legacy}.json")
    if previous == target:
        return target
    try:
        if previous.exists() and json.loads(previous.read_bytes()).get("captureId") == capture_id:
            return previous
    except (OSError, ValueError, AttributeError, RecursionError):
        # A malformed or unrelated old file remains untouched.
        pass
    return target


def write_approved_snapshot(
    vault_root: str | Path, snapshot: dict[str, Any]
) -> Path:
    """Validate and atomically write an approved snapshot to ``sources/approved``."""
    from mapped_source_registry import _atomic
    _validate_approved(snapshot)
    vault = Path(vault_root).absolute()
    payload = (json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    dirs = ensure_sources_dirs(vault)
    target = _snapshot_target(vault, dirs["approved"], snapshot["captureId"])
    previous = target.read_bytes() if target.exists() else None
    if previous is not None and json.loads(previous).get("captureId") != snapshot["captureId"]:
        raise ValueError("capture-filename-conflict")
    if previous != payload:
        _atomic(vault, target, payload, previous)
    return target


def read_approved_snapshot(vault_root: str | Path, name: str) -> dict[str, Any]:
    """Read and validate one approved snapshot by filename."""
    from mapped_source_registry import _safe
    from infrastructure.vault_documents import checked_source_file
    if (not isinstance(name, str) or not name or name in {'.', '..'}
            or any(char in name for char in '/\\:') or not name.endswith('.json')):
        raise ValueError('invalid-snapshot-name')
    vault = Path(vault_root).absolute()
    path = _safe(vault, sources_root(vault) / "approved" / name)
    with checked_source_file(path, 'r', encoding='utf-8') as stream:
        text = stream.read(2_000_001)
    if len(text) > 2_000_000:
        raise ValueError('snapshot-too-large')
    try:
        snapshot = json.loads(text)
    except RecursionError as error:
        raise ValueError('invalid-snapshot-json') from error
    _validate_approved(snapshot)
    return snapshot


def approved_snapshots(vault_root: str | Path) -> list[dict[str, Any]]:
    """List all valid approved snapshots, skipping unreadable/invalid files."""
    from mapped_source_registry import _safe
    vault = Path(vault_root).absolute()
    try:
        directory = _safe(vault, sources_root(vault) / "approved")
    except (ValueError, OSError):
        return []
    if not directory.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            snapshot = read_approved_snapshot(vault, path.name)
        except (ValueError, OSError, json.JSONDecodeError):
            continue
        result.append(snapshot)
    return result
