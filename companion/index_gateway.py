"""Versioned, fixed-entry Markdown catalog. Content stays in subject directories."""
from __future__ import annotations
from study_day import current_study_day, calendar_day

import hashlib
import json
import re
import threading
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

import source_area
from managed_markdown import replace_managed_block
import learning_support

GATEWAY_ROOT = Path("_System/Integrations/Study Loop/gateway")
SCHEMA_VERSION = 1
PLUGINS = {"three-stage", "quiz", "recall", "calculation", "code", "flashcard", "spelling"}
FORMATS = {"vocabulary", "quiz", "code", "recall", "calculation", "flashcard", "learning-result", "study-loop-source", "mapped-json"}
AUTO_TYPES = {"vocabulary-database": "vocabulary", "vocabulary-session": "vocabulary", "learning-result": "learning-result", "study-loop-source": "study-loop-source"}
EXCLUDED = {"_archive", "archive", "backups", "_backups", "node_modules", "__pycache__", ".git", ".obsidian"}
INDEX_BEGIN = "%% ZHIXUE:GATEWAY-INDEX:BEGIN %%"
INDEX_END = "%% ZHIXUE:GATEWAY-INDEX:END %%"
LOCK = threading.RLock()
_READ_PATHS: ContextVar[dict | None] = ContextVar('gateway_read_paths', default=None)


def _resolved(path: Path) -> Path:
    """Reuse canonical paths only during one read-only catalog build."""
    path = Path(path)
    cache = _READ_PATHS.get()
    if cache is None:
        return path.resolve()
    if path not in cache:
        cache[path] = path.resolve()
    return cache[path]


class GatewayError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


def _read(path: Path) -> str:
    if path.stat().st_size > 2_000_000:
        raise GatewayError("file-too-large", "索引内容文件超过 2MB，请按学习单元拆分。")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return handle.read()


def _meta(text: str) -> dict[str, str]:
    return source_area.parse_frontmatter(text.lstrip("\ufeff").replace("\r\n", "\n"))


def _boolean(meta: dict[str, Any], key: str, default: bool) -> bool:
    raw = str(meta.get(key, str(default))).lower()
    if raw not in {"true", "false"}:
        raise GatewayError("invalid-property", f"{key} 必须是 true 或 false。")
    return raw == "true"


def _path(vault_root: Path, value: str, *, directory: bool = False, must_exist: bool = True) -> Path:
    root = _resolved(vault_root)
    value = value.strip().replace("\\", "/")
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value) or "://" in value or any(part in {".", ".."} for part in value.split("/")):
        raise GatewayError("invalid-path", "必须使用学习库内的明确相对路径。")
    if value.startswith('_System/Integrations/Study Loop/mapped/'):
        from mapped_source_registry import _safe
        _safe(root, root / value)
    target = _resolved(root / value)
    try:
        relative = target.relative_to(root)
    except ValueError as error:
        raise GatewayError("outside-vault", "引用不能逃出学习库。") from error
    if not relative.parts or any(part.lower() in EXCLUDED or part.startswith(".") for part in relative.parts):
        raise GatewayError("excluded-path", "归档、备份或隐藏目录不能作为活动学习入口。")
    if must_exist and not (target.is_dir() if directory else target.is_file()):
        raise GatewayError("missing-reference", f"引用不存在：{value}")
    return target


def _link(ref: str) -> tuple[str, str]:
    raw = ref.strip().removeprefix("!")
    links = re.findall(r'\[\[[^\[\]]+\]\]', raw)
    if len(links) > 1:
        raise GatewayError('ambiguous-reference', '同一引用单元包含多个目标，请明确指定一个来源或状态。')
    if len(links) == 1:
        raw = links[0]
    if raw.startswith("[[") and raw.endswith("]]"):
        raw = raw[2:-2].replace("\\|", "|").split("|", 1)[0]
    elif re.fullmatch(r"\[[^\]]*\]\([^)]+\)", raw):
        raw = unquote(raw.split("](", 1)[1][:-1])
    path, _, fragment = raw.partition("#")
    if Path(path).suffix.lower() in {".pdf", ".png", ".jpg", ".docx", ".xlsx", ".exe", ".zip"}:
        raise GatewayError("unsupported-file", "当前入口内容需为 Markdown；其他资源应由正文链接保留。")
    if not path.lower().endswith(".md"):
        path += ".md"
    if Path(path).suffix.lower() != ".md":
        raise GatewayError("unsupported-file", "当前入口内容需为 Markdown；其他资源应由正文链接保留。")
    return path, fragment


