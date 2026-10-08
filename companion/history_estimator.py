"""Deterministic, explainable schedule estimates from recent study evidence."""

from __future__ import annotations
from study_day import study_day

import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

WINDOW_DAYS = 28
MINIMUM_ACTIVE_DAYS = 3
MINIMUM_MINUTES = 20
MAXIMUM_MINUTES = 180
LOCAL_TZ = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True)
class ScheduleEstimate:
    minimum_minutes: int
    maximum_minutes: int
    weekly_rhythm: dict[str, int]
    load_factor: float
    minimum_review_minutes: int
    evidence_days: int
    completion_ratio: float | None
    explanation: str


def _event_day(event: dict[str, Any]) -> date | None:
    raw = event.get("occurredAt")
    if not isinstance(raw, str):
        return None
    try:
        return study_day(datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(LOCAL_TZ))
    except ValueError:
        return None


def _duration(event: dict[str, Any]) -> int:
    value = event.get("durationMin")
    if value is None and isinstance(event.get("localContext"), dict):
        value = event["localContext"].get("durationMin")
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _item_key(event: dict[str, Any]) -> str | None:
    value = event.get("itemKey")
    if isinstance(value, str) and value:
        return value
    item = event.get("item")
    if isinstance(item, dict) and isinstance(item.get("key"), str):
        return item["key"]
    return None


def _plan_day(plan: dict[str, Any]) -> date | None:
    raw = plan.get("day")
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _clamp(value: int) -> int:
    return max(MINIMUM_MINUTES, min(MAXIMUM_MINUTES, value))


def estimate_schedule(
    events: list[dict[str, Any]],
    approved_plans: list[dict[str, Any]],
    deadlines: list[dict[str, Any]],
    day: date,
) -> ScheduleEstimate:
    """Estimate time/rhythm from the inclusive 28-day window ending at day."""

    start = day - timedelta(days=WINDOW_DAYS - 1)
    daily_minutes: dict[date, int] = {}
    event_keys: dict[date, set[str]] = {}
    for event in events:
        event_day = _event_day(event)
        if event_day is None or event_day < start or event_day > day:
            continue
        duration = _duration(event)
        if duration:
            daily_minutes[event_day] = daily_minutes.get(event_day, 0) + duration
        key = _item_key(event)
        if key:
            event_keys.setdefault(event_day, set()).add(key)

    active = sorted(value for value in daily_minutes.values() if value > 0)
    if len(active) < MINIMUM_ACTIVE_DAYS:
        return ScheduleEstimate(
            minimum_minutes=30,
            maximum_minutes=60,
            weekly_rhythm={"workdayMinutes": 60, "weekendMinutes": 45},
            load_factor=0.9,
            minimum_review_minutes=15,
            evidence_days=len(active),
            completion_ratio=None,
            explanation=f"近 28 天只有 {len(active)} 个有效学习日，证据不足，暂用 30–60 分钟保守范围。",
        )

    planned_count = 0
    completed_count = 0
    plan_days = 0
    for plan in approved_plans:
        plan_day = _plan_day(plan)
        if plan_day is None or plan_day < start or plan_day > day:
            continue
        items = [item for item in plan.get("items", []) if isinstance(item, dict) and isinstance(item.get("itemKey"), str)]
        if not items:
            continue
        plan_days += 1
        attempted = event_keys.get(plan_day, set())
        planned_count += len(items)
        completed_count += sum(1 for item in items if item["itemKey"] in attempted)

    completion = completed_count / planned_count if planned_count else None
    baseline = float(statistics.median(active))
    explanations = [f"近 28 天 {len(active)} 个有效学习日，中位数为 {round(baseline)} 分钟。"]
    adjusted = baseline
    if completion is not None and completion < 0.75:
        skip_rate = 1 - completion
        adjusted *= 0.8
        explanations.append(f"计划跳过率为 {skip_rate:.0%}，超过 25%，容量下调 20%。")
    elif completion is not None and completion >= 0.85 and plan_days >= 14:
        adjusted *= 1.1
        explanations.append(f"连续两周计划完成率为 {completion:.0%}，容量谨慎上调 10%。")

    global_pressure = 0
    for deadline in deadlines:
        if deadline.get("scopeRef"):
            continue
        try:
            days = (date.fromisoformat(str(deadline.get("date", ""))[:10]) - day).days
            priority = int(deadline.get("priority", 0))
        except (ValueError, TypeError):
            continue
        if 0 <= days <= 7 and 1 <= priority <= 5:
            global_pressure = max(global_pressure, priority)
    if global_pressure:
        increase = min(0.15, global_pressure * 0.03)
        adjusted *= 1 + increase
        explanations.append(f"全局截止日期临近，容量有界上调 {increase:.0%}。")

    maximum = _clamp(round(adjusted))
    minimum = _clamp(round(maximum * 0.6))
    weekdays = [value for key, value in daily_minutes.items() if key.weekday() < 5]
    weekends = [value for key, value in daily_minutes.items() if key.weekday() >= 5]
    workday = _clamp(round(statistics.median(weekdays))) if weekdays else maximum
    weekend = _clamp(round(statistics.median(weekends))) if weekends else maximum
    return ScheduleEstimate(
        minimum_minutes=minimum,
        maximum_minutes=maximum,
        weekly_rhythm={"workdayMinutes": workday, "weekendMinutes": weekend},
        load_factor=0.9,
        minimum_review_minutes=max(10, min(30, round(minimum * 0.35))),
        evidence_days=len(active),
        completion_ratio=round(completion, 4) if completion is not None else None,
        explanation=" ".join(explanations),
    )
