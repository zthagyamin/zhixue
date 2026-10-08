"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations
from study_day import study_day

import json
import re
from pathlib import Path
from datetime import date, timedelta
from typing import Any
import learning_session
from infrastructure.vault_documents import note_title, safe_date


def read_activity_events(day: date, *, event_log_path) -> list[dict[str, Any]]:
    # New partitions use learning days; older clients may still use civil-day files.
    # Read only the two possible partitions, preserve originals and deduplicate IDs.
    events = {}
    for partition in (day, day + timedelta(days=1)):
        path = event_log_path(partition)
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(item, dict) or not item.get('eventId'):
                continue
            occurred = item.get('occurredAt')
            try:
                belongs = study_day(occurred) == day if occurred else partition == day
            except (ValueError, TypeError):
                belongs = partition == day
            if not belongs:
                continue
            old = events.get(item['eventId'])
            if old and old != item and (not old.get('coreHash') or old.get('coreHash') != item.get('coreHash')):
                raise ValueError('activity-event-conflict')
            events.setdefault(item['eventId'], item)
    return list(events.values())


def dashboard_activity_events(day: date, *, learning_vault_path, read_activity_events) -> list[dict[str, Any]]:
    """Combine website events with read-only Agent learning-session evidence."""
    activities = [*learning_session.read_session_events(learning_vault_path(), day), *read_activity_events(day)]
    activities.sort(key=lambda item: (str(item.get("occurredAt", "")), str(item.get("eventId", ""))))
    return activities


def active_project_stages(*, learning_vault_path, read_frontmatter, relative_note_path) -> list[dict[str, Any]]:
    root = learning_vault_path("02 项目与研究/项目")
    if not root.exists():
        return []
    items: list[dict[str, Any]] = []
    for path in root.rglob("*.md"):
        properties, body = read_frontmatter(path)
        if not properties.get("project_id") or properties.get("status") in {"done", "completed", "archived"}:
            continue
        if properties.get("stage") is None and path.name.startswith("00 "):
            continue
        items.append({
            "projectId": str(properties.get("project_id")),
            "stage": properties.get("stage"),
            "title": note_title(path, body),
            "status": str(properties.get("status", "active")),
            "nextAction": str(properties.get("next_action", "")),
            "path": relative_note_path(path),
            "updated": str(properties.get("updated", "")),
        })
    items.sort(key=lambda item: (item.get("updated", ""), str(item.get("stage", ""))), reverse=True)
    return items[:6]


def active_research_sessions(*, learning_vault_path, read_frontmatter, relative_note_path) -> list[dict[str, Any]]:
    root = learning_vault_path("02 项目与研究/论文研究")
    if not root.exists():
        return []
    items: list[dict[str, Any]] = []
    for path in root.rglob("*.md"):
        properties, body = read_frontmatter(path)
        if properties.get("type") != "paper-reading-session" or properties.get("status") != "active":
            continue
        items.append({
            "paperId": str(properties.get("paper_id", "")),
            "title": note_title(path, body),
            "pass": properties.get("pass_number"),
            "status": "active",
            "path": relative_note_path(path),
            "updated": str(properties.get("updated", "")),
        })
    items.sort(key=lambda item: item.get("updated", ""), reverse=True)
    return items[:6]