def _fragment(text: str, fragment: str) -> str:
    if not fragment:
        return text
    lines = text.splitlines()
    if fragment.startswith("^"):
        block_id = fragment[1:]
        matches = [i for i, line in enumerate(lines) if re.search(r"\^" + re.escape(block_id) + r"\s*$", line)]
        if len(matches) != 1:
            raise GatewayError("ambiguous-reference", "块引用不存在或不唯一。")
        end = matches[0]
        last = re.sub(r"\s*\^" + re.escape(block_id) + r"\s*$", "", lines[end])
        start = end
        if not last.strip():
            start -= 1
            while start >= 0 and not lines[start].strip():
                start -= 1
        while start > 0 and lines[start - 1].strip() and not lines[start - 1].startswith("#"):
            start -= 1
        block = lines[max(start, 0):end] + ([last] if last.strip() else [])
        return "\n".join(block)
    wanted = fragment.split("#")
    stack: list[tuple[int, str]] = []
    matches: list[tuple[int, int]] = []
    for i, line in enumerate(lines):
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if not heading:
            continue
        level, title = len(heading[1]), heading[2]
        stack = [(depth, text) for depth, text in stack if depth < level]
        stack.append((level, title))
        titles = [title for _, title in stack]
        if titles[-len(wanted):] == wanted:
            matches.append((i, level))
    if len(matches) != 1:
        raise GatewayError("ambiguous-reference", "标题引用不存在或不唯一。")
    start, level = matches[0]
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^#{1," + str(level) + r"}\s", lines[i])), len(lines))
    return "\n".join(lines[start:end])


def resolve_reference(vault_root: Path, ref: str, relative_to: Path | None = None) -> tuple[Path, str]:
    relative, fragment = _link(ref)
    target = _path(vault_root, relative, must_exist=False)
    if relative_to is not None and not target.exists():
        local_name = (relative_to.relative_to(vault_root) / relative).as_posix()
        target = _path(vault_root, local_name)
    else:
        target = _path(vault_root, relative)
    return target, _fragment(_read(target), fragment)


def _relative(vault_root: Path, path: Path) -> str:
    return _resolved(path).relative_to(_resolved(vault_root)).as_posix()


def _diagnostic(errors: list[dict], error: Exception, ref: str) -> None:
    errors.append({"code": getattr(error, "code", "invalid-index"), "message": str(error), "reference": ref})


def _without_generated(text: str) -> str:
    if text.count(INDEX_BEGIN) != text.count(INDEX_END) or text.count(INDEX_BEGIN) > 1:
        raise GatewayError("invalid-index-block", "索引自动区域的标记不完整或重复。")
    return re.sub(re.escape(INDEX_BEGIN) + r".*?" + re.escape(INDEX_END), "", text, flags=re.S)


def _assistance_roots(vault: Path) -> tuple[Path, ...]:
    """Reserved generated folders, not a global ban on a subject named assistance."""
    roots = []
    for entry in sorted((vault / GATEWAY_ROOT / 'subjects').glob('*.md')):
        try:
            path = _path(vault, _relative(vault, entry)); meta = _meta(_read(path))
            if meta.get('type') != 'zhixue-subject-index' or meta.get('schema_version') != str(SCHEMA_VERSION):
                continue
            content = _path(vault, meta.get('content_root', ''), directory=True)
            records = _path(vault, meta.get('records_root', ''), directory=True, must_exist=False)
            if records.is_relative_to(content): roots.append(_resolved(records / 'assistance'))
        except (ValueError, OSError):
            continue
    return tuple(roots)


def is_assistance_source(path: Path, roots: tuple[Path, ...]) -> bool:
    resolved = _resolved(path)
    return any(resolved.is_relative_to(root) for root in roots)


