"""v0.9 change detection for the study-loop source area.

Scans `<vault>/_System/Integrations/Study Loop/sources/` against a persisted
snapshot and produces change candidates: added / modified / removed / renamed
(content-hash based). Decisions (approved / rejected / later) are recorded in
an append-only audit log; pending = no decision yet or latest decision "later".
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
SOURCE_SUBFOLDER = "sources"
SUPPORTED_SUFFIXES = {".md"}
VALID_DECISIONS = {"approved", "rejected", "later"}
CANDIDATE_PROJECTION = Path("candidates/current.json")


@dataclass(frozen=True)
class ScanStatus:
    scanned_at: str
    pending_count: int
    projection_path: Path
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "scannedAt": self.scanned_at,
            "pendingCount": self.pending_count,
            "error": self.error,
        }

CHANGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS source_change_state (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  approved_content TEXT,
  title TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_change_log (
  change_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  operator TEXT NOT NULL
);
"""


def ensure_schema(database: sqlite3.Connection) -> None:
    database.executescript(CHANGE_SCHEMA)
    columns = {row[1] for row in database.execute("PRAGMA table_info(source_change_state)").fetchall()}
    if "approved_content" not in columns:
        database.execute("ALTER TABLE source_change_state ADD COLUMN approved_content TEXT")


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def source_root(vault_root: Path) -> Path:
    return Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / SOURCE_SUBFOLDER