def due_review_items(today: date, *, learning_vault_path, read_frontmatter, relative_note_path) -> list[dict[str, Any]]:
    root = learning_vault_path("01 学习/专项课程")
    if not root.exists():
        return []
    items: list[dict[str, Any]] = []
    for path in root.rglob("*学习状态.md"):
        properties, body = read_frontmatter(path)
        if properties.get("type") != "learning-state" or properties.get("review_enabled") is not True:
            continue
        review_date = safe_date(properties.get("review_date"))
        if not review_date or review_date > today:
            continue
        count_match = re.search(r"(?:保留|新增|共)\s*(\d+)\s*项", body)
        declared_count = int(count_match.group(1)) if count_match else 1
        state_path = relative_note_path(path)
        queue_match = re.search(r"(?ms)^##\s+复习队列[^\r\n]*\r?\n(.*?)(?=^##\s|\Z)", body)
        queue = queue_match.group(1).strip() if queue_match else ""
        source_match = re.search(r"\[\[([^|\]]+)", queue)
        source_note = source_match.group(1).strip() if source_match else state_path
        if source_note != state_path and not source_note.lower().endswith(".md"):
            source_note += ".md"
        point_text = queue.rsplit("：", 1)[-1].split("。", 1)[0].strip() if "：" in queue else ""
        review_points = [part.strip() for part in re.split(r"[、，,；;]", point_text) if part.strip()]
        while len(review_points) < declared_count:
            split_index = next((index for index, value in enumerate(review_points) if " 与 " in value), None)
            if split_index is None:
                break
            value = review_points.pop(split_index)
            review_points[split_index:split_index] = [part.strip() for part in value.split(" 与 ", 1) if part.strip()]
        review_points = review_points[:declared_count]
        while len(review_points) < declared_count:
            review_points.append(f"{properties.get('topic', path.stem)} · 复习点 {len(review_points) + 1}")
        course_id = str(properties.get("course_id", ""))
        lecture_no = properties.get("lecture_no")
        study_items = [
            {
                "id": f"due:{course_id or 'course'}:{lecture_no or 'note'}:{index}",
                "itemId": f"due:{course_id or 'course'}:{lecture_no or 'note'}:{index}",
                "pluginType": "flashcard",
                "front": point,
                "back": f"先完成主动回忆，再打开来源笔记核对：{source_note}",
                "sourceNote": source_note,
                "stateRef": state_path,
                "abilityId": f"review-{lecture_no or 'note'}-{index}",
                "sourceLabel": f"Obsidian 到期复习 · {properties.get('topic', path.stem)}",
            }
            for index, point in enumerate(review_points, start=1)
        ]
        items.append({
            "courseId": course_id,
            "lectureNo": lecture_no,
            "topic": str(properties.get("topic", path.stem)),
            "reviewDate": review_date.isoformat(),
            "timing": "today" if review_date == today else "overdue",
            "itemCount": declared_count,
            "nextAction": str(properties.get("next_action", "")),
            "path": state_path,
            "studyItems": study_items,
        })
    items.sort(key=lambda item: (item["reviewDate"], str(item.get("courseId", "")), item.get("lectureNo") or 0))
    return items


def daily_dashboard(day: date | None = None, *, indexed_study_payload, source_path, learning_vault_path, read_frontmatter, due_review_items, dashboard_activity_events, relative_note_path, active_project_stages, active_research_sessions, now) -> dict[str, Any]:
    target_day = day or study_day(now())
    indexed = indexed_study_payload(source_path("learning_vault_root"), None, day=target_day)
    if indexed is not None:
        return indexed["dashboard"]
    plan_path = learning_vault_path("01 学习/学习计划/00 学习计划总览.md")
    plan, _ = read_frontmatter(plan_path)
    priorities = plan.get("priority", [])
    if not isinstance(priorities, list):
        priorities = [priorities] if priorities else []
    due_items = due_review_items(target_day)
    activities = dashboard_activity_events(target_day)
    return {
        "schemaVersion": 1,
        "date": target_day.isoformat(),
        "generatedAt": now().isoformat(timespec="seconds"),
        "authority": {
            "learningPlan": relative_note_path(plan_path),
            "courseProgress": "learning-state",
            "websiteActivity": "append-only Study Loop events",
            "masteryPolicy": "website events never infer mastered",
        },
        "priorities": [str(item) for item in priorities[:5]],
        "dueReviews": due_items,
        "dueReviewCount": sum(int(item.get("itemCount", 1)) for item in due_items),
        "activeProjects": active_project_stages(),
        "activeResearch": active_research_sessions(),
        "activities": activities,
        "activityCount": len(activities),
        "activityMinutes": sum(int(item.get("durationMin", 0)) for item in activities),
    }