def _references(vault: Path, meta: dict, index_text: str, content_root: Path, errors: list[dict], assistance_roots: tuple[Path, ...] = ()) -> list[dict]:
    refs: list[dict] = []
    explicit_files: set[Path] = set()
    seen: set[tuple[Path, str]] = set()
    for _, headers, rows in source_area._parse_table_blocks(_without_generated(index_text)):
        if "content_ref" not in headers:
            continue
        for cells in rows:
            row = dict(zip(headers, cells))
            if row.get("content_ref"):
                try:
                    relative, fragment = _link(row["content_ref"])
                    path = _path(vault, relative, must_exist=False)
                    if is_assistance_source(path, assistance_roots):
                        continue
                    if path.is_file() and _meta(_read(path)).get('type') == 'zhixue-assistance-summary':
                        continue
                    explicit_files.add(path)
                    if (path, fragment) not in seen:
                        refs.append({"id": row.get("id", ""), "contentRef": row["content_ref"], "format": row.get("format", ""), "stateRef": row.get("state_ref", "")})
                        seen.add((path, fragment))
                except ValueError as error:
                    _diagnostic(errors, error, row["content_ref"])
    if _boolean(meta, "auto", True):
        for path in sorted(content_root.rglob("*.md")):
            rel = path.relative_to(content_root)
            if any(part.startswith(".") or part.lower() in EXCLUDED for part in rel.parts):
                continue
            resolved = _resolved(path)
            if is_assistance_source(resolved, assistance_roots):
                continue
            try:
                resolved.relative_to(_resolved(content_root))
            except ValueError:
                continue
            if resolved in explicit_files:
                continue
            try:
                # Read metadata first: a large, unrelated original note is not a source error.
                with path.open("r", encoding="utf-8-sig") as handle:
                    fields = _meta(handle.read(8192))
                if str(fields.get("status", "")).lower() in {"draft", "inactive", "archived", "retired"} or fields.get("quality_status") == "draft":
                    continue
                kind = fields.get("type", "")
                if kind == 'zhixue-assistance-summary':
                    continue
                fmt = fields.get("zhixue_format") if _boolean(fields, "zhixue", False) else AUTO_TYPES.get(kind)
                if not fmt:
                    continue
                _read(path)
                refs.append({"id": fields.get("zhixue_id", ""), "contentRef": f"[[{_relative(vault, path)}]]", "format": fmt, "stateRef": fields.get("state_ref", "")})
            except (OSError, UnicodeError, ValueError) as error:
                _diagnostic(errors, error, path.relative_to(vault).as_posix())
    return refs


