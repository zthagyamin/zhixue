"""Replay mapped study events into a learning-state evidence managed block."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from managed_markdown import replace_managed_block

import learning_result

EVIDENCE_BEGIN = "%% ZHIXUE:LEARNING-EVIDENCE:BEGIN %%"
EVIDENCE_END = "%% ZHIXUE:LEARNING-EVIDENCE:END %%"


@dataclass(frozen=True)
class ProjectionResult:
    status: str
    state_ref: str
    ability_id: str
    event_count: int
    latest_at: str | None


def _target(vault_root: Path, state_ref: str) -> Path:
    root = Path(vault_root).resolve()
    candidate = (root / state_ref.replace("\\", "/")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("invalid-state-ref") from error
    if candidate.suffix.lower() != ".md" or not candidate.exists():
        raise ValueError("invalid-state-ref")
    return candidate


def _time(event: dict[str, Any]) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(event.get("occurredAt", "")).replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid-state-event-time") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _correct(event: dict[str, Any]) -> bool:
    attempt = event.get("attempt")
    return bool(isinstance(attempt, dict) and attempt.get("correct") is True and attempt.get("rating") != "again")


def _status(events: list[dict[str, Any]]) -> str:
    successful: list[datetime] = []
    for event in events:
        if _correct(event):
            successful.append(_time(event))
        else:
            successful.clear()
    if not successful:
        return "needs-review"
    if len(successful) >= 2 and (successful[-1] - successful[0]).total_seconds() >= 86_400:
        return "stable-evidence"
    return "reviewed"


def _escape(value: Any, limit: int = 180) -> str:
    return " ".join(str(value or "").split()).replace("|", "\\|")[:limit]


def _render_ability(ability_id: str, events: list[dict[str, Any]], status: str) -> list[str]:
    explanations = {
        "needs-review": "最近一次证据未通过，需要继续复习。",
        "reviewed": "已有一次通过证据，尚需间隔检索确认稳定性。",
        "stable-evidence": "已有至少两次间隔 24 小时以上的通过证据。",
    }
    lines = [
        f"### `{_escape(ability_id)}`",
        "",
        f"**能力标识：** `{_escape(ability_id)}`  ",
        f"**证据状态：** `{status}`  ",
        f"**说明：** {explanations[status]}",
        "",
        "| 时间（UTC） | 事件 | 检索结果 |",
        "|---|---|---|",
    ]
    for event in events[-20:]:
        lines.append(
            f"| {_time(event).isoformat(timespec='seconds')} | {_escape(event.get('eventId'))} | "
            f"{'通过' if _correct(event) else '未通过'} |"
        )
    return lines


def _render(ability_events: dict[str, list[dict[str, Any]]]) -> str:
    sections: list[str] = []
    for ability_id in sorted(ability_events):
        events = ability_events[ability_id]
        sections.append("\n".join(_render_ability(ability_id, events, _status(events))))
    return "\n\n".join(sections)


def project_mapped_events(
    vault_root: Path,
    state_ref: str,
    ability_id: str,
    events: list[dict[str, Any]],
    ability_events: dict[str, list[dict[str, Any]]] | None = None,
    expected_text: str | None = None,
) -> ProjectionResult:
    if not ability_id.strip():
        raise ValueError("invalid-ability-id")
    path = _target(vault_root, state_ref)
    with path.open("r", encoding="utf-8", newline="") as handle:
        original = handle.read()
    if expected_text is not None and original != expected_text:
        raise ValueError('stale-vault-edit')
    frontmatter = learning_result._parse_frontmatter(original)
    if frontmatter.get("type") not in {"learning-state", "paper-note", "project", "review", "zhixue-practice-state"}:
        raise ValueError("invalid-learning-state-note")
    ordered = sorted(
        [event for event in events if isinstance(event, dict) and event.get("eventType") == "practice-attempt"],
        key=lambda event: (_time(event), str(event.get("eventId", ""))),
    )
    grouped = ability_events or {ability_id: ordered}
    normalized_groups = {
        key: sorted(
            [event for event in values if isinstance(event, dict) and event.get("eventType") == "practice-attempt"],
            key=lambda event: (_time(event), str(event.get("eventId", ""))),
        )
        for key, values in grouped.items()
        if isinstance(key, str) and key.strip()
    }
    normalized_groups[ability_id] = ordered
    status = _status(ordered)
    updated = replace_managed_block(original, EVIDENCE_BEGIN, EVIDENCE_END, _render(normalized_groups))
    temporary = path.with_name(f".{path.name}.zhixue.tmp")
    temporary.write_text(updated, encoding="utf-8", newline="")
    if path.read_bytes() != original.encode('utf-8'):
        temporary.unlink(missing_ok=True)
        raise ValueError('stale-vault-edit')
    temporary.replace(path)
    return ProjectionResult(
        status=status,
        state_ref=state_ref.replace("\\", "/"),
        ability_id=ability_id,
        event_count=len(ordered),
        latest_at=_time(ordered[-1]).isoformat(timespec="seconds") if ordered else None,
    )


def _normalize_item_id(value: str | None) -> str:
    text = str(value or "").strip()
    if text.startswith("practice:"):
        text = text[len("practice:"):]
    return text


def _normalize_state_ref(value: str | None) -> str:
    text = str(value or "").strip()
    if text.startswith("[[") and text.endswith("]]"):
        text = text[2:-2].strip()
        if "|" in text:
            text = text.split("|", 1)[0].strip()
    if text.lower().endswith(".md"):
        text = text[:-3]
    return text


def result_card_for_state(vault_root: Path, state_ref: str, item_id: str | None = None, ability_id: str | None = None) -> str | None:
    """Return the learning result card's relative path for a practice event.

    Matches the card whose ``itemId`` equals ``item_id`` first when an item id
    is provided, then falls back only to a unique ``stateRef + abilityId``
    match. A state record alone never identifies an ability. A leading ``practice:``
    item-key prefix is ignored, and state refs are compared without wikilink
    brackets or a trailing ``.md`` (the website sends ``...md`` while cards
    store the wikilink target without the suffix). Returns None when nothing
    matches.
    """
    cards = learning_result.parse_result_cards(vault_root)
    normalized_item_id = _normalize_item_id(item_id) if item_id else ""
    if normalized_item_id:
        exact = [card for card in cards if _normalize_item_id(card["itemId"]) == normalized_item_id]
        if len(exact) == 1:
            card = exact[0]
            if ability_id and card["abilityId"] != ability_id:
                return None
            if state_ref and _normalize_state_ref(card["stateRef"]) != _normalize_state_ref(state_ref):
                return None
            return card["path"]
        if exact:
            return None
    normalized_state_ref = _normalize_state_ref(state_ref)
    if not normalized_state_ref or not ability_id:
        return None
    matches = [card for card in cards if _normalize_state_ref(card["stateRef"]) == normalized_state_ref and card["abilityId"] == ability_id]
    return matches[0]["path"] if len(matches) == 1 else None
