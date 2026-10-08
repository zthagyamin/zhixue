"""Read-only recall content/evaluation checks; shared fixtures with TypeScript.

No model calls, source writes, stored schema fields or scheduling changes.
"""
from __future__ import annotations
import math
import re
import unicodedata
from typing import Any

RECALL_EVALUATION_VERSION = "recall-evaluation-v1"

# Deterministic offline prompts; keep aligned with app/recall-content.ts.
_RECALL_TASK_RE = re.compile(r"^(?:请)?(?:区分|比较|对比|解释|说明|描述|简述|概述|写出|列出|推导|证明|分析|判断|计算|回忆|回答|为什么|为何|如何|什么|怎样)(?!了)")
_RECALL_END_RE = re.compile(r"[。.!！?？；;]+$")


def _recall_key(text: str) -> str:
    # NFC, not NFKC: do not conflate x² with x2, or erase mathematical operators.
    return _RECALL_END_RE.sub("", re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip())


def _recall_first_clause(text: str) -> str:
    closing = {"(": ")", "（": "）", "[": "]", "【": "】", "{": "}"}
    stack: list[str] = []
    for index, char in enumerate(text):
        if char in closing:
            stack.append(closing[char])
        elif stack and char == stack[-1]:
            stack.pop()
        elif not stack and char in "；;\n?？":
            return text[:index + (1 if char in "?？" else 0)].strip()
    return text.strip()


def _legacy_task_prompt(point: str) -> str | None:
    task = _recall_first_clause(point.strip())
    if task and len(task) <= 240 and (_RECALL_TASK_RE.match(task) or task.endswith(("?", "？"))):
        return f"请闭卷回答：{task}" if task.endswith(("?", "？")) else f"请闭卷回答：{_RECALL_END_RE.sub('', task)}。"
    return None


def recall_prompt(review_point: str, source_label: str = "") -> str:
    point, label = review_point.strip(), source_label.strip()
    task = _recall_first_clause(point)
    safe_label = bool(label and len(label) <= 60 and not re.search(r"[\n\r:：；;。.!！?？]", label)
                      and _recall_key(label) not in {_recall_key(point), _recall_key(task)})
    return f"阅读材料：{label if safe_label else '复习记录'}（待补具体问题）"



def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return str(value) if not isinstance(value, float) or not value.is_integer() else str(int(value))
    return ""


_WRAPPER = re.compile(r"^(?:换个角度回忆|请闭卷解释|请闭卷回答|请闭卷回忆)\s*[:：]\s*")
_LEGACY = re.compile(r"^请闭卷解释\s*[:：]\s*")
_VARIANT = re.compile(r"^换个角度回忆\s*[:：]\s*")


def _generated_point(item: dict) -> str | None:
    prompt = _text(item.get('prompt'))
    while _VARIANT.match(prompt):
        prompt = _VARIANT.sub('', prompt, count=1)
    point = _text(item.get('reviewPoint')) or (_LEGACY.sub('', prompt, count=1).strip() if _LEGACY.match(prompt) else '')
    if not point:
        return None
    references = [ref for ref in [_text(item.get('explanation')), _text(item.get('answer'))] if ref]
    copied = bool(references) and all(_recall_key(ref) == _recall_key(point) or any(ref.startswith(point + sep) for sep in ('；', ';', '\n')) for ref in references)
    if not copied:
        return None
    old = _legacy_task_prompt(point)
    if ((_LEGACY.match(prompt) and _recall_key(_LEGACY.sub('', prompt, count=1)) == _recall_key(point))
            or (old is not None and _recall_key(prompt) == _recall_key(old))
            or re.fullmatch(r"阅读材料：[\s\S]*（待补具体问题）", prompt)):
        return point
    return None


def display_recall_prompt(item: dict) -> str:
    original = _text(item.get('prompt'))
    point = _generated_point(item)
    if point is None:
        return original
    return ('换个角度回忆：' if _VARIANT.match(original) else '') + recall_prompt(point, _text(item.get('sourceLabel')))


