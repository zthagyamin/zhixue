"""v0.9 learning-record maintenance: monthly archiving and summaries.

Events live in `<vault>/_System/Integrations/Study Loop/events/YYYY/YYYY-MM-DD.jsonl`.
`archive_old_months` moves complete older months into `events/archive/YYYY-MM/`
without deleting or rewriting data. `write_month_summary` writes a derived
monthly record page into the integration area; the user's main learning plan is
never touched.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from infrastructure.vault_documents import checked_literal_path
from mapped_source_registry import _atomic, _safe

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
EVENTS_SUBFOLDER = "events"
ARCHIVE_SUBFOLDER = "archive"
SUMMARY_FOLDER = "学习记录"


def events_root(vault_root: Path) -> Path:
    return Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / EVENTS_SUBFOLDER


def _month_key(day: str) -> tuple[int, int]:
    return int(day[:4]), int(day[5:7])


def _checked_vault(vault_root: Path) -> Path:
    # Check ancestors before resolving: a redirected root must not acquire authority.
    supplied = Path(vault_root).absolute()
    vault = checked_literal_path(supplied)
    if not vault.is_dir():
        raise ValueError('maintenance-vault-unavailable')
    if supplied != vault:
        raise ValueError("maintenance-noncanonical-root")
    return vault


def archive_old_months(vault_root: Path, cutoff_year: int, cutoff_month: int) -> list[str]:
    vault = _checked_vault(vault_root)
    root = _safe(vault, events_root(vault))
    if not root.exists():
        return []
    moves: list[tuple[Path, Path]] = []
    for year_dir in sorted(root.iterdir()):
        _safe(vault, year_dir)
        if not year_dir.is_dir() or year_dir.name == ARCHIVE_SUBFOLDER:
            continue
        try:
            year = int(year_dir.name)
        except ValueError:
            continue
        for day_file in sorted(year_dir.glob("*.jsonl")):
            _safe(vault, day_file)
            if (year, int(day_file.stem[5:7])) >= (cutoff_year, cutoff_month):
                continue
            month_dir = root / ARCHIVE_SUBFOLDER / f"{year:04d}-{int(day_file.stem[5:7]):02d}"
            target = _safe(vault, month_dir / day_file.name)
            if not target.exists():
                moves.append((day_file, target))
    # No mutation until every planned source and destination has passed preflight.
    archived: list[str] = []
    for source, target in moves:
        _safe(vault, source)
        _safe(vault, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        _safe(vault, source)
        _safe(vault, target)
        if target.exists():
            continue
        source.rename(target)
        archived.append(str(target))
    return archived


def _read_month_events(vault_root: Path, year: int, month: int) -> list[dict]:
    vault = _checked_vault(vault_root)
    root = _safe(vault, events_root(vault))
    events: list[dict] = []
    month_dir = _safe(vault, root / f"{year:04d}")
    if not month_dir.exists():
        return events
    files = list(month_dir.glob(f"{year:04d}-{month:02d}-*.jsonl"))
    for day_file in files:
        _safe(vault, day_file)
    for day_file in files:
        _safe(vault, day_file)
        for line in day_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def _generated_summary(raw: bytes, year: int, month: int) -> bool:
    """Recognize the existing generator format, never just a forgeable type label.

    This protects accidental collisions/edits, not authorship against an OS user
    who already has write access to these derived pages.
    """
    try:
        text = raw.decode("utf-8").replace("\r\n", "\n")
    except UnicodeDecodeError:
        return False
    month_key = f"{year:04d}-{month:02d}"
    pattern = (
        r"---\ntype: study-loop-month-summary\nstatus: derived\n"
        + re.escape(f"month: {month_key}\n")
        + r"event_count: (?P<count>\d+)\ntotal_minutes: (?P<minutes>-?\d+)\n"
        + r"updated: \d{4}-\d{2}-\d{2}\n---\n\n"
        + re.escape(f"# {month_key} 学习记录汇总\n\n")
        + re.escape("> [!info] 派生记录\n> 由知学按 v3 复习事件生成；不是正式掌握状态，也不修改主学习计划。\n\n")
        + r"- 练习事件：(?P=count)\n- 记录时长：(?P=minutes) 分钟\n- 领域：[^\n]*\n"
    )
    return re.fullmatch(pattern, text) is not None


def write_month_summary(vault_root: Path, year: int, month: int) -> Path:
    vault = _checked_vault(vault_root)
    summary_dir = vault / STUDY_LOOP_INTEGRATION_ROOT / SUMMARY_FOLDER
    path = _safe(vault, summary_dir / f"{year:04d}-{month:02d}.md")
    previous = path.read_bytes() if path.exists() else None
    if previous is not None and not _generated_summary(previous, year, month):
        raise ValueError("maintenance-summary-conflict")
    events = _read_month_events(vault, year, month)
    total_minutes = sum(int(event.get("durationMin", 0) or 0) for event in events)
    domain_counts: dict[str, int] = {}
    for event in events:
        domain = str(event.get("domain", "other"))
        domain_counts[domain] = domain_counts.get(domain, 0) + 1
    lines = [
        "---",
        "type: study-loop-month-summary",
        "status: derived",
        f"month: {year:04d}-{month:02d}",
        f"event_count: {len(events)}",
        f"total_minutes: {total_minutes}",
        f"updated: {datetime.now(timezone.utc).date().isoformat()}",
        "---",
        "",
        f"# {year:04d}-{month:02d} 学习记录汇总",
        "",
        "> [!info] 派生记录",
        "> 由知学按 v3 复习事件生成；不是正式掌握状态，也不修改主学习计划。",
        "",
        f"- 练习事件：{len(events)}",
        f"- 记录时长：{total_minutes} 分钟",
        "- 领域：" + ("、".join(f"{key} × {value}" for key, value in sorted(domain_counts.items())) or "暂无"),
        "",
    ]
    _atomic(vault, path, "\n".join(lines).encode("utf-8"), previous)
    return path
