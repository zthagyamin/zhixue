"""Authority adapter for the single user-visible Zhixue learning plan."""

from __future__ import annotations

import base64
import html
import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from managed_markdown import replace_managed_block
from task_plan_schema import validate_task_plan_integrity

PLAN_RELATIVE_PATH = Path("01 学习/学习计划/00 学习计划总览.md")
INTEGRATION_RELATIVE_PATH = Path("_System/Integrations/Study Loop")
PLAN_BEGIN = "%% ZHIXUE:CURRENT-PLAN:BEGIN %%"
PLAN_END = "%% ZHIXUE:CURRENT-PLAN:END %%"
PLAN_DATA_PREFIX = "<!-- ZHIXUE:PLAN-DATA "


@dataclass(frozen=True)
class MigrationResult:
    status: str
    revision: int | None = None
    source: str | None = None


def _timestamp(now: datetime) -> str:
    value = now.astimezone(timezone.utc)
    return value.strftime("%Y%m%dT%H%M%SZ")


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.zhixue.tmp")
    temporary.write_text(content, encoding="utf-8", newline="")
    temporary.replace(path)


def _read_text(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def _backup(vault_root: Path, path: Path, now: datetime) -> Path | None:
    if not path.exists():
        return None
    relative = path.relative_to(vault_root)
    destination = vault_root / INTEGRATION_RELATIVE_PATH / "backups" / _timestamp(now) / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, destination)
    return destination