def _definitions(vault: Path, extra_subject_indexes=(), entry_ref=None) -> dict:
    entry_ref = entry_ref or (GATEWAY_ROOT / "index.md").as_posix()
    entry = vault / entry_ref
    active = entry.parent.exists()
    catalog = {"active": active, "subjects": [], "definitions": [], "references": [], "diagnostics": [], "schemaVersion": SCHEMA_VERSION, "mode": "indexed" if active else "legacy"}
    if entry_ref != (GATEWAY_ROOT / "index.md").as_posix():
        catalog.update(entryRef=entry_ref, legacyCoexistence=True)
    if not active:
        return catalog
    errors = catalog["diagnostics"]
    try:
        entry = _path(vault, entry_ref)
        top = _meta(_read(entry))
        if top.get("type") != "zhixue-gateway" or top.get("schema_version") != str(SCHEMA_VERSION):
            raise GatewayError("unsupported-version", "入口协议不受支持；请使用 schema_version: 1。")
        if not _boolean(top, "enabled", True):
            return catalog
    except (OSError, ValueError) as error:
        _diagnostic(errors, error, entry_ref)
        return catalog
    seen: set[str] = set()
    assistance_roots = _assistance_roots(vault)
    for index_path in sorted([*(vault / GATEWAY_ROOT / "subjects").glob("*.md"), *extra_subject_indexes]):
        index_label = _relative(vault, index_path)
        try:
            index_path = _path(vault, index_label)
            original = _read(index_path)
            meta = _meta(original)
            if meta.get("type") != "zhixue-subject-index" or not _boolean(meta, "enabled", True):
                continue
            if meta.get("schema_version") != str(SCHEMA_VERSION):
                raise GatewayError("unsupported-version", "学科索引协议需为版本 1。")
            subject_id = meta.get("subject_id", "")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", subject_id) and not (index_path in extra_subject_indexes and re.fullmatch(r"mapped:[a-zA-Z0-9_-]{1,80}", subject_id)):
                raise GatewayError("invalid-subject-id", "subject_id 需为稳定的字母数字标识。")
            if subject_id in seen:
                raise GatewayError("duplicate-subject-id", f"学科 ID 重复：{subject_id}")
            seen.add(subject_id)
            plugin = meta.get("plugin", "")
            if plugin not in PLUGINS:
                raise GatewayError("unsupported-plugin", f"尚不支持学习方式：{plugin}")
            content_root = _path(vault, meta.get("content_root", ""), directory=True)
            progress, _ = resolve_reference(vault, meta.get("progress_ref", ""))
            if _meta(_read(progress)).get("type") != "zhixue-practice-state":
                raise GatewayError("invalid-progress-target", "默认 progress_ref 必须指向 zhixue-practice-state，不得将原文当作进度文件。")
            records = _path(vault, meta.get("records_root", ""), directory=True, must_exist=False)
            if records.exists() and not records.is_dir():
                raise GatewayError("invalid-record-location", "records_root 必须是目录。")
            try:
                progress.relative_to(content_root)
                records.relative_to(content_root)
            except ValueError as error:
                raise GatewayError("invalid-record-location", "进度与学习记录必须位于当前学科目录。") from error
            identity = meta.get("identity", "scoped")
            if identity not in {"scoped", "legacy"}:
                raise GatewayError("invalid-identity", "identity 仅支持 scoped 或 legacy。")
            refs = _references(vault, meta, original, content_root, errors, (*assistance_roots, _resolved(records / 'assistance')))
            definition = {"id": subject_id, "name": meta.get("name", subject_id), "domain": meta.get("domain", subject_id), "pluginType": plugin,
                          "identity": identity, "sourceMode": "gateway", "contentRoot": _relative(vault, content_root), "progressRef": _relative(vault, progress),
                          "recordsRoot": _relative(vault, records), "indexPath": index_path, "indexText": original, "refs": refs,
                          "groupQuota": int(meta.get("group_size", "20"))}
            if not 1 <= definition["groupQuota"] <= 500:
                raise GatewayError("invalid-group-size", "group_size 必须在 1 到 500 之间。")
            catalog["definitions"].append(definition)
            catalog["references"].extend({**ref, "subjectId": subject_id} for ref in refs)
        except (OSError, ValueError) as error:
            _diagnostic(errors, error, index_label)
    return catalog


def indexed_result_paths(vault_root: Path) -> list[Path]:
    vault = _resolved(vault_root)
    catalog = _definitions(vault)
    paths: list[Path] = []
    for ref in catalog["references"]:
        try:
            path, _ = resolve_reference(vault, ref["contentRef"])
            fields = _meta(_read(path))
            fmt = ref["format"] or fields.get("zhixue_format") or AUTO_TYPES.get(fields.get("type"))
            if fmt != "learning-result":
                continue
            if path not in paths:
                paths.append(path)
        except ValueError:
            continue
    return paths


def _column(headers: list[str], cells: list[str], *names: str) -> str:
    normalized = {re.sub(r"\s+", "", header).lower(): i for i, header in enumerate(headers)}
    for name in names:
        index = normalized.get(re.sub(r"\s+", "", name).lower())
        if index is not None and index < len(cells) and cells[index]:
            return cells[index].strip()
    return ""