def needs_concrete_recall_question(item: dict) -> bool:
    prompt = re.sub(r"^(?:换个角度回忆\s*[:：]\s*)+", "", display_recall_prompt(item).strip())
    return bool(re.fullmatch(r"阅读材料：[\s\S]*（待补具体问题）", prompt) or re.fullmatch(
        r"请闭卷回忆(?:「[^」]*」|这条复习记录)的核心要点，并说明相关概念、依据或适用条件[。.!！?？]*", prompt))


def is_recall_echo(reference: str, prompt: str) -> bool:
    def normalized(value: str) -> str:
        value = value.strip()
        while _WRAPPER.match(value):
            value = _WRAPPER.sub("", value, count=1)
        value = re.sub(r"^(?:参考答案|参考要点|答案|解析)\s*[:：]\s*", "", value, count=1)
        return _recall_key(value)
    question = normalized(prompt)
    return bool(question) and normalized(reference) == question


def recall_reference(item: dict, criteria=None, full_hint=None) -> str | None:
    point = _generated_point(item)
    prompt = (_legacy_task_prompt(point) if point is not None else None) or display_recall_prompt(item)
    def usable(value):
        return bool(_text(value)) and not is_recall_echo(_text(value), prompt)
    rubric = "\n".join(_text(point.get("text")) for point in (criteria or []) if usable(point.get("text")))
    for value in (item.get("explanation"), item.get("answer"), full_hint, rubric, item.get("reviewPoint")):
        if usable(value):
            return _text(value)
    return None


def validate_recall_model_evaluation(result: Any, criteria=None) -> dict:
    """AI output cannot introduce a new scheduling grade; manual ratings are separate."""
    if isinstance(result, dict) and result.get("rating") == "easy":
        raise ValueError("recall-evaluation-model-rating")
    return validate_recall_evaluation(result, criteria)


def validate_recall_evaluation(result: Any, criteria=None) -> dict:
    if not isinstance(result, dict):
        raise ValueError("recall-evaluation-invalid-result")
    if result.get("source") == "self-assess":
        raise ValueError("recall-evaluation-undetermined")
    verdicts = {"correct": "complete", "partial": "partial", "wrong": "incorrect", "incorrect": "incorrect"}
    ratings = {"again": "incorrect", "hard": "partial", "good": "complete", "easy": "complete"}
    has_verdict, has_rating = "verdict" in result, "rating" in result
    if has_verdict and (not isinstance(result["verdict"], str) or result["verdict"] not in verdicts):
        raise ValueError("recall-evaluation-invalid-verdict")
    if has_rating and (not isinstance(result["rating"], str) or result["rating"] not in ratings):
        raise ValueError("recall-evaluation-invalid-rating")
    flag = result.get("correct")
    if flag is not None and not isinstance(flag, bool):
        raise ValueError("recall-evaluation-invalid-correct")
    status = verdicts[result["verdict"]] if has_verdict else ratings[result["rating"]] if has_rating else "complete" if flag is True else "incorrect" if flag is False else None
    if status is None:
        raise ValueError("recall-evaluation-undetermined")
    if has_rating and ratings[result["rating"]] != status:
        raise ValueError("recall-evaluation-conflicting-rating")
    if flag is not None and flag != (status == "complete"):
        raise ValueError("recall-evaluation-conflicting-correct")
    coverage = None
    if criteria or "matchedPointIds" in result or "missedPointIds" in result:
        from learning_support import parse_recall_alignment
        points = criteria or []
        alignment = parse_recall_alignment(points, result.get("matchedPointIds"), result.get("missedPointIds"))
        if criteria:
            matched = set(alignment["matchedPointIds"])
            missing = [point["id"] for point in points if point.get("mandatory") and point["id"] not in matched]
            if status == "complete" and missing:
                raise ValueError("recall-evaluation-missing-mandatory")
            total = sum(point.get("weight", 1) for point in points)
            hit = sum(point.get("weight", 1) for point in points if point["id"] in matched)
            coverage = {"matched": [point["id"] for point in points if point["id"] in matched],
                        "missed": [point["id"] for point in points if point["id"] not in matched],
                        "missingMandatory": missing, "percent": math.floor(hit / total * 100 + 0.5) if total else None}
    return {"status": status, "rating": result.get("rating", {"complete": "good", "partial": "hard", "incorrect": "again"}[status]), "coverage": coverage}
