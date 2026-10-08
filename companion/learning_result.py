"""Parse indexed learning result cards, with legacy central-directory compatibility."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

RESULT_DIR_RELATIVE = Path("01 学习/学习结果")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_WIKILINK_RE = re.compile(r"^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$")
_REVIEW_POINTS_RE = re.compile(r"(?ms)^(?:#{1,2}[ \t]*)?复习要点[：:]*[^\r\n]*\r?\n(.*?)(?=^#{1,2}[ \t]|\Z)")
_REVIEW_POINT_ITEM_RE = re.compile(r"^\s*[-*]\s+(.+)$")


def result_cards_root(vault_root: Path) -> Path:
    return Path(vault_root) / RESULT_DIR_RELATIVE


def wikilink_target(value: str) -> str | None:
    match = _WIKILINK_RE.match(value.strip())
    if not match:
        return None
    return match.group(1).strip()


def _parse_frontmatter(text: str) -> dict[str, Any]:
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}
    result: dict[str, Any] = {}
    for raw_line in match.group(1).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip("\"'")
        if value in {"true", "false"}:
            value = value == "true"
        if key and value != "":
            result[key] = value
    return result


def _review_points(body: str) -> list[str]:
    # Machine queue rows are scheduling metadata, never reference-answer material.
    body = re.sub(r'(?ms)^%% ZHIXUE:REVIEW-QUEUE:BEGIN %%[^\r\n]*\r?\n.*?^%% ZHIXUE:REVIEW-QUEUE:END %%[^\r\n]*', '', body)
    match = _REVIEW_POINTS_RE.search(body)
    if not match:
        return []
    return [m.group(1).strip() for m in _REVIEW_POINTS_RE_ITEM_RE.finditer(match.group(1))]


_REVIEW_POINTS_RE_ITEM_RE = re.compile(r"^\s*[-*]\s+(.+)$", re.MULTILINE)


def card_title(body: str, fallback: str) -> str:
    match = re.search(r"(?m)^#\s+(.+)$", body)
    return match.group(1).strip() if match else fallback


def parse_result_cards(vault_root: Path) -> list[dict[str, Any]]:
    import index_gateway
    if (Path(vault_root) / index_gateway.GATEWAY_ROOT).exists():
        paths = index_gateway.indexed_result_paths(vault_root)
    else:
        root = result_cards_root(vault_root)
        paths = sorted(root.glob("*.md")) if root.is_dir() else []
    return [card for path in paths if (card := parse_result_file(vault_root, path)) is not None]


def parse_result_file(vault_root: Path, path: Path) -> dict[str, Any] | None:
    """Pure parser: does not discover files or call the gateway."""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    meta = _parse_frontmatter(text)
    if meta.get("type") != "learning-result" or not meta.get("item_id") or not meta.get("ability_id"):
        return None
    return {
        "path": str(path.relative_to(vault_root).as_posix()),
        "title": card_title(text, path.stem),
        "domain": str(meta.get("domain", "")),
        "itemId": str(meta.get("item_id", "")),
        "abilityId": str(meta.get("ability_id", "")),
        "reviewDate": str(meta.get("review_date", "")),
        "reviewEnabled": bool(meta.get("review_enabled", True)),
        "sourceNote": wikilink_target(str(meta.get("source_note", ""))) or "",
        "stateRef": wikilink_target(str(meta.get("state_ref", ""))) or "",
        "reviewPoints": _review_points(text),
        "pluginHint": meta.get("plugin_hint"),
    }
