"""Conflict-safe plan decisions backed by the single Obsidian plan note."""

from __future__ import annotations

import json
import copy
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import plan_authority
from task_plan_schema import hash_task_plan

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
PLAN_SUBFOLDER = "plan-changes"
LEGACY_PLAN_SUBFOLDER = "plan"
REVISIONS_FILE = "revisions.jsonl"
PLAN_LOCK = threading.RLock()


def plan_area_root(vault_root: Path, integration_root: str = STUDY_LOOP_INTEGRATION_ROOT) -> Path:
    return Path(vault_root) / integration_root / PLAN_SUBFOLDER


def _vault_root(area: Path) -> Path:
    resolved = Path(area)
    for parent in resolved.parents:
        if parent.name == "_System":
            return parent.parent
    if len(resolved.parents) >= 4:
        return resolved.parents[3]
    raise ValueError("invalid-plan-area")


def _legacy_area(area: Path) -> Path:
    return Path(area).parent / LEGACY_PLAN_SUBFOLDER


def read_revisions(area: Path) -> list[dict[str, Any]]:
    revisions_path = Path(area) / REVISIONS_FILE
    if not revisions_path.exists():
        return []
    revisions: list[dict[str, Any]] = []
    for line in revisions_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError('invalid-plan-revision-log') from error
        if not isinstance(row, dict) or type(row.get('revision')) is not int or row['revision'] < 0:
            raise ValueError('invalid-plan-revision-log')
        if row.get('decision', 'applied') not in ('applied', 'rejected', 'restored', 'migrated'):
            raise ValueError('invalid-plan-revision-log')
        if row.get('decision', 'applied') != 'rejected' and not isinstance(row.get('after'), dict):
            raise ValueError('invalid-plan-revision-log')
        revisions.append(row)
    return revisions