def _table_items(text: str, fmt: str, subject: dict, doc_id: str) -> list[dict]:
    result: list[dict] = []
    for _, headers, rows in source_area._parse_table_blocks(text, vocabulary_gaps=fmt in {'vocabulary', 'study-loop-source'}):
        for cells in rows:
            col = lambda *names: _column(headers, cells, *names)
            word = col("单词/词组", "单词", "词组", "word")
            mode = fmt
            if fmt == "study-loop-source":
                mode = "vocabulary" if word else "code" if col("初始代码", "initialCode") else "quiz"
            if mode == "vocabulary":
                meaning = col("释义", "meaning")
                if not word or not meaning:
                    continue
                key = source_area._item_ability_id("word", word)
                if subject["identity"] != "legacy":
                    normalized = " ".join(word.casefold().split())
                    suffix = quote(normalized, safe="-_.~")
                    if len(suffix) > 75:
                        suffix = hashlib.sha256(normalized.encode()).hexdigest()[:24]
                    key = f"word:{subject['id']}:{suffix}"
                context = col("原文语境", "原文语境(Context)", "语境", "context", "example")
                result.append({"word": word, "meaning": meaning, "context": context, "example": context, "abilityId": key, "itemId": key, "kind": "vocabulary", "pluginType": "three-stage",
                               "sourceNote": col("来源笔记", "sourceNote", "source"), "stateRef": col("状态记录", "stateRef", "state_ref")})
                learning_config=col('学习配置','learningSupport')
                if learning_config:
                    if len(learning_config)>16000:raise ValueError('learning-support-too-large')
                    support=learning_support.parse_learning_support(json.loads(learning_config),'spelling')
                    if support['word']!=word:raise ValueError('spelling-mapping-mismatch')
                    result[-1].update(learningSupport=support,pluginType='spelling')
                continue
            prompt = col("题干", "问题", "prompt", "正面", "front")
            if not prompt:
                continue
            raw_id = col("ID", "条目ID", "item_id", "itemId")
            ability = col("能力ID", "ability_id", "abilityId")
            if subject["identity"] == "legacy":
                item_id = raw_id or ability or source_area._item_ability_id("topic", col("主题", "topic") or prompt[:40])
            elif not raw_id or not doc_id:
                raise GatewayError("missing-stable-id", "新内容需要 zhixue_id（或索引 id）及每题独立 ID。")
            else:
                item_id = f"{subject['id']}:{doc_id}:{raw_id}"
                if ability:
                    ability = f"{subject['id']}:{ability}"
            item = {"itemId": item_id, "id": item_id, "abilityId": ability or item_id, "topic": col("主题", "topic") or prompt[:80], "prompt": prompt,
                    "pluginType": mode, "explanation": col("解析", "explanation"), "kind": mode, "sourceNote": col("来源笔记", "sourceNote", "source")}
            item['planningLabel'] = col('主题', 'topic')
            learning_config=col('学习配置','learningSupport')
            if learning_config:
                if len(learning_config)>16000:raise ValueError('learning-support-too-large')
                item['learningSupport']=learning_support.parse_learning_support(json.loads(learning_config),mode)
            if mode=='quiz' and item.get('learningSupport',{}).get('type')=='quiz':
                if col('选项','options') or col('答案','answer'):raise ValueError('duplicate-quiz-answer-source')
            elif mode == "quiz":
                options = [value.strip() for value in re.split(r"[;；]", col("选项", "options")) if value.strip()]
                answer = col("答案", "answer")
                if answer not in options and answer.isdigit() and int(answer) < len(options):
                    answer = options[int(answer)]
                if len(options) < 2 or answer not in options:
                    raise GatewayError("invalid-quiz", "选择题需要至少两个选项及可匹配的答案。")
                item.update(options=options, answer=answer)
            elif mode == "code":
                initial, tests = col("初始代码", "initialCode"), col("测试代码", "testCode")
                item.update(initialCode=initial.replace("\\n", "\n"), testCode=tests.replace("\\n", "\n"), solutionCode=col("参考代码", "solutionCode").replace("\\n", "\n"))
                if not learning_support.has_executable_code_material(item):
                    raise GatewayError("invalid-code-item", "代码题缺少初始代码或测试代码。")
            elif mode == "flashcard":
                item.update(front=prompt, back=col("背面", "back", "答案", "answer"))
            else:
                item["answer"] = col("参考答案", "答案", "answer")
            state = col("状态记录", "stateRef", "state_ref")
            if state:
                item["stateRef"] = state
            result.append(item)
    return result


def _update_index(path: Path, expected: str, lines: list[str]) -> None:
    body = "## 自动收录引用\n\n| id | content_ref | format |\n|---|---|---|\n" + "\n".join(lines)
    updated = replace_managed_block(expected, INDEX_BEGIN, INDEX_END, body)
    if updated == expected:
        return
    if _read(path) != expected:
        raise GatewayError("index-edit-conflict", "索引正在编辑，本轮没有覆盖。")
    temporary = path.with_name(f".{path.name}.gateway.tmp")
    temporary.write_text(updated, encoding="utf-8", newline="")
    temporary.replace(path)


