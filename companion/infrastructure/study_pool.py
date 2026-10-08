"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations
from study_day import study_day

from pathlib import Path
from datetime import date, datetime
from typing import Any
import change_detect
import source_area
import snapshot_schema
import index_gateway


def indexed_study_payload(vault_root: Path, account_id: str | None, *, refresh: bool = False, day: date | None = None, effective_gateway, validate_study_event_v3, LOCAL_TZ, read_frontmatter, now) -> dict[str, Any] | None:
    """One indexed read path; legacy discovery and provider generation stay outside it."""
    catalog = effective_gateway(vault_root, refresh=refresh)
    if not catalog["active"] or catalog.get("legacyCoexistence"):
        return None
    diagnostics = list(catalog["diagnostics"])
    events = []
    contexts = {}
    if account_id:
        try:
            records = index_gateway.progress_records(vault_root, catalog, account_id)
            events = [validate_study_event_v3(row["event"]) for row in records]
            contexts = {row["event"]["eventId"]: row.get("localContext", {}) for row in records}
        except (ValueError, OSError) as error:
            diagnostics.append({"code": getattr(error, "code", "invalid-subject-record"), "message": "学科进度记录校验失败，请检查本机学科日志；未用损坏记录覆盖进度。"})
    target_day = (day or study_day(now())).isoformat()
    activities = []
    for event in events:
        if event["eventType"] != "practice-attempt" or study_day(event["occurredAt"]).isoformat() != target_day:
            continue
        minutes = contexts.get(event["eventId"], {}).get("durationMin", 0)
        minutes = max(0, min(1440, minutes)) if isinstance(minutes, int) and not isinstance(minutes, bool) else 0
        activities.append({**event, "durationMin": minutes})
    plan_path = vault_root / "01 学习/学习计划/00 学习计划总览.md"
    plan, _ = read_frontmatter(plan_path)
    priorities = plan.get("priority", [])
    if not isinstance(priorities, list):
        priorities = [priorities] if priorities else []
    count = sum(len(subject["items"]) for subject in catalog["subjects"])
    return {
        "status": "connected", "contentMode": "personal", "syncedAt": now().isoformat(timespec="seconds"),
        "source": {"title": "学习知识库 · 固定索引", "scope": "仅已登记学科；内容与进度保留在学科内"},
        "subjects": catalog["subjects"], "practiceItems": catalog["practiceItems"],
        "gateway": {"mode": "indexed", "schemaVersion": catalog["schemaVersion"], "subjectCount": len(catalog["subjects"]), "itemCount": count, "diagnostics": diagnostics, "progressEvents": events,
                    "capabilities": sorted(index_gateway.PLUGINS)},
        "connections": [{"key": "obsidian", "label": "Obsidian 学习库", "status": "ready" if not diagnostics else "warning", "detail": f"固定索引 · {len(catalog['subjects'])} 个学科 · {count} 个条目", "count": count},
                        {"key": "companion", "label": "本地同步助手", "status": "connected", "detail": "按索引读取；学习记录写回所属学科"}],
        "dashboard": {"schemaVersion": 1, "date": target_day, "generatedAt": now().isoformat(timespec="seconds"),
                      "authority": {"learningPlan": "01 学习/学习计划/00 学习计划总览.md", "courseProgress": "subject-local", "websiteActivity": "subject append-only events", "masteryPolicy": "website events never infer mastered"},
                      "priorities": priorities, "dueReviews": [], "dueReviewCount": len(catalog["practiceItems"]), "activeProjects": [], "activeResearch": [],
                      "activities": activities, "activityCount": len(activities), "activityMinutes": sum(item["durationMin"] for item in activities)},
    }


