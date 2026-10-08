"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations

from typing import Any


def normalize_question_subjects(payload: dict[str, Any]) -> dict[str, Any]:
    """生成的题目科目按题型×领域归并到稳定科目：quiz+ielts 统一为阅读理
    解专项（reading-comprehension），recall+paper 统一为论文核心观点
    （paper-core-viewpoints）。历次内容生成各自发明科目 id/名称的重复卡
    在此收敛，条目按 topic/prompt/abilityId 去重。"""
    subjects = list(payload.get("subjects") or [])
    merged: dict[str, dict[str, Any]] = {}
    kept: list[dict[str, Any]] = []

    def family_of(subject: dict[str, Any]) -> str | None:
        plugin = str(subject.get("pluginType", ""))
        domain = str(subject.get("domain", ""))
        subject_id = str(subject.get("id", ""))
        legacy_reading = not domain and subject.get("name") in {"核心概念理解", "阅读理解专项"}
        if plugin == "quiz" and (domain in {"ielts", "paper"} or legacy_reading or subject_id == "reading-comprehension"):
            if plugin == "quiz":
                return "reading-comprehension"
        if plugin == "recall" and (domain == "paper" or subject_id == "paper-core-viewpoints"):
            return "paper-core-viewpoints"
        return None

    def item_key(item: dict[str, Any]) -> str:
        return str(item.get("itemId") or item.get("prompt") or item.get("topic") or item.get("abilityId") or item.get("word") or "")

    for subject in subjects:
        if not isinstance(subject, dict):
            kept.append(subject)
            continue
        family = family_of(subject)
        targets = {
            "reading-comprehension": {"id": "reading-comprehension", "name": "阅读理解专项", "pluginType": "quiz", "domain": "ielts"},
            "paper-core-viewpoints": {"id": "paper-core-viewpoints", "name": "论文核心观点", "pluginType": "recall", "domain": "paper"},
        }
        if family is None:
            kept.append(subject)
            continue
        bucket = merged.setdefault(family, {**targets[family], "items": []})
        existing_keys = {item_key(item) for item in bucket["items"]}
        for item in subject.get("items") or []:
            key = item_key(item)
            if not key or key in existing_keys:
                continue
            existing_keys.add(key)
            bucket["items"].append(item)

    return {**payload, "subjects": kept + list(merged.values())}
