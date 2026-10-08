"""Preview, apply, and roll back the v0.10 authoritative Obsidian layout."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import constraint_area
import plan_area
import plan_authority

INTEGRATION_ROOT = Path("_System/Integrations/Study Loop")
LEGACY_PLAN_AREA = INTEGRATION_ROOT / "plan"
MIGRATION_BACKUP_ROOT = INTEGRATION_ROOT / "backups"
MIGRATION_SCHEMA = 1


def _hash(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _inside(root: Path, candidate: Path) -> Path:
    root = root.resolve()
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError("migration-path-outside-vault") from error
    return resolved


def _has_constraints_block(path: Path) -> bool:
    if not path.exists():
        return False
    text = path.read_text(encoding="utf-8")
    return constraint_area.CONSTRAINT_BEGIN in text and constraint_area.CONSTRAINT_END in text


def preview(vault_root: Path) -> dict[str, Any]:
    """Return a stable, read-only migration manifest bound to current file bytes."""
    vault = Path(vault_root).resolve()
    plan_path = vault / plan_authority.PLAN_RELATIVE_PATH
    constraints_path = vault / constraint_area.CONSTRAINT_RELATIVE_PATH
    legacy_path = vault / LEGACY_PLAN_AREA / "revisions.jsonl"
    history_path = vault / INTEGRATION_ROOT / plan_area.PLAN_SUBFOLDER / plan_area.REVISIONS_FILE
    current_plan = plan_authority.read_current_plan(vault)
    plan_action = "noop" if current_plan is not None else ("migrate" if legacy_path.exists() else "no-legacy-plan")
    constraints_action = "noop" if _has_constraints_block(constraints_path) else "initialize"
    files = [
        {"relativePath": plan_authority.PLAN_RELATIVE_PATH.as_posix(), "sha256": _hash(plan_path)},
        {"relativePath": constraint_area.CONSTRAINT_RELATIVE_PATH.as_posix(), "sha256": _hash(constraints_path)},
        {"relativePath": (LEGACY_PLAN_AREA / "revisions.jsonl").as_posix(), "sha256": _hash(legacy_path)},
        {
            "relativePath": (INTEGRATION_ROOT / plan_area.PLAN_SUBFOLDER / plan_area.REVISIONS_FILE).as_posix(),
            "sha256": _hash(history_path),
        },
    ]
    core = {
        "schemaVersion": MIGRATION_SCHEMA,
        "actions": {"plan": plan_action, "constraints": constraints_action},
        "files": files,
    }
    preview_id = hashlib.sha256(
        json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {**core, "previewId": preview_id}


def _backup(vault: Path, paths: list[Path], now: datetime) -> tuple[str, Path, list[dict[str, Any]]]:
    backup_id = "migration-" + now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_root = vault / MIGRATION_BACKUP_ROOT / backup_id
    if backup_root.exists():
        suffix = hashlib.sha256(now.isoformat().encode("utf-8")).hexdigest()[:8]
        backup_id = f"{backup_id}-{suffix}"
        backup_root = vault / MIGRATION_BACKUP_ROOT / backup_id
    records: list[dict[str, Any]] = []
    for path in paths:
        relative = path.relative_to(vault)
        existed = path.exists()
        records.append({"relativePath": relative.as_posix(), "existed": existed, "sha256": _hash(path)})
        if existed:
            destination = backup_root / "files" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
    backup_root.mkdir(parents=True, exist_ok=True)
    return backup_id, backup_root, records


def apply(vault_root: Path, preview_id: str, now: datetime | None = None) -> dict[str, Any]:
    with plan_area.PLAN_LOCK:
        return _apply_locked(vault_root, preview_id, now)


def _apply_locked(vault_root: Path, preview_id: str, now: datetime | None = None) -> dict[str, Any]:
    """Apply only when the caller's preview still matches every relevant file."""
    vault = Path(vault_root).resolve()
    current = preview(vault)
    if not preview_id or preview_id != current["previewId"]:
        raise ValueError("stale-migration-preview")
    actions = current["actions"]
    now = now or datetime.now(timezone.utc)
    targets: list[Path] = []
    if actions["plan"] == "migrate":
        targets.append(vault / plan_authority.PLAN_RELATIVE_PATH)
        targets.append(vault / INTEGRATION_ROOT / plan_area.PLAN_SUBFOLDER / plan_area.REVISIONS_FILE)
    if actions["constraints"] == "initialize":
        targets.append(vault / constraint_area.CONSTRAINT_RELATIVE_PATH)
    if not targets:
        return {"status": "no-op", "backupId": None, "previewId": preview_id, "actions": actions}
    backup_id, backup_root, records = _backup(vault, targets, now)
    manifest = {
        "schemaVersion": MIGRATION_SCHEMA,
        "backupId": backup_id,
        "createdAt": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "previewId": preview_id,
        "files": records,
    }
    (backup_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    try:
        if actions["plan"] == "migrate":
            migration = plan_authority.migrate_plan(vault, vault / LEGACY_PLAN_AREA, now)
            current_plan = plan_authority.read_current_plan(vault)
            if migration.status == "migrated" and current_plan is not None:
                plan_area.record_migrated_plan(
                    plan_area.plan_area_root(vault),
                    current_plan["candidate"],
                    int(current_plan["revision"]),
                    migration.source or str(LEGACY_PLAN_AREA),
                    now,
                )
        if actions["constraints"] == "initialize":
            constraint_area.write_constraints(vault, constraint_area.default_constraints(now), now)
    except Exception:
        rollback(vault, backup_id)
        raise
    return {"status": "applied", "backupId": backup_id, "previewId": preview_id, "actions": actions}


def rollback(vault_root: Path, backup_id: str) -> dict[str, Any]:
    """Restore only files recorded by a migration backup manifest."""
    if not backup_id or Path(backup_id).name != backup_id or not backup_id.startswith("migration-"):
        raise ValueError("invalid-backup-id")
    vault = Path(vault_root).resolve()
    backup_root = _inside(vault, vault / MIGRATION_BACKUP_ROOT / backup_id)
    manifest_path = backup_root / "manifest.json"
    if not manifest_path.exists():
        raise ValueError("migration-backup-not-found")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for record in manifest.get("files", []):
        relative = Path(str(record.get("relativePath", "")))
        target = _inside(vault, vault / relative)
        if record.get("existed"):
            source = _inside(backup_root, backup_root / "files" / relative)
            if not source.exists():
                raise ValueError("migration-backup-incomplete")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        else:
            target.unlink(missing_ok=True)
    return {"status": "rolled-back", "backupId": backup_id}


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate the Zhixue authoritative Obsidian learning loop.")
    parser.add_argument("action", choices=("preview", "apply", "rollback"))
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--preview-id")
    parser.add_argument("--backup-id")
    args = parser.parse_args()
    if args.action == "preview":
        result = preview(args.vault)
    elif args.action == "apply":
        if not args.preview_id:
            parser.error("apply requires --preview-id")
        result = apply(args.vault, args.preview_id)
    else:
        if not args.backup_id:
            parser.error("rollback requires --backup-id")
        result = rollback(args.vault, args.backup_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
