"""Read mastery-assessment questions for legacy due-review items."""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

_LEVEL_HEADING_RE = re.compile(r"^##\s+([A-D])\.", re.MULTILINE)
_QUESTION_RE = re.compile(r"^(\d+)\.\s+(.+)$")
_ANSWER_RE = re.compile(r"^>\s*(\d+)(?:\s*[–-]\s*(\d+))?[：:]\s*(.+)$", re.MULTILINE)
_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
_REVIEW_HEADING_RE = re.compile(r"^##\s+复习队列[^\r\n]*\r?\n", re.MULTILINE)
_NEXT_HEADING_RE = re.compile(r"^##\s+", re.MULTILINE)
_QUESTION_REF_RE = re.compile(r"(?:(?:L(\d+))\s*)?题\s*(\d+)", re.IGNORECASE)
_LECTURE_RE = re.compile(r"第(\d+)讲")
_WEAK_MARKERS = ("薄弱", "待复习", "需复习", "不稳定", "错误", "❌")


def _normalized(value: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", value.lower())


def _similarity(left: str, right: str) -> float:
    first, second = _normalized(left), _normalized(right)
    if not first or not second:
        return 0.0
    if first in second or second in first:
        return 3.0
    left_terms = {term for term in re.findall(r"[a-z][a-z0-9_-]*", left.lower()) if len(term) > 1 and term != "vs"}
    right_terms = {term for term in re.findall(r"[a-z][a-z0-9_-]*", right.lower()) if len(term) > 1 and term != "vs"}
    shared_terms = left_terms & right_terms
    term_score = 2.0 + sum(len(term) for term in shared_terms) / 10 if shared_terms else 0.0
    return term_score + SequenceMatcher(None, first, second).ratio()


def assessment_path_for_state(vault_root: Path, state_ref: str) -> Path | None:
    relative = Path(str(state_ref).replace("\\", "/").removesuffix(".md") + ".md")
    parts = list(relative.parts)
    if "学习记录" not in parts:
        return None
    index = parts.index("学习记录")
    parts[index] = "检测与错题"
    parts[-1] = parts[-1].replace("学习状态", "掌握检测")
    candidate = Path(vault_root).joinpath(*parts)
    return candidate if candidate.is_file() else None


def _section_after(text: str, heading: re.Pattern[str]) -> str:
    match = heading.search(text)
    if not match:
        return ""
    finish = _NEXT_HEADING_RE.search(text, match.end())
    return text[match.end(): finish.start() if finish else len(text)]


def _questions(text: str) -> dict[int, dict[str, Any]]:
    questions: dict[int, dict[str, Any]] = {}
    level = ""
    for line in text.splitlines():
        heading = _LEVEL_HEADING_RE.match(line)
        if heading:
            level = heading.group(1)
            continue
        if line.startswith("> [!success]"):
            break
        match = _QUESTION_RE.match(line.strip())
        if match and level:
            questions[int(match.group(1))] = {"level": level, "prompt": match.group(2).strip()}
    return questions


def _answers(text: str) -> dict[int, str]:
    answers: dict[int, str] = {}
    for match in _ANSWER_RE.finditer(text):
        start, finish = int(match.group(1)), int(match.group(2) or match.group(1))
        for number in range(start, finish + 1):
            answers[number] = match.group(3).strip()
    return answers


def _detection_rows(text: str) -> tuple[list[int], dict[int, str]]:
    weak: list[int] = []
    remarks: dict[int, str] = {}
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 4 or not cells[0].isdigit():
            continue
        number = int(cells[0])
        remarks[number] = cells[3]
        if any(marker in cells[2] for marker in _WEAK_MARKERS):
            weak.append(number)
    return weak, remarks


def _review_records(text: str, lecture_no: int | None, weak_numbers: list[int]) -> list[dict[str, Any]]:
    section = _section_after(text, _REVIEW_HEADING_RE)
    records: list[dict[str, Any]] = []
    for line in section.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or not cells[0] or set(cells[0]) <= {"-", ":"} or cells[0] in {"薄弱点", "复习项"}:
            continue
        source = cells[1]
        reference = _QUESTION_REF_RE.search(source)
        if reference and reference.group(1) and lecture_no is not None and int(reference.group(1)) != lecture_no:
            continue
        records.append({
            "reviewPoint": re.sub(r"\*+", "", cells[0]).strip(),
            "questionNo": int(reference.group(2)) if reference else None,
            "detail": cells[2],
        })
    if records:
        return records

    ordered = re.compile(r"^(?:>\s*)?\d+\.\s+(.+)$", re.MULTILINE)
    for index, match in enumerate(ordered.finditer(section)):
        value = re.sub(r"\*+", "", match.group(1)).strip()
        title = re.split(r"[：:]", value, maxsplit=1)[0].strip()
        records.append({
            "reviewPoint": title,
            "questionNo": weak_numbers[index] if index < len(weak_numbers) else None,
            "detail": value,
        })
    return records


def parse_assessment(vault_root: Path, state_ref: str) -> dict[str, Any]:
    path = assessment_path_for_state(vault_root, state_ref)
    if path is None:
        return {}
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    questions = _questions(text)
    answers = _answers(text)
    for number, answer in answers.items():
        if number in questions:
            questions[number]["answer"] = answer
    weak_numbers, remarks = _detection_rows(text)
    lecture_match = _LECTURE_RE.search(path.name)
    lecture_no = int(lecture_match.group(1)) if lecture_match else None
    source_match = re.search(r"^source_note:\s*[\"']?(.+?)[\"']?\s*$", text, re.MULTILINE)
    source_note = ""
    if source_match:
        wikilink = _WIKILINK_RE.search(source_match.group(1))
        source_note = wikilink.group(1).strip() if wikilink else ""
    return {
        "path": str(path.relative_to(vault_root).as_posix()),
        "sourceNote": source_note,
        "questions": questions,
        "weakNumbers": weak_numbers,
        "remarks": remarks,
        "reviewRecords": _review_records(text, lecture_no, weak_numbers),
    }


def material_for_review_point(parsed: dict[str, Any], review_point: str, index: int) -> dict[str, Any]:
    questions: dict[int, dict[str, Any]] = parsed.get("questions") or {}
    if not questions:
        return {}
    records: list[dict[str, Any]] = parsed.get("reviewRecords") or []
    record: dict[str, Any] | None = None
    if records:
        def record_text(item: dict[str, Any]) -> str:
            return f"{item.get('reviewPoint', '')} {item.get('detail', '')}"
        if re.search(r"复习点\s*\d+", review_point):
            record = records[index] if index < len(records) else None
        else:
            record = max(records, key=lambda item: _similarity(review_point, record_text(item)))
            if _similarity(review_point, record_text(record)) < 0.18:
                record = records[index] if index < len(records) else None

    def question_score(item: tuple[int, dict[str, Any]]) -> float:
        _number, question = item
        return _similarity(review_point, f"{question.get('prompt', '')} {question.get('answer', '')}")

    best_number, best_question = max(questions.items(), key=question_score)
    best_score = question_score((best_number, best_question))
    number = int(record["questionNo"]) if record and record.get("questionNo") else 0
    referenced = questions.get(number) if number else None
    referenced_score = question_score((number, referenced)) if referenced else 0.0

    # Assessment review tables occasionally retain an old question number after
    # the question set is edited.  A strong term match (for example MACs or BN)
    # is safer than blindly trusting that stale reference.
    if best_score >= 2.0 and (not referenced or best_score > referenced_score + 0.25):
        number = best_number
    elif not number and best_score >= 2.0:
        number = best_number

    weak_numbers = parsed.get("weakNumbers") or []
    if not number:
        number = int(weak_numbers[index]) if index < len(weak_numbers) else sorted(questions)[min(index, len(questions) - 1)]
    question = questions.get(number)
    if not question:
        return {}

    selected_score = question_score((number, question))
    remark = str((parsed.get("remarks") or {}).get(number, "")).strip()
    use_detection_fallback = not record and selected_score < 2.0 and bool(remark)
    answer = remark if use_detection_fallback else str(question.get("answer", "")).strip()
    if not answer:
        return {}
    other_answers = [
        str(item.get("answer")) for key, item in sorted(questions.items())
        if key != number and item.get("answer") and str(item.get("answer")) != answer
    ][:3]
    return {
        "level": question.get("level", ""),
        "prompt": f"请闭卷解释并完成：{review_point}" if use_detection_fallback else question.get("prompt", review_point),
        "answer": answer,
        "wrong": other_answers,
        "explanation": answer,
        "reviewPoint": record.get("reviewPoint", review_point) if record else review_point,
        "sourceNote": parsed.get("sourceNote", ""),
        "assessmentPath": parsed.get("path", ""),
    }
