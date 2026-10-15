"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations

import re
import io
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from datetime import date
from typing import Any
from companion_setup import redirects_path

TEXT_EXCERPT_CHARS = 80_000
PDF_INPUT_BYTES = 20_000_000
METADATA_INPUT_BYTES = 20_000_000


class LegacySourceLimitError(ValueError):
    pass


def checked_literal_path(path: Path) -> Path:
    """Check a selected Path; only configuration strings may expand variables."""
    selected = Path(path).absolute()
    for part in (*reversed(selected.parents), selected):
        if part.exists() or part.is_symlink():
            if redirects_path(part.lstat()):
                raise ValueError('setup-linked-path')
    if selected.resolve() != selected:
        raise ValueError('source-noncanonical-path')
    return selected


@contextmanager
def checked_source_file(path: Path, mode='rb', **options):
    """Open an explicitly selected regular file without accepting name redirection."""
    selected = checked_literal_path(path)
    before = selected.lstat()
    if redirects_path(before) or not stat.S_ISREG(before.st_mode):
        raise ValueError('学习来源不是可直接读取的普通文件。')
    with selected.open(mode, **options) as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('学习来源在打开时发生变化，请重试。')
        checked_literal_path(selected)
        yield stream
        current = selected.lstat()
        checked_literal_path(selected)
        if redirects_path(current) or (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise ValueError('学习来源在读取时发生变化，请重试。')


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


def read_complete_source_text(path: Path, limit: int = METADATA_INPUT_BYTES) -> str:
    """Read a full approved-source candidate or fail; never approve a prefix."""
    with checked_source_file(path, 'r', encoding='utf-8-sig', errors='replace') as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            raise LegacySourceLimitError('资料文件超过完整读取上限，请拆分后重试；未批准部分内容。')
        text = stream.read(limit + 1)
        if len(text) > limit:
            raise LegacySourceLimitError('资料文件超过完整读取上限，请拆分后重试；未批准部分内容。')
    return text


def read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    if not path.exists() or path.suffix.lower() != ".md":
        return {}, ""
    try:
        with checked_source_file(path, 'r', encoding='utf-8-sig', errors='replace') as stream:
            if os.fstat(stream.fileno()).st_size > METADATA_INPUT_BYTES:
                raise LegacySourceLimitError('资料元数据文件过大，请拆分后读取；未生成部分状态。')
            text = stream.read(METADATA_INPUT_BYTES + 1)
            if len(text) > METADATA_INPUT_BYTES:
                raise LegacySourceLimitError('资料元数据文件过大，请拆分后读取；未生成部分状态。')
    except LegacySourceLimitError:
        raise
    except (OSError, ValueError):
        return {}, ""
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
        with checked_source_file(path, 'r', encoding='utf-8-sig', errors='replace') as stream:
            return stream.read(TEXT_EXCERPT_CHARS)
    if path.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise RuntimeError("读取 PDF 需要先安装 companion/requirements.txt") from error
        with checked_source_file(path) as stream:
            if os.fstat(stream.fileno()).st_size > PDF_INPUT_BYTES:
                raise ValueError('PDF 超过单次 20 MB 读取上限，请按章节拆分后重试。')
            raw = stream.read(PDF_INPUT_BYTES + 1)
            if len(raw) > PDF_INPUT_BYTES:
                raise ValueError('PDF 超过单次 20 MB 读取上限，请按章节拆分后重试。')
        reader = PdfReader(io.BytesIO(raw))
        selected = selected_pages()
        if selected:
            indexes = [int(page) - 1 for page in selected if 0 < int(page) <= len(reader.pages)]
        else:
            indexes = list(range(min(page_limit, len(reader.pages))))
        parts = []
        used = 0
        for index in indexes:
            text = ('\n\n' if parts else '') + (reader.pages[index].extract_text() or '')
            remaining = TEXT_EXCERPT_CHARS - used
            parts.append(text[:remaining])
            used += len(parts[-1])
            if used == TEXT_EXCERPT_CHARS:
                break
        return ''.join(parts)
    raise ValueError("第一版同步支持 Markdown、TXT 和 PDF。")


def supported_note_files(root: Path, *, SUPPORTED_NOTE_SUFFIXES) -> list[Path]:
    if not root.exists():
        return []
    items: list[Path] = []
    try:
        checked_literal_path(root)
    except (OSError, ValueError):
        return []
    for folder, directories, filenames in os.walk(root, followlinks=False):
        base = Path(folder)
        retained = []
        for name in directories:
            path = base / name
            try:
                if name.startswith('.') or name in {'node_modules', '__pycache__'} or redirects_path(path.lstat()):
                    continue
                if path.relative_to(root).parts[:4] == ('_System', 'Integrations', 'Study Loop', 'mapped'):
                    continue
                checked_literal_path(path)
                retained.append(name)
            except (OSError, ValueError):
                continue
        directories[:] = retained
        for name in filenames:
            path = base / name
            if name.startswith('.') or path.suffix.lower() not in SUPPORTED_NOTE_SUFFIXES:
                continue
            try:
                if redirects_path(path.lstat()) or not path.is_file():
                    continue
                checked_literal_path(path)
            except (OSError, ValueError):
                continue
            items.append(path)
    return items
