"""Unified practice item engine: review points -> typed questions (v1.1)."""
from __future__ import annotations

import hashlib
import re
from datetime import date
from pathlib import Path
from typing import Any, Callable

import assessment_material
import learning_result
from recall_quality import recall_prompt, recall_reference, display_recall_prompt, validate_recall_model_evaluation, needs_concrete_recall_question

_FORMULA_RE = re.compile(r"[$∂Σ√×÷=^]|\d+\.\d+|\b\d+\b")
_CODE_HINT_RE = re.compile(r"(?i)(实现|代码|函数|反传|梯度)|\b(API|class|def|import)\b")
_LEVEL_TO_TYPE = {"A": "quiz", "B": "quiz", "C": "calculation", "D": "quiz"}


def fingerprint_for(review_point: str, source_note: str) -> str:
    raw = f"{review_point}::{source_note}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def select_question_type(review_point: str, materials: dict[str, Any], plugin_hint: str | None = None) -> str:
    level = str(materials.get("level", ""))
    if level in _LEVEL_TO_TYPE:
        return _LEVEL_TO_TYPE[level]
    if plugin_hint in {"quiz", "recall", "calculation", "code"}:
        # 结果卡显式声明的题型优先于内容猜测：卡作者比正则更了解意图。
        return plugin_hint
    if _FORMULA_RE.search(review_point):
        return "calculation"
    if _CODE_HINT_RE.search(review_point):
        return "code"
    if plugin_hint in {"quiz", "recall", "calculation", "code"}:
        return plugin_hint
    return "quiz"


def build_base_item(card: dict[str, Any], materials: dict[str, Any]) -> dict[str, Any]:
    review_point = (card.get("reviewPoints") or [""])[0]
    question_type = select_question_type(review_point, materials, card.get("pluginHint"))
    source_label = str(card.get("title") or card.get("itemId", ""))
    if question_type == "quiz" and materials.get("prompt") and materials.get("answer"):
        options = [str(materials["answer"])]
        for wrong in (materials.get("wrong") or [])[:3]:
            if str(wrong) not in options:
                options.append(str(wrong))
        while len(options) < 2:
            options.append(f"（以上都不是）")
        return {
            "itemId": card["itemId"], "abilityId": card["abilityId"], "domain": card["domain"],
            "sourceNote": card.get("sourceNote", ""), "stateRef": card.get("stateRef", ""),
            "questionType": "quiz", "prompt": str(materials["prompt"]), "options": options,
            "answer": 0, "explanation": str(materials.get("explanation") or materials.get("answer", "")),
            "reviewPoint": review_point, "fingerprint": fingerprint_for(review_point, card.get("sourceNote", "")),
            "sourceLabel": source_label,
        }
    if materials.get("prompt") and materials.get("answer"):
        return {
            "itemId": card["itemId"], "abilityId": card["abilityId"], "domain": card["domain"],
            "sourceNote": materials.get("sourceNote") or card.get("sourceNote", ""),
            "stateRef": card.get("stateRef", ""), "questionType": question_type,
            "prompt": str(materials["prompt"]), "answer": str(materials["answer"]),
            "explanation": str(materials.get("explanation") or materials["answer"]),
            "reviewPoint": review_point,
            "fingerprint": fingerprint_for(review_point, card.get("sourceNote", "")),
            "sourceLabel": source_label,
        }
    # 兜底：无原题素材。quiz 概念点降级 recall（spec §7：不伪造选项）；
    # calculation/code 以复习要点本身为答案内容（复习要点即知识库素材）。
    answer = "；".join(card.get("reviewPoints", []))
    fallback_type = question_type if question_type in {"calculation", "code"} else "recall"
    # Keep source notes on the answer side; never leak them into a recall prompt.
    prompt = recall_prompt(review_point, source_label) if fallback_type == "recall" else review_point
    return {
        "itemId": card["itemId"], "abilityId": card["abilityId"], "domain": card["domain"],
        "sourceNote": card.get("sourceNote", ""), "stateRef": card.get("stateRef", ""),
        "questionType": fallback_type, "prompt": prompt, "answer": answer,
        "explanation": answer or "对照来源笔记复习。", "reviewPoint": review_point,
        "fingerprint": fingerprint_for(review_point, card.get("sourceNote", "")), "sourceLabel": source_label,
    }


def _normalized_path(value: str) -> str:
    return str(value or "").replace("\\", "/").removesuffix(".md").lower()


def _normalized_point(value: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(value or "").lower())