def scan_files(vault_root: Path) -> list[dict[str, Any]]:
    root = source_root(vault_root)
    if not root.exists():
        return []
    files: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        files.append({
            "path": path.relative_to(root).as_posix(),
            "contentHash": content_hash(text),
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
    return files


def snapshot_state(database: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    ensure_schema(database)
    rows = database.execute(
        "SELECT path, content_hash, title, updated_at FROM source_change_state"
    ).fetchall()
    return {path: {"contentHash": content_hash_, "title": title, "updatedAt": updated_at}
            for path, content_hash_, title, updated_at in rows}


def _make_candidate(kind: str, path: str, digest: str) -> dict[str, Any]:
    change_id = hashlib.sha256(f"{kind}:{path}:{digest}".encode("utf-8")).hexdigest()
    return {"changeId": change_id, "kind": kind, "path": path, "contentHash": digest}


def detect_changes(database: sqlite3.Connection, vault_root: Path) -> list[dict[str, Any]]:
    ensure_schema(database)
    source_directory = source_root(vault_root).resolve()
    previous_raw = snapshot_state(database)
    previous: dict[str, dict[str, Any]] = {}
    for stored_path, record in previous_raw.items():
        path = Path(stored_path)
        if path.is_absolute():
            try:
                stored_path = path.resolve().relative_to(source_directory).as_posix()
            except ValueError:
                continue
        previous[Path(stored_path).as_posix()] = record
    current = {file_["path"]: file_ for file_ in scan_files(vault_root)}

    added = [path for path in current if path not in previous]
    modified = [
        path for path in current
        if path in previous and previous[path]["contentHash"] != current[path]["contentHash"]
    ]
    removed = [path for path in previous if path not in current]

    # Rename: a removed path whose content hash matches an added path.
    added_by_hash: dict[str, list[str]] = {}
    for path in added:
        added_by_hash.setdefault(current[path]["contentHash"], []).append(path)
    renamed_pairs: list[tuple[str, str]] = []
    remaining_removed: list[str] = []
    for path in removed:
        matches = [candidate for candidate in added_by_hash.get(previous[path]["contentHash"], []) if candidate != path]
        if matches:
            renamed_pairs.append((path, matches[0]))
        else:
            remaining_removed.append(path)

    renamed_new_paths = {new for _, new in renamed_pairs}
    candidates: list[dict[str, Any]] = []
    for path in added:
        if path in renamed_new_paths:
            continue
        candidates.append(_make_candidate("added", path, current[path]["contentHash"]))
    for path in modified:
        candidates.append(_make_candidate("modified", path, current[path]["contentHash"]))
    for old, new in renamed_pairs:
        candidate = _make_candidate("renamed", new, current[new]["contentHash"])
        candidate["oldPath"] = old
        candidates.append(candidate)
    for path in remaining_removed:
        candidates.append(_make_candidate("removed", path, previous[path]["contentHash"]))
    return candidates


def apply_scan(database: sqlite3.Connection, vault_root: Path) -> None:
    ensure_schema(database)
    database.execute("DELETE FROM source_change_state")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for file_ in scan_files(vault_root):
        source = source_root(vault_root) / file_["path"]
        content = source.read_text(encoding="utf-8-sig", errors="replace")
        database.execute(
            "INSERT INTO source_change_state(path, content_hash, approved_content, title, updated_at) VALUES (?, ?, ?, NULL, ?)",
            (file_["path"], file_["contentHash"], content, now),
        )
    database.commit()


def approved_source_paths(database: sqlite3.Connection, vault_root: Path) -> set[str]:
    """Return current files whose exact content has been approved already."""
    source_directory = source_root(vault_root).resolve()
    approved_raw = snapshot_state(database)
    approved: dict[str, dict[str, Any]] = {}
    for stored_path, record in approved_raw.items():
        path = Path(stored_path)
        if path.is_absolute():
            try:
                stored_path = path.resolve().relative_to(source_directory).as_posix()
            except ValueError:
                continue
        approved[Path(stored_path).as_posix()] = record
    current = {file_["path"]: file_ for file_ in scan_files(vault_root)}
    return {
        str(source_directory / Path(path))
        for path, file_ in current.items()
        if path in approved and approved[path]["contentHash"] == file_["contentHash"]
    }


def approved_source_documents(database: sqlite3.Connection, vault_root: Path | None = None) -> list[dict[str, str]]:
    """Return local-only snapshots so pending edits cannot alter approved study data."""
    ensure_schema(database)
    rows = database.execute(
        "SELECT path, content_hash, approved_content FROM source_change_state ORDER BY path"
    ).fetchall()
    documents: list[dict[str, str]] = []
    for path, digest, approved_content in rows:
        content = approved_content
        if content is None and vault_root is not None:
            source = source_root(vault_root) / Path(str(path))
            if source.exists():
                current = source.read_text(encoding="utf-8-sig", errors="replace")
                if content_hash(current) == digest:
                    content = current
                    database.execute(
                        "UPDATE source_change_state SET approved_content = ? WHERE path = ?",
                        (content, path),
                    )
        if content is not None:
            documents.append({"path": str(path), "content": str(content)})
    database.commit()
    return documents


def decision_log(database: sqlite3.Connection, change_id: str) -> list[dict[str, Any]]:
    ensure_schema(database)
    rows = database.execute(
        "SELECT change_id, decision, decided_at, operator FROM source_change_log WHERE change_id = ? ORDER BY rowid",
        (change_id,),
    ).fetchall()
    return [
        {"changeId": row[0], "decision": row[1], "decidedAt": row[2], "operator": row[3]}
        for row in rows
    ]


def decide(database: sqlite3.Connection, change_id: str, decision: str, operator: str) -> None:
    ensure_schema(database)
    if decision not in VALID_DECISIONS:
        raise ValueError("invalid-decision")
    database.execute(
        "INSERT INTO source_change_log(change_id, decision, decided_at, operator) VALUES (?, ?, ?, ?)",
        (change_id, decision, datetime.now(timezone.utc).isoformat(timespec="seconds"), operator),
    )
    database.commit()


def decide_candidate(
    database: sqlite3.Connection,
    candidate: dict[str, Any],
    decision: str,
    operator: str,
    vault_root: Path | None = None,
) -> None:
    """Record one reviewed candidate and atomically advance approved state."""
    ensure_schema(database)
    if decision not in VALID_DECISIONS:
        raise ValueError("invalid-decision")
    change_id = str(candidate.get("changeId", ""))
    kind = str(candidate.get("kind", ""))
    path = str(candidate.get("path", ""))
    digest = str(candidate.get("contentHash", ""))
    if not change_id or kind not in {"added", "modified", "removed", "renamed"} or not path or not digest:
        raise ValueError("invalid-change-candidate")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        if decision == "approved":
            if kind == "removed":
                database.execute("DELETE FROM source_change_state WHERE path = ?", (path,))
            else:
                if kind == "renamed":
                    old_path = str(candidate.get("oldPath", ""))
                    if not old_path:
                        raise ValueError("invalid-change-candidate")
                    database.execute("DELETE FROM source_change_state WHERE path = ?", (old_path,))
                if vault_root is None:
                    raise ValueError("vault-root-required")
                source = source_root(vault_root) / Path(path)
                if not source.exists() or source.suffix.lower() not in SUPPORTED_SUFFIXES:
                    raise ValueError("source-change-stale")
                content = source.read_text(encoding="utf-8-sig", errors="replace")
                if content_hash(content) != digest:
                    raise ValueError("source-change-stale")
                database.execute(
                    """
                    INSERT INTO source_change_state(path, content_hash, approved_content, title, updated_at)
                    VALUES (?, ?, ?, NULL, ?)
                    ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash,
                      approved_content = excluded.approved_content, updated_at = excluded.updated_at
                    """,
                    (path, digest, content, now),
                )
        database.execute(
            "INSERT INTO source_change_log(change_id, decision, decided_at, operator) VALUES (?, ?, ?, ?)",
            (change_id, decision, now, operator),
        )
        database.commit()
    except Exception:
        database.rollback()
        raise


def is_pending(database: sqlite3.Connection, candidate: dict[str, Any]) -> bool:
    log = decision_log(database, candidate["changeId"])
    if not log:
        return True
    return log[-1]["decision"] == "later"


def pending_changes(database: sqlite3.Connection, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [candidate for candidate in candidates if is_pending(database, candidate)]


def projection_path(vault_root: Path) -> Path:
    return Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / CANDIDATE_PROJECTION


def read_projection(vault_root: Path) -> dict[str, Any]:
    path = projection_path(vault_root)
    if not path.exists():
        return {"scannedAt": None, "pendingCount": 0, "changes": [], "error": None}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"scannedAt": None, "pendingCount": 0, "changes": [], "error": "invalid-projection"}
    return payload if isinstance(payload, dict) else {"scannedAt": None, "pendingCount": 0, "changes": [], "error": "invalid-projection"}


def scan_and_project(
    database: sqlite3.Connection,
    vault_root: Path,
    now: datetime | None = None,
) -> ScanStatus:
    """Refresh the pending-candidate projection without approving any source."""
    now = now or datetime.now(timezone.utc)
    scanned_at = now.astimezone(timezone.utc).isoformat(timespec="seconds")
    path = projection_path(vault_root)
    try:
        pending = pending_changes(database, detect_changes(database, vault_root))
        safe_changes = [
            {
                key: candidate[key]
                for key in ("changeId", "kind", "path", "oldPath", "contentHash")
                if key in candidate
            }
            for candidate in pending
        ]
        payload = {
            "schemaVersion": 1,
            "scannedAt": scanned_at,
            "pendingCount": len(safe_changes),
            "changes": safe_changes,
            "error": None,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.zhixue.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        temporary.replace(path)
        return ScanStatus(scanned_at, len(safe_changes), path)
    except Exception as error:
        previous = read_projection(vault_root)
        safe_error = str(error).replace(str(Path(vault_root)), "<vault>")[:300]
        return ScanStatus(scanned_at, int(previous.get("pendingCount", 0) or 0), path, safe_error)