def merge_source_area(
    payload: dict[str, Any],
    vault_root: Path,
    approved_documents: list[dict[str, str]] | None = None, *, mapped_study_payload) -> dict[str, Any]:
    """Merges table-direct items from the source area into the single
    vocabulary subject (ielts-vocabulary) and the single reading
    comprehension subject (reading-comprehension). Deterministic: duplicate
    items are dropped by abilityId/word so the sidebar keeps exactly one
    word entry and one reading entry."""
    payload = mapped_study_payload(payload, vault_root)
    if approved_documents is None:
        items = source_area.parse_source_area(vault_root)
    else:
        root = change_detect.source_root(vault_root)
        items = []
        for document in approved_documents:
            path = root / Path(document["path"])
            items.extend(source_area.parse_source_text(document["content"], path))
    if not items:
        return payload
    vocabulary_items = [item for item in items if item.get("kind") == "vocabulary"]
    quiz_items = [item for item in items if item.get("kind") == "quiz"]
    code_items = [item for item in items if item.get("kind") == "code"]
    subjects = list(payload.get("subjects") or [])

    def subject_with_id(target_id: str, create: dict[str, Any]) -> dict[str, Any]:
        for subject in subjects:
            if subject.get("id") == target_id:
                return subject
        subjects.append(create)
        return create

    if vocabulary_items:
        subject = subject_with_id(
            "ielts-vocabulary",
            {"id": "ielts-vocabulary", "name": "IELTS 核心词汇", "pluginType": "three-stage", "domain": "ielts", "items": []},
        )
        existing = subject.setdefault("items", [])
        # 同词不同身份（种子生成 vs 来源表格各自生成 abilityId）只保留先
        # 出现的一条——先出现的是已有学习进度绑定的身份，避免同一词在队
        # 列里出现两次、进度被劈成两半。
        existing_words = {
            str(item.get("word", "")).strip().lower()
            for item in existing
            if item.get("word")
        }
        existing_by_word = {
            str(item.get("word", "")).strip().lower(): item
            for item in existing
            if item.get("word")
        }
        seen = {
            str(item.get("abilityId") or (str(item.get("word", "")).lower() + "|" + str(item.get("meaning", ""))))
            for item in existing
        }
        for item in vocabulary_items:
            key = str(item.get("abilityId") or (str(item.get("word", "")).lower() + "|" + str(item.get("meaning", ""))))
            word_key = str(item.get("word", "")).strip().lower()
            if word_key and word_key in existing_words:
                current = existing_by_word[word_key]
                current_ability = str(current.get("abilityId", "")).strip()
                if not current_ability or current_ability.startswith("ielts-vocabulary:item-"):
                    current["abilityId"] = item["abilityId"]
                if not current.get("sourceNote") and item.get("sourceNote"):
                    current["sourceNote"] = item["sourceNote"]
                continue
            if key in seen:
                continue
            seen.add(key)
            if word_key:
                existing_words.add(word_key)
                existing_by_word[word_key] = item
            existing.append(item)

    if quiz_items:
        subject = subject_with_id(
            "reading-comprehension",
            {"id": "reading-comprehension", "name": "阅读理解专项", "pluginType": "quiz", "domain": "ielts", "items": []},
        )
        existing = subject.setdefault("items", [])
        seen = {str(item.get("abilityId") or item.get("prompt", "")) for item in existing}
        for item in quiz_items:
            key = str(item.get("abilityId") or item.get("prompt", ""))
            if key in seen:
                continue
            seen.add(key)
            existing.append(item)

    if code_items:
        subject = subject_with_id(
            "python-practice",
            {"id": "python-practice", "name": "Python 练习", "pluginType": "code", "domain": "python", "items": []},
        )
        existing = subject.setdefault("items", [])
        seen_ids = {str(item.get("itemId") or item.get("id", "")) for item in existing}
        for item in code_items:
            if item["itemId"] not in seen_ids:
                seen_ids.add(item["itemId"])
                existing.append(item)

    return {**payload, "subjects": subjects}


def merge_approved_snapshots(payload: dict[str, Any], vault_root: Path) -> dict[str, Any]:
    """Approved resource snapshots become study subjects with stable itemId.

    With v1.0 the learning pool is driven by approved snapshots (spec §7);
    ``current_source``/``next_source`` keep a compatibility read only and no
    longer decide content. Snapshots are added as one dedicated subject; a
    snapshot whose itemId is already present is not duplicated.
    """
    snapshots = snapshot_schema.approved_snapshots(vault_root)
    if not snapshots:
        return payload
    subjects = list(payload.get("subjects") or [])
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for snapshot in snapshots:
        item_id = snapshot["itemId"]
        if item_id in seen:
            continue
        seen.add(item_id)
        base_item = {
            "id": item_id,
            "itemId": item_id,
            "abilityId": snapshot["abilityId"],
            "word": snapshot.get("summary") or item_id,
            "domain": snapshot["domain"],
            "sourceNote": snapshot["sourceNote"],
            "stateRef": snapshot["stateRef"],
            "approvedAt": snapshot["approvedAt"],
            "sourceRef": f"snapshot:{snapshot['captureId']}",
        }
        plugin_type = snapshot["pluginType"]
        required_payload: dict[str, tuple[str, ...]] = {
            "three-stage": ("word", "meaning", "example"),
            "quiz": ("prompt", "options", "answer"),
            "code": ("prompt", "initialCode", "testCode"),
            "flashcard": ("front", "back"),
        }
        required = required_payload.get(plugin_type, ())
        complete = bool(required) and all(
            isinstance(snapshot.get(field), list) and len(snapshot[field]) >= 2
            if field == "options"
            else isinstance(snapshot.get(field), str) and bool(snapshot[field].strip())
            for field in required
        )
        if complete:
            for field in ("word", "phonetic", "meaning", "context", "example", "prompt", "options", "answer", "explanation", "initialCode", "testCode", "solutionCode", "front", "back"):
                if field in snapshot:
                    base_item[field] = snapshot[field]
            base_item["pluginType"] = plugin_type
        else:
            source_note = snapshot["sourceNote"]
            base_item.update({
                "pluginType": "flashcard",
                "front": snapshot.get("summary") or item_id,
                "back": f"先完成主动回忆，再打开来源笔记核对：{source_note}",
            })
        items.append(base_item)
    if not items:
        return payload
    subjects.append({
        "id": "approved-snapshots",
        "name": "Codex 已批准捕获",
        "pluginType": "flashcard",
        "domain": "mixed",
        "items": items,
    })
    return {**payload, "subjects": subjects}


def attach_state_handles(payload: dict[str, Any], account_id: str, *, local_database) -> dict[str, Any]:
    subjects = payload.get("subjects")
    if not isinstance(subjects, list):
        return payload
    with local_database() as database:
        rows = database.execute(
            "SELECT state_ref, ability_id, state_handle FROM state_handles WHERE account_id = ?",
            (account_id,),
        ).fetchall()
    handles = {(str(state_ref), str(ability_id)): str(handle) for state_ref, ability_id, handle in rows}
    for subject in subjects:
        if not isinstance(subject, dict):
            continue
        items = subject.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            state_ref = item.get("stateRef")
            ability_id = item.get("abilityId")
            if isinstance(state_ref, str) and isinstance(ability_id, str):
                handle = handles.get((state_ref, ability_id))
                if handle:
                    item["stateHandle"] = handle
    return payload