def _legacy_card(study_item: dict[str, Any]) -> dict[str, Any]:
    review_point = str(study_item.get("front") or study_item.get("prompt") or study_item.get("itemId") or "复习项")
    return {
        "itemId": str(study_item.get("itemId") or study_item.get("id") or "due:legacy"),
        "abilityId": str(study_item.get("abilityId") or study_item.get("id") or ""),
        "domain": str(study_item.get("domain") or "course"),
        "sourceNote": str(study_item.get("sourceNote") or ""),
        "stateRef": str(study_item.get("stateRef") or ""),
        "reviewPoints": [review_point],
    }


def practice_items(vault_root: Path, legacy_items: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    today = date.today().isoformat()
    items: list[dict[str, Any]] = []
    cards = learning_result.parse_result_cards(vault_root)
    for card in cards:
        if not card["reviewEnabled"] or not card["reviewDate"] or card["reviewDate"] > today:
            continue
        parsed = assessment_material.parse_assessment(vault_root, str(card.get("stateRef", "")))
        materials = assessment_material.material_for_review_point(
            parsed, str((card.get("reviewPoints") or [""])[0]), 0
        )
        items.append({**build_base_item(card, materials), "dueAt": card["reviewDate"]})
    if legacy_items:
        # 渐进迁移（spec §4.2/§4.3）：结果卡只覆盖同一能力；尚未迁移的
        # learning-state/assessment 条目继续出题，不能因第一张卡而整体消失。
        migrated_ids = {str(card.get("itemId", "")) for card in cards}
        migrated_abilities = {str(card.get("abilityId", "")) for card in cards}
        migrated_pairs = {
            (_normalized_path(str(card.get("stateRef", ""))), _normalized_point(point))
            for card in cards for point in (card.get("reviewPoints") or [])
        }
        for legacy_entry in legacy_items:
            study_items = legacy_entry.get("studyItems") or [legacy_entry]
            state_ref = str((study_items[0] if study_items else {}).get("stateRef") or legacy_entry.get("path") or "")
            parsed = assessment_material.parse_assessment(vault_root, state_ref)
            for index, study_item in enumerate(study_items):
                card = _legacy_card(study_item)
                identity = (_normalized_path(card["stateRef"]), _normalized_point(card["reviewPoints"][0]))
                if card["itemId"] in migrated_ids or card["abilityId"] in migrated_abilities or identity in migrated_pairs:
                    continue
                materials = assessment_material.material_for_review_point(parsed, card["reviewPoints"][0], index)
                item = build_base_item(card, materials)
                item["sourceLabel"] = str(study_item.get("sourceLabel") or item.get("sourceLabel") or "Obsidian 到期复习")
                items.append(item)
    # Result cards use wikilink targets without a suffix; all UI entry points
    # must receive the same resolvable Markdown path, not silently drop mapping.
    for item in items:
        for field in ("sourceNote", "stateRef"):
            ref = str(item.get(field) or "").strip().replace("\\", "/")
            item[field] = ref if not ref or ref.lower().endswith(".md") else ref + ".md"
    return items


def _relative_error(actual: float, expected: float) -> float:
    if expected == 0:
        return abs(actual - expected)
    return abs(actual - expected) / abs(expected)


def _bounded_text(value: Any, limit: int = 240) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _bounded_points(value: Any, limit: int = 5) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    points: list[str] = []
    for point in value:
        text = _bounded_text(point, 160)
        if text and text not in points:
            points.append(text)
        if len(points) >= limit:
            break
    return points


def self_assess_result(explanation: str, ai_fallback: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "correct": None,
        "verdict": "self-assess",
        "source": "self-assess",
        "explanation": explanation,
    }
    if ai_fallback:
        result["aiFallback"] = True
    return result


def normalize_recall_grade(payload: Any, explanation: str = "", source: str = "ai", criteria=None) -> dict[str, Any]:
    """Normalize a model response into the small, auditable recall-grade contract.

    The model is allowed to use either snake_case or camelCase point fields, but
    the browser always receives camelCase. Verdict is deliberately reduced to
    three states so partial knowledge can become an FSRS ``hard`` rating rather
    than being treated as a binary failure.
    """
    if not isinstance(payload, dict):
        raise ValueError("回忆判题返回不是 JSON 对象")
    raw_verdict = str(payload.get("verdict", "")).strip().lower()
    verdict_aliases = {
        "correct": "correct", "right": "correct", "完整": "correct", "正确": "correct",
        "partial": "partial", "partially_correct": "partial", "mostly": "partial", "部分": "partial", "部分正确": "partial",
        "wrong": "wrong", "incorrect": "wrong", "false": "wrong", "错误": "wrong", "不正确": "wrong",
    }
    verdict = verdict_aliases.get(raw_verdict)
    candidate = dict(payload)
    if verdict is not None:
        candidate["verdict"] = verdict
    # A malformed or contradictory model result is not a student failure.
    evaluated = validate_recall_model_evaluation(candidate, criteria)
    verdict = {"complete": "correct", "partial": "partial", "incorrect": "wrong"}[evaluated["status"]]

    confidence_value = payload.get("confidence")
    try:
        confidence = max(0.0, min(1.0, float(confidence_value)))
    except (TypeError, ValueError):
        confidence = None

    feedback = _bounded_text(payload.get("feedback") or payload.get("explanation") or explanation)
    matched = _bounded_points(payload.get("matched_points", payload.get("matchedPoints")))
    missed = _bounded_points(payload.get("missed_points", payload.get("missedPoints")))
    result: dict[str, Any] = {
        "correct": verdict == "correct",
        "verdict": verdict,
        "rating": evaluated["rating"],
        "source": source,
        "feedback": feedback,
        "explanation": feedback or explanation,
        "matchedPoints": matched,
        "missedPoints": missed,
    }
    if criteria:
        from learning_support import parse_recall_alignment
        result.update(parse_recall_alignment(criteria, payload.get('matchedPointIds'), payload.get('missedPointIds')))
    if confidence is not None:
        result["confidence"] = confidence
    return result


def grade_answer(
    item: dict[str, Any],
    answer: Any,
    ai_available: bool = True,
    recall_grader: Callable[[dict[str, Any], Any], Any] | None = None,
) -> dict[str, Any]:
    qtype = item.get("questionType")
    support = item.get('learningSupport')
    if isinstance(support, dict) and support.get('schemaVersion') == 2 and support.get('type') in ('recall','quiz'):
        raise ValueError('course-task-evaluation-unavailable')
    explanation = str(item.get("explanation", ""))
    if qtype == "quiz":
        correct = isinstance(answer, int) and answer == int(item.get("answer", -1))
        return {"correct": correct, "verdict": "correct" if correct else "wrong", "explanation": explanation}
    if qtype == "calculation":
        if (item.get('learningSupport') or {}).get('type')=='calculation':
            from calculation_grade import grade_calculation_reference
            return grade_calculation_reference(item,answer)
        try:
            actual = float(answer)
            expected = float(item.get("answer"))
            correct = _relative_error(actual, expected) <= 1e-6
            return {"correct": correct, "verdict": "correct" if correct else "wrong", "explanation": explanation}
        except (TypeError, ValueError):
            # P2：期望答案可能是复习要点文本（I1 的无素材公式点），没有客观数值
            # 可比——降级自评（spec §8：表达式不匹配 → 自评），不能判永远 wrong。
            return self_assess_result(explanation)
    if qtype == "recall":
        if needs_concrete_recall_question(item):
            return self_assess_result("这份材料尚未提供具体问题，已暂停自测；没有调用 AI。")
        from learning_support import parse_learning_support
        try:
            support = parse_learning_support(item["learningSupport"], "recall") if item.get("learningSupport") else {}
        except (ValueError, TypeError):
            return self_assess_result("本题学习配置不可用，请核对来源。")
        criteria = support.get("criteria")
        hints = support.get("hints") or []
        reference = recall_reference(item, criteria, hints[2] if len(hints) == 3 else None)
        if reference is None:
            return self_assess_result("本题缺少可核对的参考要点，没有调用 AI，也不会自动计分。")
        if ai_available and recall_grader is not None:
            try:
                # Presentation/reference repair is a copy, not a content or identity write.
                grounded = {**item, "prompt": display_recall_prompt(item), "answer": reference, "explanation": reference}
                grounded.pop("reviewPoint", None)
                return normalize_recall_grade(recall_grader(grounded, answer), explanation=reference, criteria=criteria)
            except Exception:
                # Provider, schema and evidence failures all remain undetermined.
                return self_assess_result(reference, ai_fallback=True)
        return self_assess_result(reference)
    return self_assess_result(explanation)


def variant_for(item: dict[str, Any], attempt: int) -> dict[str, Any]:
    variant = dict(item)
    qtype = item.get("questionType")
    if qtype == "quiz":
        if (item.get('learningSupport') or {}).get('type') == 'quiz':
            return variant
        options = list(item["options"])
        shift = (attempt % max(1, len(options) - 1)) + 1
        rotated = options[shift:] + options[:shift]
        variant["options"] = rotated
        variant["answer"] = rotated.index(item["options"][int(item.get("answer", 0))])
    elif qtype == "calculation":
        # Arbitrary source text has no parameterized solver contract. Preserve it.
        return variant
    elif qtype == "recall":
        # Preserve the legacy prefix understood by the recall quality boundary.
        variant["prompt"] = f"换个角度回忆：{item['prompt']}"
    return variant


def item_to_review_entry(item: dict[str, Any]) -> dict[str, Any]:
    return {"name": str(item.get("reviewPoint") or item.get("itemId", "复习项"))}
