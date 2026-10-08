"""Study Loop source area parser (v0.8).

Parses user-maintained Markdown source files under
`<vault>/_System/Integrations/Study Loop/sources/` into StudyItem-like
dictionaries. The table rows become items deterministically ("table direct"),
without requiring the AI: the user's words and meanings appear verbatim.

Format (matches the v0.8 spec §4.6):

    ---
    type: study-loop-source
    status: active
    updated: 2026-08-25
    ---

    # 知学资料

    ## 词汇

    | 单词/词组 | 释义 | 原文语境 | 来源笔记 |
    |---|---|---|---|
    | pooling layer | 池化层 | Pooling layers in CNNs ... | [[path/to/note|alias]] |
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

STUDY_LOOP_INTEGRATION_ROOT = "_System/Integrations/Study Loop"
SOURCE_SUBFOLDER = "sources"
SOURCE_TYPE = "study-loop-source"
SUPPORTED_SUFFIXES = {".md"}

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_WIKILINK_RE = re.compile(r"^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$")
_TABLE_SEPARATOR_RE = re.compile(r"^[\s|:-]+$")


def parse_frontmatter(text: str) -> dict[str, Any]:
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
        value = value.strip()
        if key and value:
            result[key] = value.strip("\"'")
    return result


def resolve_wikilink(value: str | None) -> str | None:
    if not value:
        return None
    match = _WIKILINK_RE.match(value.strip())
    if not match:
        return None
    path = match.group(1).strip().replace("\\", "/")
    if not path:
        return None
    return path if path.endswith(".md") else f"{path}.md"


def _split_cells(line: str) -> list[str]:
    text = line.strip().strip("|")
    # Protect wikilinks: `[[path|alias]]` contains a pipe that must not split cells.
    placeholders: list[str] = []

    def protect(match: re.Match[str]) -> str:
        placeholders.append(match.group(0))
        return f"\x00{len(placeholders) - 1}\x00"

    protected = re.sub(r"\[\[[^\]]+\]\]", protect, text)
    cells: list[str] = []
    for cell in protected.split("|"):
        cell = cell.strip()
        for index, original in enumerate(placeholders):
            cell = cell.replace(f"\x00{index}\x00", original)
        cells.append(cell)
    return cells


def _parse_table_blocks(markdown: str, *, vocabulary_gaps: bool = False) -> list[tuple[str, list[str], list[list[str]]]]:
    """Returns [(heading, headers, rows)] for each Markdown table block."""
    blocks: list[tuple[str, list[str], list[list[str]]]] = []
    current_heading = ""
    headers: list[str] = []
    rows: list[list[str]] = []
    lines = markdown.splitlines()
    for position, raw_line in enumerate(lines):
        line = raw_line.rstrip()
        if vocabulary_gaps and headers and not line.strip():
            following = position + 1
            while following < len(lines) and not lines[following].strip():
                following += 1
            if following < len(lines) and lines[following].strip().startswith('|'):
                cells = _split_cells(lines[following])
                next_separator = following + 1 < len(lines) and _TABLE_SEPARATOR_RE.match(lines[following + 1].strip())
                if len(cells) == len(headers) and cells != headers and not next_separator and not _TABLE_SEPARATOR_RE.match(lines[following].strip()):
                    continue
        if line.startswith("#"):
            if headers:
                blocks.append((current_heading, headers, rows))
                headers, rows = [], []
            current_heading = line.lstrip("#").strip()
            continue
        if line.strip().startswith("|"):
            cells = _split_cells(line)
            if not cells or all(not cell for cell in cells):
                continue
            if not headers:
                headers = cells
            elif not _TABLE_SEPARATOR_RE.match(line.strip()):
                rows.append(cells)
        elif headers:
            blocks.append((current_heading, headers, rows))
            headers, rows = [], []
    if headers:
        blocks.append((current_heading, headers, rows))
    return blocks


def _item_ability_id(kind: str, word_or_topic: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._:-]+", "-", word_or_topic.strip().lower()).strip("-")
    return f"{kind}:{normalized or 'item'}"


def _vocabulary_item(headers: list[str], cells: list[str]) -> dict[str, Any] | None:
    def column(*names: str) -> str | None:
        for name in names:
            if name in headers:
                index = headers.index(name)
                if index < len(cells) and cells[index]:
                    return cells[index]
        return None

    word = column("单词/词组", "单词", "词组", "word")
    meaning = column("释义", "meaning")
    if not word or not meaning:
        return None
    context = column("原文语境", "语境", "context") or ""
    source_note = resolve_wikilink(column("来源笔记", "来源", "source"))
    item: dict[str, Any] = {
        "word": word,
        "meaning": meaning,
        "context": context,
        # 原文语境兼任例句：三阶段背词的兼容条件是 word+meaning+example，
        # 缺 example 会让来源词卡回落到回忆问答，无法按学科默认出三阶段。
        "example": context,
        "abilityId": _item_ability_id("word", word),
        "kind": "vocabulary",
    }
    if source_note:
        item["sourceNote"] = source_note
    level = column("难度", "level")
    if level:
        item["level"] = level
    return item


def _quiz_item(headers: list[str], cells: list[str]) -> dict[str, Any] | None:
    def column(*names: str) -> str | None:
        for name in names:
            if name in headers:
                index = headers.index(name)
                if index < len(cells) and cells[index]:
                    return cells[index]
        return None

    prompt = column("题干", "问题", "prompt")
    if not prompt:
        return None
    topic = column("主题", "topic") or prompt[:40]
    options_raw = column("选项", "options") or ""
    options = [option.strip() for option in re.split(r"[;；]", options_raw) if option.strip()]
    item: dict[str, Any] = {
        "topic": topic,
        "prompt": prompt,
        "abilityId": _item_ability_id("topic", topic),
        "kind": "quiz",
    }
    if options:
        item["options"] = options
    answer = column("答案", "answer")
    if answer:
        item["answer"] = answer
    explanation = column("解析", "explanation")
    if explanation:
        item["explanation"] = explanation
    return item


def _code_item(headers: list[str], cells: list[str]) -> dict[str, Any] | None:
    """Read approved Python exercises; never execute source code on the server."""
    def column(*names: str) -> str:
        for name in names:
            if name in headers:
                index = headers.index(name)
                if index < len(cells) and cells[index]:
                    return cells[index]
        return ""

    prompt = column("题干", "问题", "prompt")
    initial = column("初始代码", "initialCode")
    tests = column("测试代码", "testCode")
    if not (prompt and initial and tests):
        return None
    topic = column("主题", "topic") or prompt[:40]
    ability = column("能力ID", "abilityId") or column("条目ID", "id", "itemId") or _item_ability_id("code", topic)
    source = resolve_wikilink(column("来源笔记", "sourceNote"))
    state = resolve_wikilink(column("状态记录", "stateRef"))
    item_id = column("条目ID", "id", "itemId") or "python:" + hashlib.sha256(
        f"{source}::{topic}::{prompt}".encode("utf-8")
    ).hexdigest()[:16]
    item: dict[str, Any] = {
        "kind": "code", "domain": "python", "pluginType": "code",
        "id": item_id, "itemId": item_id, "abilityId": ability,
        "topic": topic, "prompt": prompt,
        "initialCode": initial.replace("\\n", "\n"),
        "testCode": tests.replace("\\n", "\n"),
        "solutionCode": column("参考代码", "solutionCode").replace("\\n", "\n"),
        "explanation": column("解析", "explanation"),
    }
    if source:
        item["sourceNote"] = source
    if state:
        item["stateRef"] = state
    return item


def parse_source_text(text: str, path: Path) -> list[dict[str, Any]]:
    """Parse one approved source snapshot while retaining its stable path."""
    frontmatter = parse_frontmatter(text)
    if frontmatter.get("type") != SOURCE_TYPE:
        return []
    if str(frontmatter.get("status", "")).strip().lower() == "inactive":
        return []

    items: list[dict[str, Any]] = []
    for heading, headers, rows in _parse_table_blocks(text):
        lower_heading = heading.lower()
        for cells in rows:
            if len(cells) < len(headers):
                cells = [*cells, *([""] * (len(headers) - len(cells)))]
            if "代码" in lower_heading or "code" in lower_heading or "初始代码" in headers or "initialCode" in headers:
                item = _code_item(headers, cells)
            elif "单词" in lower_heading or "词" in lower_heading or "word" in lower_heading:
                item = _vocabulary_item(headers, cells)
            elif "选择" in lower_heading or "quiz" in lower_heading or "题目" in lower_heading:
                item = _quiz_item(headers, cells)
            else:
                item = _vocabulary_item(headers, cells) or _quiz_item(headers, cells)
            if item is not None:
                item["sourceFile"] = str(path)
                items.append(item)
    return items


def parse_source_file(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        return []
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return []
    return parse_source_text(text, path)


def content_hash(item: dict[str, Any]) -> str:
    canonical = json.dumps(
        {key: item[key] for key in sorted(item) if key not in {"contentHash", "sourceFile"}},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_source_area(vault_root: Path, integration_root: str = STUDY_LOOP_INTEGRATION_ROOT) -> list[dict[str, Any]]:
    """Parses all active study-loop-source files under the sources subfolder."""
    sources_root = Path(vault_root) / integration_root / SOURCE_SUBFOLDER
    if not sources_root.exists():
        return []
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for path in sorted(sources_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        for item in parse_source_file(path):
            digest = content_hash(item)
            if digest in seen:
                continue
            seen.add(digest)
            item["contentHash"] = digest
            items.append(item)
    return items
