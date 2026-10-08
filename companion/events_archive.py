"""v0.9 learning-record maintenance: monthly archiving and summaries.

Events live in `<vault>/_System/Integrations/Study Loop/events/YYYY/YYYY-MM-DD.jsonl`.
`archive_old_months` moves complete older months into `events/archive/YYYY-MM/`
without deleting or rewriting data. `write_month_summary` writes a derived
monthly record page into the integration area; the user's main learning plan is
never touched.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
EVENTS_SUBFOLDER = "events"
ARCHIVE_SUBFOLDER = "archive"
SUMMARY_FOLDER = "学习记录"


def events_root(vault_root: Path) -> Path:
    return Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / EVENTS_SUBFOLDER


def _month_key(day: str) -> tuple[int, int]:
    return int(day[:4]), int(day[5:7])


def archive_old_months(vault_root: Path, cutoff_year: int, cutoff_month: int) -> list[str]:
    root = events_root(vault_root)
    if not root.exists():
        return []
    archived: list[str] = []
    for year_dir in sorted(root.iterdir()):
        if not year_dir.is_dir() or year_dir.name == ARCHIVE_SUBFOLDER:
            continue
        try:
            year = int(year_dir.name)
        except ValueError:
            continue
        for day_file in sorted(year_dir.glob("*.jsonl")):
            if (year, int(day_file.stem[5:7])) >= (cutoff_year, cutoff_month):
                continue
            month_dir = root / ARCHIVE_SUBFOLDER / f"{year:04d}-{int(day_file.stem[5:7]):02d}"
            month_dir.mkdir(parents=True, exist_ok=True)
            target = month_dir / day_file.name
            if not target.exists():
                day_file.rename(target)
                archived.append(str(target))
    return archived


def _read_month_events(vault_root: Path, year: int, month: int) -> list[dict]:
    root = events_root(vault_root)
    events: list[dict] = []
    month_dir = root / f"{year:04d}"
    if not month_dir.exists():
        return events
    for day_file in month_dir.glob(f"{year:04d}-{month:02d}-*.jsonl"):
        for line in day_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def write_month_summary(vault_root: Path, year: int, month: int) -> Path:
    events = _read_month_events(vault_root, year, month)
    total_minutes = sum(int(event.get("durationMin", 0) or 0) for event in events)
    domain_counts: dict[str, int] = {}
    for event in events:
        domain = str(event.get("domain", "other"))
        domain_counts[domain] = domain_counts.get(domain, 0) + 1
    summary_dir = Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / SUMMARY_FOLDER
    summary_dir.mkdir(parents=True, exist_ok=True)
    path = summary_dir / f"{year:04d}-{month:02d}.md"
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
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
