"""Pure generated-study normalization; defaults and clock are explicit inputs."""
from __future__ import annotations
import json
from typing import Any, Callable

def ensure_subject_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep legacy seed/install data readable by the plugin-driven website."""
    if isinstance(payload.get("subjects"), list) and payload["subjects"]:
        return payload
    subjects: list[dict[str, Any]] = []
    words = [item for item in payload.get("words", []) if isinstance(item, dict)]
    if words:
        subjects.append({
            "id": "ielts-vocabulary",
            "name": "IELTS 核心词汇",
            "pluginType": "three-stage",
            "domain": "ielts",
            "items": words,
        })
    topics = [str(item).strip() for item in payload.get("pythonTopics", []) if str(item).strip()]
    if topics:
        subjects.append({
            "id": "python-review-topics",
            "name": "Python 复习主题",
            "pluginType": "flashcard",
            "domain": "python",
            "items": [
                {
                    "id": f"python-topic-{index + 1}",
                    "front": topic,
                    "back": "根据自己的学习笔记，回忆这个主题的核心规则与一个例子。",
                    "tags": ["Python", "复习"],
                }
                for index, topic in enumerate(topics)
            ],
        })
    return {**payload, "contentMode": payload.get("contentMode", "demo"), "subjects": subjects}


def validate_cards(payload: dict[str, Any], title: str, scope: str, *, seed: dict, stamp: Callable[[str], str], code_material_available: Callable[[Any], bool]) -> dict[str, Any]:
    raw_subjects = payload.get("subjects")
    if not isinstance(raw_subjects, list) or not raw_subjects:
        legacy_words = payload.get("words", [])
        raw_subjects = [{
            "id": "ielts-vocabulary",
            "name": "IELTS 核心词汇",
            "pluginType": "three-stage",
            "domain": "ielts",
            "items": legacy_words,
        }]

    subjects: list[dict[str, Any]] = []
    allowed_plugins = {"three-stage", "quiz", "recall", "calculation", "code", "flashcard"}
    for subject_index, raw_subject in enumerate(raw_subjects[:8]):
        if not isinstance(raw_subject, dict):
            continue
        plugin_type = str(raw_subject.get("pluginType", "")).strip()
        if plugin_type not in allowed_plugins:
            continue
        items: list[dict[str, Any]] = []
        raw_items = raw_subject.get("items", [])
        if not isinstance(raw_items, list):
            continue
        for item_index, raw_item in enumerate(raw_items[:24]):
            if not isinstance(raw_item, dict):
                continue
            item_plugin = str(raw_item.get("pluginType") or raw_item.get("type") or plugin_type).strip()
            if item_plugin not in allowed_plugins:
                continue
            item_id = str(raw_item.get("id") or f"item-{subject_index + 1}-{item_index + 1}").strip()
            normalized: dict[str, Any] | None = None
            if item_plugin == "three-stage" and raw_item.get("word") and raw_item.get("meaning"):
                distractors = [str(value).strip() for value in raw_item.get("distractors", []) if str(value).strip()][:3]
                while len(distractors) < 3:
                    distractors.append(["语境不符", "含义相反", "其他概念"][len(distractors)])
                word = str(raw_item["word"]).strip()
                normalized = {
                    "id": item_id,
                    "word": word,
                    "phonetic": str(raw_item.get("phonetic", "")).strip(),
                    "meaning": str(raw_item["meaning"]).strip(),
                    "context": str(raw_item.get("context", "来自当前学习材料的重点表达。")).strip(),
                    "example": str(raw_item.get("example", f"This material uses the word {word} in an academic context.")).strip(),
                    "source": str(raw_item.get("source", title)).strip(),
                    "level": str(raw_item.get("level", "Academic")).strip(),
                    "distractors": distractors,
                }
            elif item_plugin == "quiz" and raw_item.get("prompt") and raw_item.get("answer"):
                options = [str(value).strip() for value in raw_item.get("options", []) if str(value).strip()][:6]
                answer = str(raw_item["answer"]).strip()
                if len(options) >= 2 and answer in options:
                    normalized = {
                        "id": item_id,
                        "topic": str(raw_item.get("topic", raw_subject.get("name", "学习测验"))).strip(),
                        "prompt": str(raw_item["prompt"]).strip(),
                        "options": options,
                        "answer": answer,
                        "explanation": str(raw_item.get("explanation", "依据当前学习资料判断。")).strip(),
                    }
                    if raw_item.get("code"):
                        normalized["code"] = str(raw_item["code"])
            elif item_plugin == "code" and raw_item.get("prompt") and code_material_available(raw_item):
                normalized = {
                    "id": item_id,
                    "topic": str(raw_item.get("topic", raw_subject.get("name", "编程练习"))).strip(),
                    "prompt": str(raw_item["prompt"]).strip(),
                    "initialCode": str(raw_item["initialCode"]),
                    "solutionCode": str(raw_item.get("solutionCode", "")),
                    "explanation": str(raw_item.get("explanation", "依据测试用例验证实现。")).strip(),
                }
                if "testCode" in raw_item:
                    normalized["testCode"] = raw_item["testCode"]
                if isinstance(raw_item.get("learningSupport"), dict) and raw_item["learningSupport"].get("type") == "code":
                    normalized["learningSupport"] = json.loads(json.dumps(raw_item["learningSupport"]))
            elif item_plugin == "flashcard" and raw_item.get("front") is not None and raw_item.get("back") is not None:
                normalized = {
                    "id": item_id,
                    "front": str(raw_item["front"]),
                    "back": str(raw_item["back"]),
                    "tags": [str(value).strip() for value in raw_item.get("tags", []) if str(value).strip()][:8],
                }
            elif item_plugin == "recall" and str(raw_item.get("prompt", "")).strip():
                normalized = {
                    "id": item_id,
                    "prompt": str(raw_item["prompt"]).strip(),
                    "explanation": str(raw_item.get("explanation") or raw_item.get("reviewPoint") or raw_item.get("answer") or "请根据学习材料核对要点。").strip(),
                }
            elif item_plugin == "calculation" and str(raw_item.get("prompt", "")).strip() and raw_item.get("answer") is not None:
                answer = raw_item["answer"]
                if isinstance(answer, (int, float)) or str(answer).strip():
                    normalized = {
                        "id": item_id,
                        "prompt": str(raw_item["prompt"]).strip(),
                        "answer": answer if isinstance(answer, (int, float)) else str(answer).strip(),
                        "explanation": str(raw_item.get("explanation", "依据学习材料中的公式与步骤计算。")).strip(),
                    }
                    if isinstance(raw_item.get("tolerance"), (int, float)):
                        normalized["tolerance"] = raw_item["tolerance"]
            if normalized is not None:
                for metadata_key in ("itemId", "abilityId", "sourceNote", "stateRef", "sourceLabel"):
                    metadata_value = raw_item.get(metadata_key)
                    if isinstance(metadata_value, str) and metadata_value.strip():
                        normalized[metadata_key] = metadata_value.strip()
                if item_plugin != plugin_type:
                    normalized["pluginType"] = item_plugin
                items.append(normalized)
        if not items:
            continue
        subject: dict[str, Any] = {
            "id": str(raw_subject.get("id") or f"subject-{subject_index + 1}").strip(),
            "name": str(raw_subject.get("name") or f"学习主题 {subject_index + 1}").strip(),
            "pluginType": plugin_type,
            "items": items,
        }
        domain = str(raw_subject.get("domain", "")).strip()
        if domain and len(domain) <= 80 and not any(ord(character) < 32 for character in domain):
            subject["domain"] = domain
        subjects.append(subject)

    if not subjects:
        raise ValueError("AI 没有返回可用的学习主题或题目。")

    tomorrow = []
    raw_tomorrow = payload.get("tomorrow", [])
    if not isinstance(raw_tomorrow, list):
        raw_tomorrow = []
    for item in raw_tomorrow[:6]:
        if isinstance(item, dict) and item.get("word") and item.get("meaning"):
            tomorrow.append({
                "word": str(item["word"]).strip(),
                "meaning": str(item["meaning"]).strip(),
                "reason": str(item.get("reason", "下一学习来源")).strip(),
            })

    return {
        "status": "connected",
        "contentMode": "personal",
        "syncedAt": stamp("%Y-%m-%dT%H:%M:%S%z"),
        "source": {"title": title, "path": "已授权的本地来源", "scope": scope},
        "subjects": subjects,
        "tomorrow": tomorrow or seed.get("tomorrow", []),
    }