def load_gateway(vault_root: Path, refresh: bool = False, *, extra_subject_indexes=(), entry_ref=None) -> dict:
    # Never retain resolved paths across requests, nor cache write/refresh validation.
    token = _READ_PATHS.set(None if refresh else {})
    try:
        return _load_gateway(vault_root, refresh, extra_subject_indexes, entry_ref)
    finally:
        _READ_PATHS.reset(token)


def _load_gateway(vault_root: Path, refresh: bool, extra_subject_indexes=(), entry_ref=None) -> dict:
    vault = _resolved(vault_root)
    with LOCK:
        catalog = _definitions(vault, extra_subject_indexes, entry_ref)
        catalog.update(bindings={}, resultCards=[], practiceItems=[], recordRoots=[{key: definition[key] for key in ('contentRoot','recordsRoot')} for definition in catalog['definitions']])
        collisions: set[str] = set()
        assistance_fingerprints = {}
        for definition in catalog["definitions"]:
            subject = {key: definition[key] for key in ("id", "name", "domain", "pluginType", "identity", "sourceMode", "groupQuota")}
            subject["eventDomain"] = subject["domain"] if subject["domain"] in {"ielts", "python", "differential-review"} else "differential-review"
            subject["items"] = []
            index_rows: list[str] = []
            for ref in definition["refs"]:
                try:
                    path, text = resolve_reference(vault, ref["contentRef"])
                    fields = _meta(_read(path))
                    fmt = ref["format"] or fields.get("zhixue_format") or AUTO_TYPES.get(fields.get("type"))
                    if fmt not in FORMATS:
                        raise GatewayError("unsupported-format", f"尚不支持内容格式：{fmt}")
                    card = None
                    practice = None
                    if fmt == "learning-result":
                        import learning_result
                        import practice_engine
                        card = learning_result.parse_result_file(vault, path)
                        if card is None:
                            raise GatewayError("invalid-result-card", "学习结果卡字段不完整。")
                        card["subjectId"] = subject["id"]
                        practice = practice_engine.build_base_item(card, {})
                        practice.update(sourceNote=card["sourceNote"], stateRef=card["stateRef"], dueAt=card["reviewDate"], subjectId=subject["id"])
                        item = {**practice, "id": card["itemId"], "topic": card["title"], "pluginType": practice["questionType"], "practiceItem": practice, "reviewOnly": True}
                        items = [item]
                    elif fmt == "mapped-json":
                        if definition["indexPath"] not in extra_subject_indexes:
                            raise ValueError("unregistered-mapped-content")
                        from mapped_source_registry import parse_items
                        items = parse_items(vault, text, subject)
                    else:
                        items = _table_items(text, fmt, subject, fields.get("zhixue_id") or ref["id"])
                    if not items:
                        raise GatewayError("empty-source", "引用中没有可解析的学习条目。")
                    from flashcard_support import expand_flashcard
                    items=[child for item in items for child in expand_flashcard(item)]
                    for item in items:
                        state_ref = item.get("stateRef") or ref.get("stateRef") or definition["progressRef"]
                        state_path, _ = resolve_reference(vault, str(state_ref), relative_to=path.parent)
                        source_note = item.get("sourceNote") or _relative(vault, path)
                        source_path, _ = resolve_reference(vault, str(source_note), relative_to=path.parent)
                        item.update(sourceNote=_relative(vault, source_path), stateRef=_relative(vault, state_path), subjectId=subject["id"], sourceMode="gateway",
                                    identity=subject["identity"], allowLegacyAliases=subject["identity"] == "legacy", domain=subject["domain"], contentRef=ref["contentRef"])
                        item_id = item["itemId"]
                        key = item["abilityId"] if item.get("word") else f"practice:{item_id}"
                        # Due dates are review state, not a replacement of the learning content.
                        signature = hashlib.sha256(json.dumps({k: v for k, v in item.items() if k not in {"contentRef", "practiceItem", "dueAt"}}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                        word_key = " ".join(str(item.get("word", "")).casefold().split())
                        existing = catalog["bindings"].get(key)
                        if existing:
                            if word_key and existing.get("wordKey") == word_key and existing["subjectId"] == subject["id"]:
                                continue
                            if existing.get("signature") == signature and existing["stateRef"] == item["stateRef"] and existing.get("documentPath") == _relative(vault, path):
                                continue
                            collisions.add(key)
                            raise GatewayError("duplicate-item-id", f"学习条目 ID 重复：{key}")
                        catalog["bindings"][key] = {"itemId": item_id, "subjectId": subject["id"], "abilityId": item["abilityId"], "sourceNote": item["sourceNote"],
                                                     "stateRef": item["stateRef"], "progressRef": definition["progressRef"], "recordsRoot": definition["recordsRoot"], "contentRef": ref["contentRef"],
                                                     "contentRoot": definition["contentRoot"], "signature": signature, "wordKey": word_key, "documentPath": _relative(vault, path)}
                        item["contentHash"] = signature
                        # Optional auxiliary observation metadata must not disable old learning.
                        try:
                            from assistance_binding import binding_hash
                            item['localBindingHash'] = binding_hash(vault, catalog['bindings'][key], assistance_fingerprints)
                        except (ValueError, OSError, KeyError):
                            pass
                        subject["items"].append(item)
                        if card is not None and practice is not None:
                            card.update(sourceNote=item["sourceNote"], stateRef=item["stateRef"])
                            practice.update(sourceNote=item["sourceNote"], stateRef=item["stateRef"])
                            catalog["resultCards"].append(card)
                            if card["reviewEnabled"] and card["reviewDate"] and card["reviewDate"] <= current_study_day().isoformat():
                                catalog["practiceItems"].append(practice)
                    index_rows.append(f"| {ref['id'] or fields.get('zhixue_id', '')} | {ref['contentRef']} | {fmt} |")
                except (OSError, ValueError) as error:
                    _diagnostic(catalog["diagnostics"], error, ref["contentRef"])
            catalog["subjects"].append(subject)
            if refresh and definition["indexPath"] not in extra_subject_indexes:
                try:
                    _update_index(definition["indexPath"], definition["indexText"], index_rows)
                except (OSError, ValueError) as error:
                    _diagnostic(catalog["diagnostics"], error, _relative(vault, definition["indexPath"]))
        for key in collisions:
            catalog["bindings"].pop(key, None)
            for subject in catalog["subjects"]:
                subject["items"] = [item for item in subject["items"] if (item["abilityId"] if item.get("word") else f"practice:{item['itemId']}") != key]
        catalog["resultCards"] = [card for card in catalog["resultCards"] if f"practice:{card['itemId']}" in catalog["bindings"]]
        catalog["practiceItems"] = [item for item in catalog["practiceItems"] if f"practice:{item['itemId']}" in catalog["bindings"]]
        catalog['planningDefinitions'] = [
            {**{key: definition[key] for key in ('id', 'contentRoot', 'recordsRoot', 'progressRef')},
             'indexRef': _relative(vault, definition['indexPath'])}
            for definition in catalog['definitions']
        ]
        catalog.pop("definitions", None)
        return catalog


def lookup_binding(catalog: dict, item_key: str) -> dict | None:
    bindings = catalog.get("bindings", {})
    return bindings.get(item_key) or bindings.get(f"practice:{item_key}")


def resolve_event_context(vault_root: Path, catalog: dict, item_key: str, context: dict | None) -> tuple[dict | None, dict]:
    if context is not None and not isinstance(context, dict):
        raise GatewayError("invalid-context", "localContext 必须为对象。")
    context = dict(context or {})
    binding = lookup_binding(catalog, item_key)
    if binding is None:
        # Unregistered events remain evidence, but do not acquire a write target.
        context.pop("stateRef", None)
        return None, context
    if context.get("abilityId") and context["abilityId"] != binding["abilityId"]:
        raise GatewayError("gateway-context-conflict", "作答能力与当前索引不一致，请刷新学习资料。")
    if context.get("stateRef"):
        supplied, _ = resolve_reference(vault_root, context["stateRef"])
        if _relative(vault_root, supplied) != binding["stateRef"]:
            raise GatewayError("gateway-context-conflict", "作答状态目标与当前索引不一致。")
    return binding, {**context, "sourceNote": binding["sourceNote"], "stateRef": binding["stateRef"], "abilityId": binding["abilityId"]}


def _records_root(vault_root: Path, binding: dict) -> Path:
    root = _path(vault_root, binding["recordsRoot"], directory=True, must_exist=False)
    content = _path(vault_root, binding["contentRoot"], directory=True)
    try:
        root.relative_to(content)
    except ValueError as error:
        raise GatewayError("invalid-record-location", "学习记录必须留在所属学科。") from error
    return root


def subject_event_path(vault_root: Path, binding: dict, event: dict) -> Path:
    day = calendar_day(str(event["occurredAt"]))
    root = _records_root(vault_root, binding)
    candidate = root / str(day.year) / f"{day.isoformat()}.jsonl"
    if binding['contentRoot'].startswith('_System/Integrations/Study Loop/mapped/'):
        from mapped_source_registry import _safe
        _safe(Path(vault_root).resolve(), candidate)
    target = candidate.resolve()
    if not target.is_relative_to(root):
        raise GatewayError("invalid-record-location", "记录文件链接逃出学科目录。")
    return target


def subject_records(vault_root: Path, binding: dict, account_id: str):
    """Dispatch known local record types without treating tasks as V3 practice."""
    root = _records_root(vault_root, binding)
    if not root.exists():
        return
    for path in sorted(root.rglob("*.jsonl")):
        resolved = path.resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError as error:
            raise GatewayError("invalid-record-location", "记录文件链接逃出学科目录。") from error
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if row.get("accountId") != account_id:
                    continue
                kind = row.get('recordKind', 'study-event-v3')
                if kind not in ('study-event-v3', 'task-event-v1'):
                    raise ValueError('unknown-record-kind')
                event = row["event"]
                if not isinstance(event.get('eventId'), str) or not isinstance(event.get('coreHash'), str):
                    raise ValueError('invalid-record-event')
                if kind == 'task-event-v1':
                    from task_events import validate_task_event
                    validate_task_event(event)
                yield kind, row
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                raise GatewayError("invalid-subject-record", "学科事件记录不完整或存在冲突，未忽略该记录。") from error


def read_subject_events(vault_root: Path, binding: dict, account_id: str) -> list[dict]:
    rows: dict[str, dict] = {}
    for kind, row in subject_records(vault_root, binding, account_id):
        if kind != 'study-event-v3':
            continue
        event = row['event']
        previous = rows.get(event['eventId'])
        if previous and previous['event']['coreHash'] != event['coreHash']:
            raise GatewayError('invalid-subject-record', '学科事件记录存在冲突，未忽略该记录。')
        rows[event['eventId']] = row
    return sorted(rows.values(), key=lambda row: (row["event"]["occurredAt"], row["event"]["eventId"]))


def record_subject_event(vault_root: Path, binding: dict, account_id: str, event: dict, context: dict, planning_evidence: dict | None = None) -> Path:
    with LOCK:
        path = subject_event_path(vault_root, binding, event)
        previous = next((row for row in read_subject_events(vault_root, binding, account_id) if row["event"]["eventId"] == event["eventId"]), None)
        if previous:
            if previous["event"]["coreHash"] != event["coreHash"]:
                raise GatewayError("event-conflict", "同一事件 ID 不能对应不同内容。")
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {"schemaVersion": 1, "accountId": account_id, "subjectId": binding["subjectId"], "event": event, "localContext": context}
        if planning_evidence is not None:
            row['planningEvidence'] = planning_evidence
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        return path


def progress_records(vault_root: Path, catalog: dict, account_id: str) -> list[dict]:
    roots: set[str] = set()
    events: dict[str, dict] = {}
    for binding in [*catalog.get('recordRoots', []), *catalog.get("bindings", {}).values()]:
        if binding["recordsRoot"] in roots:
            continue
        roots.add(binding["recordsRoot"])
        for row in read_subject_events(vault_root, binding, account_id):
            event = row["event"]
            previous = events.get(event["eventId"])
            if previous and previous["event"]["coreHash"] != event["coreHash"]:
                raise GatewayError("event-conflict", "不同学科日志包含相同 ID、不同内容的事件，未覆盖已有进度。")
            if lookup_binding(catalog, event.get("item", {}).get("key", "")):
                events[event["eventId"]] = row
    return sorted(events.values(), key=lambda row: (row["event"]["occurredAt"], row["event"]["eventId"]))


def progress_events(vault_root: Path, catalog: dict, account_id: str) -> list[dict]:
    return [row["event"] for row in progress_records(vault_root, catalog, account_id)]
