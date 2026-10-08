"""Read and write the user-visible learning-constraint authority note."""

from __future__ import annotations

import base64
import copy
import json
import threading
from functools import wraps
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from managed_markdown import replace_managed_block

CONSTRAINT_RELATIVE_PATH = Path("01 学习/学习计划/01 学习约束.md")
CONSTRAINT_BEGIN = "%% ZHIXUE:CONSTRAINTS:BEGIN %%"
CONSTRAINT_END = "%% ZHIXUE:CONSTRAINTS:END %%"
CONSTRAINT_DATA_PREFIX = "<!-- ZHIXUE:CONSTRAINT-DATA "
VALID_MODES = {"auto", "temporary", "locked"}
CONSTRAINT_LOCK = threading.RLock()


def _synchronized(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        with CONSTRAINT_LOCK:
            return function(*args, **kwargs)
    return guarded


def _iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat(timespec="seconds")


def default_constraints(now: datetime) -> dict[str, Any]:
    system = {
        "dailyMinutes": {"min": 30, "max": 60},
        "weeklyRhythm": {"activeDays": [1, 2, 3, 4, 5, 6], "restDays": [7]},
        "loadFactor": 1.0,
        "minimumReviewMinutes": 10,
    }
    return {
        "schemaVersion": 1,
        "mode": "auto",
        "system": system,
        "override": None,
        "temporaryUntil": None,
        "deadlines": [],
        "estimatedAt": _iso(now),
        "explanation": "历史证据不足，暂按保守学习时长运行；系统会依据实际完成记录逐步估算。",
        "effective": copy.deepcopy(system),
    }


def _validate_minutes(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("invalid-daily-minutes")
    minimum = value.get("min")
    maximum = value.get("max")
    if not isinstance(minimum, int) or not isinstance(maximum, int) or minimum < 0 or maximum < minimum or maximum > 1440:
        raise ValueError("invalid-daily-minutes")
    return {"min": minimum, "max": maximum}


def _validate(document: dict[str, Any]) -> None:
    mode = document.get("mode")
    if mode not in VALID_MODES:
        raise ValueError("invalid-constraint-mode")
    system = document.get("system")
    if not isinstance(system, dict):
        raise ValueError("invalid-system-constraints")
    _validate_minutes(system.get("dailyMinutes"))
    override = document.get("override")
    if mode in {"locked", "temporary"} and (not isinstance(override, dict) or not override):
        raise ValueError("missing-mode-override")
    if isinstance(override, dict) and "dailyMinutes" in override:
        _validate_minutes(override["dailyMinutes"])
    for values in (system, override if isinstance(override, dict) else None):
        if not isinstance(values, dict):
            continue
        rhythm = values.get("weeklyRhythm")
        if rhythm is not None:
            if not isinstance(rhythm, dict):
                raise ValueError("invalid-weekly-rhythm")
            if "workdayMinutes" in rhythm or "weekendMinutes" in rhythm:
                workday = rhythm.get("workdayMinutes")
                weekend = rhythm.get("weekendMinutes")
                if not isinstance(workday, int) or not isinstance(weekend, int) or min(workday, weekend) < 0 or max(workday, weekend) > 1440:
                    raise ValueError("invalid-weekly-rhythm")
            else:
                active = rhythm.get("activeDays")
                rest = rhythm.get("restDays")
                if not isinstance(active, list) or not isinstance(rest, list) or any(not isinstance(day, int) or day < 1 or day > 7 for day in [*active, *rest]):
                    raise ValueError("invalid-weekly-rhythm")
        load_factor = values.get("loadFactor")
        if load_factor is not None and (not isinstance(load_factor, (int, float)) or isinstance(load_factor, bool) or load_factor < 0.1 or load_factor > 1):
            raise ValueError("invalid-load-factor")
        review_minutes = values.get("minimumReviewMinutes")
        if review_minutes is not None and (not isinstance(review_minutes, int) or isinstance(review_minutes, bool) or review_minutes < 0 or review_minutes > 180):
            raise ValueError("invalid-review-minutes")
    if mode == "temporary":
        value = document.get("temporaryUntil")
        if not isinstance(value, str):
            raise ValueError("invalid-temporary-expiry")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("invalid-temporary-expiry") from error
    deadlines = document.get("deadlines", [])
    if not isinstance(deadlines, list):
        raise ValueError("invalid-deadlines")
    for deadline in deadlines:
        if not isinstance(deadline, dict):
            raise ValueError("invalid-deadline")
        try:
            datetime.fromisoformat(str(deadline.get("date", ""))[:10])
        except ValueError as error:
            raise ValueError("invalid-deadline") from error
        title = deadline.get("title")
        priority = deadline.get("priority")
        scope = deadline.get("scopeRef")
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError("invalid-deadline")
        if not isinstance(priority, int) or isinstance(priority, bool) or priority < 1 or priority > 5:
            raise ValueError("invalid-deadline")
        if scope is not None and (not isinstance(scope, str) or len(scope) > 200):
            raise ValueError("invalid-deadline")


def _temporary_active(document: dict[str, Any], now: datetime) -> bool:
    value = document.get("temporaryUntil")
    if not isinstance(value, str):
        return False
    try:
        deadline = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    return deadline > now.astimezone(timezone.utc)


def _effective(document: dict[str, Any], now: datetime) -> dict[str, Any]:
    system = copy.deepcopy(document["system"])
    mode = document["mode"]
    override = document.get("override")
    use_override = mode == "locked" or (mode == "temporary" and _temporary_active(document, now))
    if use_override and isinstance(override, dict):
        for key, value in override.items():
            system[key] = copy.deepcopy(value)
    return system


def _encode(document: dict[str, Any]) -> str:
    stored = {key: value for key, value in document.items() if key != "effective"}
    raw = json.dumps(stored, ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def _render(document: dict[str, Any], now: datetime) -> str:
    effective = _effective(document, now)
    daily = effective["dailyMinutes"]
    rhythm = effective.get("weeklyRhythm", {})
    active_days = "、".join(str(day) for day in rhythm.get("activeDays", [])) or "未指定"
    deadline_lines = [
        f"- {item.get('date', '—')} · {item.get('title', '未命名截止事项')}"
        for item in document.get("deadlines", [])
        if isinstance(item, dict)
    ] or ["- 暂无考试或课程截止日期"]
    lines = [
        f"{CONSTRAINT_DATA_PREFIX}{_encode(document)} -->",
        f"**调节模式：** `{document['mode']}`  ",
        f"**当前每日范围：** {daily['min']}–{daily['max']} 分钟  ",
        f"**当前学习日：** {active_days}  ",
        f"**复习最低保障：** {effective.get('minimumReviewMinutes', 10)} 分钟  ",
        f"**系统估算说明：** {document.get('explanation', '—')}",
        "",
        "### 考试与课程截止日期",
        "",
        *deadline_lines,
    ]
    return "\n".join(lines)


@_synchronized
def read_constraints(vault_root: Path, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    path = Path(vault_root) / CONSTRAINT_RELATIVE_PATH
    if not path.exists():
        return default_constraints(now)
    with path.open("r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    if CONSTRAINT_BEGIN not in text:
        return default_constraints(now)
    if text.count(CONSTRAINT_BEGIN) > 1 or text.count(CONSTRAINT_END) > 1:
        raise ValueError("duplicate-managed-block")
    if text.count(CONSTRAINT_BEGIN) != text.count(CONSTRAINT_END):
        raise ValueError("unbalanced-managed-block")
    start = text.index(CONSTRAINT_BEGIN) + len(CONSTRAINT_BEGIN)
    finish = text.index(CONSTRAINT_END, start)
    block = text[start:finish]
    marker = block.find(CONSTRAINT_DATA_PREFIX)
    if marker < 0:
        return default_constraints(now)
    encoded_start = marker + len(CONSTRAINT_DATA_PREFIX)
    encoded_finish = block.find(" -->", encoded_start)
    try:
        decoded = base64.urlsafe_b64decode(block[encoded_start:encoded_finish]).decode("utf-8")
        document = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid-constraint-data") from error
    if not isinstance(document, dict):
        raise ValueError("invalid-constraint-data")
    _validate(document)
    document["effective"] = _effective(document, now)
    return document


@_synchronized
def write_constraints(vault_root: Path, document: dict[str, Any], now: datetime | None = None) -> Path:
    now = now or datetime.now(timezone.utc)
    normalized = copy.deepcopy(document)
    normalized.pop("effective", None)
    _validate(normalized)
    if normalized.get("mode") == "temporary" and not _temporary_active(normalized, now):
        raise ValueError("invalid-temporary-expiry")
    normalized["effective"] = _effective(normalized, now)
    path = Path(vault_root) / CONSTRAINT_RELATIVE_PATH
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as handle:
            original = handle.read()
    else:
        original = "# 学习约束\n"
    updated = replace_managed_block(original, CONSTRAINT_BEGIN, CONSTRAINT_END, _render(normalized, now))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.zhixue.tmp")
    temporary.write_text(updated, encoding="utf-8", newline="")
    temporary.replace(path)
    return path