def _revision_bytes(previous: bytes | None, revision: dict[str, Any]) -> bytes:
    old = previous or b''
    line = (json.dumps(revision, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    return old + (b'\n' if old and not old.endswith(b'\n') else b'') + line


def _append_revision(area: Path, revision: dict[str, Any]) -> None:
    area = Path(area)
    area.mkdir(parents=True, exist_ok=True)
    revisions_path = area / REVISIONS_FILE
    previous = revisions_path.read_bytes() if revisions_path.exists() else None
    temporary = revisions_path.with_name(f".{REVISIONS_FILE}.zhixue.tmp")
    temporary.write_bytes(_revision_bytes(previous, revision))
    temporary.replace(revisions_path)


def current_revision(area: Path) -> int:
    revisions = read_revisions(area)
    applied = [item for item in revisions if item.get('decision', 'applied') != 'rejected']
    current = plan_authority.read_current_plan(_vault_root(area))
    revision = current.get('revision', 0) if current else 0
    if type(revision) is not int or revision < 0:
        raise ValueError('invalid-plan-revision')
    if applied:
        numbers = [item['revision'] for item in applied]
        if any(a >= b for a, b in zip(numbers, numbers[1:])) or not current or numbers[-1] != revision or applied[-1]['after'] != current['candidate']:
            raise ValueError('stale-plan-revision')
    return revision


def current_plan(area: Path) -> dict[str, Any] | None:
    current_revision(area)
    current = plan_authority.read_current_plan(_vault_root(area))
    if current is not None:
        return current.get("candidate")
    for revision in reversed(read_revisions(area)):
        if revision.get("decision", "applied") != "rejected" and isinstance(revision.get("after"), dict):
            return revision["after"]
    return None


def _restore_file(path: Path, previous: bytes | None) -> None:
    if previous is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(previous)


def _apply_and_record(area: Path, candidate: dict[str, Any], record: dict[str, Any]) -> None:
    vault_root = _vault_root(area)
    main_path = vault_root / plan_authority.PLAN_RELATIVE_PATH
    previous = main_path.read_bytes() if main_path.exists() else None
    log = Path(area) / REVISIONS_FILE
    previous_log = log.read_bytes() if log.exists() else None
    plan_authority.apply_current_plan(vault_root, candidate, int(record["revision"]))
    written = main_path.read_bytes()
    try:
        _append_revision(area, record)
    except Exception:
        if main_path.exists() and main_path.read_bytes() == written:
            _restore_file(main_path, previous)
        if log.exists() and log.read_bytes() == _revision_bytes(previous_log, record):
            _restore_file(log, previous_log)
        raise


def write_today_plan(area: Path, candidate: dict[str, Any]) -> Path:
    """Compatibility helper: write the next authoritative managed revision."""
    with PLAN_LOCK:
        apply_plan_revision(area, candidate, 'compatibility', 'write-today-plan')
        return _vault_root(area) / plan_authority.PLAN_RELATIVE_PATH


def apply_plan_revision(
    area: Path,
    candidate: dict[str, Any],
    operator: str,
    triggered_by: str,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    with PLAN_LOCK:
        candidate = copy.deepcopy(candidate)
        current = current_revision(area)
        if expected_revision is not None and expected_revision != current:
            raise ValueError("stale-plan-revision")
        before = current_plan(area)
        revision_number = current + 1
        record = {
            "sequence": len(read_revisions(area)) + 1,
            "revision": revision_number,
            "decision": "applied",
            "triggeredBy": triggered_by,
            "inputHash": candidate.get("inputHash", candidate.get("planHash", "")),
            "before": before,
            "after": candidate,
            "operator": operator,
            "undoTarget": None,
            "appliedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        _apply_and_record(area, candidate, record)
        return record


def append_review_revision(area: Path, item: dict, expected_revision: int | None = None, capture_id: str | None = None) -> dict:
    with PLAN_LOCK:
        if not item.get('itemId') or not item.get('abilityId'):
            raise ValueError('review-item-requires-item-id-and-ability-id')
        if capture_id:
            previous = next((row for row in read_revisions(area) if row.get('captureId') == capture_id), None)
            if previous:
                return previous
        current = current_revision(area)
        if expected_revision is not None and expected_revision != current:
            raise ValueError('stale-plan-revision')
        candidate = copy.deepcopy(current_plan(area))
        if candidate is None:
            raise ValueError('no-managed-plan')
        before = copy.deepcopy(candidate)
        if candidate.get('schemaVersion') == 2:
            task = plan_authority.capture_review_task(_vault_root(area), candidate, item, capture_id, current + 1)
            old = next((entry for entry in candidate['tasks'] if entry['category'] == 'review' and entry['taskId'].startswith('capture:')
                        and entry['subjectId'] == task['subjectId'] and entry['action'] == task['action']), None)
            if old:
                if old['taskId'] in candidate['manual']['lockedTaskIds']:
                    changed = old['sourceHash'] != task['sourceHash'] or old['completionRule'] != task['completionRule']
                    for field in ('title', 'estimatedMinutes', 'sourceHash', 'completionRule', 'blockedReason'):
                        if field in old:
                            task[field] = copy.deepcopy(old[field])
                    if changed:
                        task['blockedReason'] = '学习来源已更新，请确认后继续。'
                candidate['tasks'][candidate['tasks'].index(old)] = task
                for field in ('lockedTaskIds', 'order'):
                    if field in candidate['manual']:
                        candidate['manual'][field] = [task['taskId'] if value == old['taskId'] else value for value in candidate['manual'][field]]
            else:
                candidate['tasks'].append(task)
            candidate['draftVersion'] += 1
            candidate['planHash'] = hash_task_plan(candidate)
        else:
            items = candidate.setdefault('reviewItems', [])
            existing = next((entry for entry in items if entry.get('itemId') == item['itemId'] and entry.get('abilityId') == item['abilityId']), None)
            if existing is None:
                items.append(copy.deepcopy(item))
            else:
                existing.update({key: value for key, value in item.items() if value is not None})
        record = {'sequence': len(read_revisions(area)) + 1, 'revision': current + 1, 'decision': 'applied',
                  'triggeredBy': 'capture-review', 'inputHash': candidate.get('inputHash', candidate.get('planHash', '')),
                  'before': before, 'after': candidate, 'operator': 'capture', 'undoTarget': None,
                  'appliedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'reviewItem': copy.deepcopy(item)}
        if capture_id:
            record['captureId'] = capture_id
        _apply_and_record(area, candidate, record)
        return record


def reject_candidate(area: Path, candidate_hash: str, operator: str, reason: str = "") -> dict[str, Any]:
    with PLAN_LOCK:
        if not candidate_hash:
            raise ValueError("invalid-candidate-hash")
        record = {
            "sequence": len(read_revisions(area)) + 1,
            "revision": current_revision(area),
            "decision": "rejected",
            "triggeredBy": "website-rejection",
            "inputHash": candidate_hash,
            "candidateHash": candidate_hash,
            "reason": reason[:500],
            "before": current_plan(area),
            "after": None,
            "operator": operator,
            "undoTarget": None,
            "appliedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        _append_revision(area, record)
        return record


def restore_revision(
    area: Path,
    target: int,
    operator: str,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    with PLAN_LOCK:
        current = current_revision(area)
        if expected_revision is not None and expected_revision != current:
            raise ValueError("stale-plan-revision")
        revisions = read_revisions(area)
        target_revision = next(
            (
                item
                for item in revisions
                if item.get("revision") == target
                and item.get("decision", "applied") != "rejected"
                and isinstance(item.get("after"), dict)
            ),
            None,
        )
        if target_revision is None:
            raise ValueError("unknown-plan-revision")
        restored_candidate = target_revision["after"]
        record = {
            "sequence": len(revisions) + 1,
            "revision": current + 1,
            "decision": "restored",
            "triggeredBy": "restore",
            "inputHash": restored_candidate.get("inputHash", restored_candidate.get("planHash", "")),
            "before": current_plan(area),
            "after": restored_candidate,
            "operator": operator,
            "undoTarget": target,
            "appliedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        _apply_and_record(area, restored_candidate, record)
        return record


def record_migrated_plan(
    area: Path,
    candidate: dict[str, Any],
    revision: int,
    source: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Make an explicitly applied legacy migration visible and restorable."""
    with PLAN_LOCK:
        existing = [row for row in read_revisions(area) if row.get("decision") == "migrated" and row.get("revision") == revision]
        if existing:
            return existing[-1]
        record = {
            "sequence": len(read_revisions(area)) + 1,
            "revision": revision,
            "decision": "migrated",
            "triggeredBy": "authoritative-migration",
            "inputHash": candidate.get("inputHash", candidate.get("planHash", "")),
            "before": None,
            "after": candidate,
            "operator": "migration",
            "source": source,
            "undoTarget": None,
            "appliedAt": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds"),
        }
        _append_revision(area, record)
        return record


def current_payload(area: Path, history_limit: int = 20) -> dict[str, Any]:
    with PLAN_LOCK:
        history = read_revisions(area)[-max(1, min(history_limit, 50)):]
        return {
            "revision": current_revision(area),
            "candidate": current_plan(area),
            "history": history,
        }
