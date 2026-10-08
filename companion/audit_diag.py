"""v0.9 audit diagnostics: distinguish real source changes from derived files
and flag potential event-log bloat.

The audit report separates:
- `sourcesFiles`: real user-maintained content (sources/),
- `derivedFiles`: files the system derives (plan/, 学习记录/),
- `eventFiles`/`eventBytes`: append-only evidence growth,
- `archivedEventFiles`: archived evidence (not growing the active log),
- `overgrown`: heuristic flag when active events exceed the bloat budget.
"""

from __future__ import annotations

from pathlib import Path

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
SOURCE_SUBFOLDER = "sources"
PLAN_SUBFOLDER = "plan"
SUMMARY_FOLDER = "学习记录"
EVENTS_SUBFOLDER = "events"
ARCHIVE_SUBFOLDER = "archive"

# Heuristic bloat budget: 100 active events or 512 KiB of non-archived events.
EVENT_FILE_BUDGET = 100
EVENT_BYTE_BUDGET = 512 * 1024


def _count_files(root: Path, suffix: str | None = None) -> int:
    if not root.exists():
        return 0
    return sum(1 for path in root.rglob("*") if path.is_file() and (suffix is None or path.suffix == suffix))


def _event_files(vault_root: Path, archived: bool) -> list[Path]:
    events = Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT / EVENTS_SUBFOLDER
    if not events.exists():
        return []
    base = events / ARCHIVE_SUBFOLDER if archived else events
    return [path for path in base.rglob("*.jsonl") if path.is_file()]


def audit_area(vault_root: Path) -> dict:
    integration = Path(vault_root) / STUDY_LOOP_INTEGRATION_ROOT
    sources_files = _count_files(integration / SOURCE_SUBFOLDER, ".md")
    derived_files = _count_files(integration / PLAN_SUBFOLDER) + _count_files(integration / SUMMARY_FOLDER)
    active_events = [path for path in _event_files(vault_root, archived=False) if ARCHIVE_SUBFOLDER not in path.parts]
    archived_events = _event_files(vault_root, archived=True)
    event_bytes = sum(path.stat().st_size for path in active_events)
    return {
        "sourcesFiles": sources_files,
        "derivedFiles": derived_files,
        "eventFiles": len(active_events),
        "eventBytes": event_bytes,
        "archivedEventFiles": len(archived_events),
        "overgrown": len(active_events) > EVENT_FILE_BUDGET or event_bytes > EVENT_BYTE_BUDGET,
    }