def _encode_payload(candidate: dict[str, Any], revision: int) -> str:
    raw = json.dumps({"revision": revision, "candidate": candidate}, ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


REVIEW_ITEM_FIELDS = ("itemId", "domain", "sourceNote", "stateRef", "abilityId", "due", "reason", "pluginType")


def _render_plan(candidate: dict[str, Any], revision: int) -> str:
    if candidate.get('schemaVersion') == 2:
        return _render_task_plan(candidate, revision)
    lines = [
        f"{PLAN_DATA_PREFIX}{_encode_payload(candidate, revision)} -->",
        f"**生效日期：** {candidate.get('day', '—')}  ",
        f"**修订号：** {revision}  ",
        f"**计划标识：** `{candidate.get('planHash', '')}`  ",
        f"**预计总时长：** {candidate.get('totalMinutes', 0)} 分钟",
        "",
        "| 类型 | 学习项 | 领域 | 预计分钟 | 原因 |",
        "|---|---|---|---:|---|",
    ]
    for item in candidate.get("items", []):
        reasons = "；".join(str(value) for value in item.get("reasons", [])) or "—"
        # 组级条目在权威计划中显示为可读摘要（vocab-group:ielts-vocabulary:0
        # → 背词第 1 组），内部 itemKey 仍由 PLAN-DATA 载荷完整保留。
        item_key = str(item.get("itemKey", ""))
        display = item_key
        if item_key.startswith("vocab-group:"):
            parts = item_key.split(":")
            display = f"背词第 {int(parts[-1]) + 1} 组（组内词量见网站词库分组）" if parts[-1].isdigit() else "背词组"
        lines.append(
            f"| {item.get('kind', '')} | {display} | {item.get('domain', '')} | "
            f"{item.get('estimatedMinutes', 0)} | {reasons} |"
        )
    if not candidate.get("items"):
        lines.append("| — | 今日暂无学习项 | — | 0 | 等待资料或复习到期 |")
    review_items = candidate.get("reviewItems", [])
    if review_items:
        lines.append("")
        lines.append("## 知识缺口与到期复习")
        lines.append("")
        for item in review_items:
            lines.append(_render_review_item(item))
    return "\n".join(lines)


def _cell(value) -> str:
    text = html.escape(str(value), quote=False).replace('\r', ' ').replace('\n', ' ')
    return re.sub(r'([\\|\[\]`*_])', r'\\\1', text)


def _note_link(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'\[\[[^\]\r\n]+\]\]', value):
        return '引用待确认'
    target = value[2:-2].split('|', 1)[0].split('#', 1)[0].strip()
    if not target or target.startswith('/') or '\\' in target or ':' in target or '..' in target.split('/') or any(c in target for c in '<>'):
        return '引用待确认'
    return html.escape(value, quote=False).replace('|', '\\|')


def _render_task_plan(candidate, revision):
    origins = {'fixed': '固定规则', 'goal': '学科指标', 'ai': 'AI 建议', 'manual': '手动', 'fallback': '资料顺序'}
    lines = [f'{PLAN_DATA_PREFIX}{_encode_payload(candidate, revision)} -->', f'**生效日期：** {candidate["day"]}  ',
             f'**修订号：** {revision}  ', f'**计划标识：** `{candidate["planHash"]}`', '',
             '新学单词目标：20 个；到期复习单独完成，不计入新词数量。完成情况以独立学习记录为准。']
    if candidate.get('optionalMinutes') is not None:
        lines.append(f'可选时间参考：{candidate["optionalMinutes"]} 分钟，不截断必做任务。')
    for title, tasks in [('每日必做', [t for t in candidate['tasks'] if t['category'] != 'subject' and t['required']]),
                         ('学科任务', [t for t in candidate['tasks'] if t['category'] == 'subject']),
                         ('自主加学', [t for t in candidate['tasks'] if t['category'] != 'subject' and not t['required']])]:
        lines.extend(['', f'## {title}', '', '| 学科 | 任务 | 数量 | 安排来源 | 学习来源 | 状态 |', '|---|---|---:|---|---|---|'])
        for task in tasks:
            action = task['action']
            source = _note_link(action['contentRef']) if action['kind'] == 'open-note' else _cell('、'.join(action['itemKeys'])) if action['kind'] == 'practice' else '自主待办'
            status = task.get('blockedReason') or ('必做' if task['required'] else '可选')
            lines.append(f'| {_cell(task["subjectId"])} | {_cell(task["title"])} | {task["quantity"]} | {origins[task["origin"]]} | {source} | {_cell(status)} |')
        if not tasks:
            lines.append('| — | 暂无安排 | — | — | — | — |')
    return '\n'.join(lines)


def _render_review_item(item: dict[str, Any]) -> str:
    title = item.get("title") or item.get("itemId") or "复习项"
    lines = [f"- [ ] **{title}**"]
    for field in REVIEW_ITEM_FIELDS:
        value = item.get(field)
        if value is not None and value != "":
            lines.append(f"  - {field}:: {value}")
    return "\n".join(lines)


def read_current_plan(vault_root: Path) -> dict[str, Any] | None:
    path = Path(vault_root) / PLAN_RELATIVE_PATH
    if not path.exists():
        return None
    text = _read_text(path)
    if text.count(PLAN_BEGIN) > 1 or text.count(PLAN_END) > 1:
        raise ValueError("duplicate-managed-block")
    if text.count(PLAN_BEGIN) != text.count(PLAN_END):
        raise ValueError("unbalanced-managed-block")
    if PLAN_BEGIN not in text:
        return None
    start = text.index(PLAN_BEGIN) + len(PLAN_BEGIN)
    finish = text.index(PLAN_END, start)
    block = text[start:finish]
    marker = block.find(PLAN_DATA_PREFIX)
    if marker < 0:
        return None
    encoded_start = marker + len(PLAN_DATA_PREFIX)
    encoded_finish = block.find(" -->", encoded_start)
    if encoded_finish < 0:
        raise ValueError("invalid-plan-data")
    try:
        decoded = base64.urlsafe_b64decode(block[encoded_start:encoded_finish]).decode("utf-8")
        payload = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid-plan-data") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("candidate"), dict):
        raise ValueError("invalid-plan-data")
    if type(payload.get('revision')) is not int or payload['revision'] < 1:
        raise ValueError('invalid-plan-revision')
    if 'schemaVersion' in payload['candidate']:
        payload['candidate'] = validate_task_plan_integrity(payload['candidate'])
    return payload


def apply_current_plan(
    vault_root: Path,
    candidate: dict[str, Any],
    revision: int,
    now: datetime | None = None,
) -> Path:
    if 'schemaVersion' in candidate:
        candidate = validate_task_plan_integrity(candidate)
    if not candidate.get("day") or not candidate.get("planHash"):
        raise ValueError("invalid-plan-candidate")
    if type(revision) is not int or revision < 1:
        raise ValueError("invalid-plan-revision")
    now = now or datetime.now(timezone.utc)
    path = Path(vault_root) / PLAN_RELATIVE_PATH
    original = _read_text(path) if path.exists() else "# 学习计划总览\n"
    if PLAN_BEGIN not in original:
        _backup(Path(vault_root), path, now)
    updated = replace_managed_block(original, PLAN_BEGIN, PLAN_END, _render_plan(candidate, revision))
    _atomic_write(path, updated)
    return path


def add_review_item(
    vault_root: Path,
    item: dict[str, Any],
    expected_revision: int | None = None,
    *, capture_id: str | None = None,
) -> dict[str, Any]:
    """Append or strengthen one review item in the managed plan block.

    The same ``itemId + abilityId`` strengthens the existing entry instead of
    duplicating it (spec §4). Always writes a new revision; refuses to touch a
    plan whose revision differs from ``expected_revision`` (spec §10).
    """
    import plan_area
    record = plan_area.append_review_revision(plan_area.plan_area_root(vault_root), item, expected_revision, capture_id)
    return {'revision': record['revision']}


def parse_review_items(vault_root: Path) -> list[dict[str, Any]]:
    """Return review items from the managed plan block (stable itemId/abilityId)."""
    payload = read_current_plan(vault_root)
    if payload is None:
        return []
    if payload['candidate'].get('schemaVersion') == 2:
        import index_gateway
        catalog = index_gateway.load_gateway(vault_root)
        items = []
        for task in payload['candidate']['tasks']:
            if task['category'] != 'review' or task['action']['kind'] != 'practice':
                continue
            for key in task['action']['itemKeys']:
                binding = index_gateway.lookup_binding(catalog, key)
                if binding:
                    items.append({**{field: binding[field] for field in ('itemId', 'abilityId', 'stateRef', 'sourceNote')},
                                  'title': task['title'], 'due': payload['candidate']['day'], 'reason': '任务型复习',
                                  'pluginType': 'three-stage' if task['completionRule'] == 'three-stage' else 'recall'})
        return items
    return list(payload.get("candidate", {}).get("reviewItems", []))


def capture_review_task(vault_root: Path, candidate: dict, item: dict, capture_id: str | None, revision: int) -> dict:
    import index_gateway
    catalog = index_gateway.load_gateway(vault_root)
    binding = index_gateway.lookup_binding(catalog, item['itemId'])
    if not catalog['active'] or not binding or item['abilityId'] != binding['abilityId']:
        raise ValueError('capture-review-requires-registered-item')
    if item.get('stateRef'):
        path, _ = index_gateway.resolve_reference(vault_root, item['stateRef'])
        if index_gateway._relative(vault_root, path) != binding['stateRef']:
            raise ValueError('capture-review-state-mismatch')
    key = next(key for key, value in catalog['bindings'].items() if value is binding)
    identity = [capture_id if capture_id else revision, binding['itemId'], binding['abilityId'], candidate['day']]
    round_id = 'capture:' + hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    subject = next(subject for subject in catalog['subjects'] if subject['id'] == binding['subjectId'])
    rule = 'three-stage' if binding.get('wordKey') and subject['pluginType'] == 'three-stage' else 'graded-practice'
    return {'taskId': round_id, 'reviewRoundId': round_id, 'subjectId': binding['subjectId'],
            'title': ' '.join(str(item.get('title') or item['itemId']).split())[:4000], 'category': 'review', 'origin': 'fixed',
            'required': True, 'unitIds': [], 'quantity': 1, 'action': {'kind': 'practice', 'itemKeys': [key]},
            'completionRule': rule, 'sourceHash': binding['signature']}


def migrate_plan(vault_root: Path, legacy_area: Path, now: datetime) -> MigrationResult:
    current = read_current_plan(vault_root)
    if current is not None:
        return MigrationResult("already-migrated", current.get("revision"), str(PLAN_RELATIVE_PATH))

    revisions_path = Path(legacy_area) / "revisions.jsonl"
    valid: list[dict[str, Any]] = []
    if revisions_path.exists():
        for line in revisions_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict) and isinstance(row.get("after"), dict):
                valid.append(row)
    if not valid:
        return MigrationResult("no-legacy-plan")

    latest = valid[-1]
    revision = int(latest.get("revision") or len(valid))
    _backup(Path(vault_root), revisions_path, now)
    apply_current_plan(Path(vault_root), latest["after"], revision, now=now)
    return MigrationResult("migrated", revision, str(revisions_path.relative_to(vault_root)))
