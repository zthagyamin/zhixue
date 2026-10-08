"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations

import re
from pathlib import Path
from datetime import date
from typing import Any


def parse_frontmatter_scalar(raw: str) -> Any:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none", "~"}:
        return None
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    if not path.exists() or path.suffix.lower() != ".md":
        return {}, ""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    properties: dict[str, Any] = {}
    current_list: str | None = None
    end_index = 0
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = index
            break
        if current_list and re.match(r"^\s+-\s+", line):
            properties[current_list].append(parse_frontmatter_scalar(re.sub(r"^\s+-\s+", "", line)))
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not match:
            current_list = None
            continue
        key, raw = match.groups()
        if raw.strip():
            properties[key] = parse_frontmatter_scalar(raw)
            current_list = None
        else:
            properties[key] = []
            current_list = key
    body = "\n".join(lines[end_index + 1:]) if end_index else text
    return properties, body


def note_title(path: Path, body: str) -> str:
    match = re.search(r"^#\s+(.+)$", body, flags=re.MULTILINE)
    return match.group(1).strip() if match else path.stem


def safe_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def extract_text(path: Path, page_limit: int = 8, *, selected_pages) -> str:
    if not path.exists():
        raise FileNotFoundError(f"未找到学习来源：{path}")
    if path.suffix.lower() in {".md", ".txt"}:
        return path.read_text(encoding="utf-8-sig", errors="replace")[:80_000]
    if path.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise RuntimeError("读取 PDF 需要先安装 companion/requirements.txt") from error
        reader = PdfReader(str(path))
        selected = selected_pages()
        if selected:
            indexes = [int(page) - 1 for page in selected if 0 < int(page) <= len(reader.pages)]
        else:
            indexes = list(range(min(page_limit, len(reader.pages))))
        return "\n\n".join((reader.pages[index].extract_text() or "") for index in indexes)[:80_000]
    raise ValueError("第一版同步支持 Markdown、TXT 和 PDF。")


def supported_note_files(root: Path, *, SUPPORTED_NOTE_SUFFIXES) -> list[Path]:
    if not root.exists():
        return []
    items: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_NOTE_SUFFIXES:
            continue
        relative_parts = path.relative_to(root).parts
        if relative_parts[:4] == ("_System", "Integrations", "Study Loop", "mapped"):
            continue
        if any(part.startswith(".") or part in {"node_modules", "__pycache__"} for part in relative_parts):
            continue
        items.append(path)
    return items
