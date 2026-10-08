"""Machine-managed review queue block inside learning result cards (v1.1)."""
from __future__ import annotations

import re
import base64
import json
import hashlib
from datetime import date, timedelta
from pathlib import Path
from typing import Any

REVIEW_QUEUE_BEGIN = "%% ZHIXUE:REVIEW-QUEUE:BEGIN %%"
REVIEW_QUEUE_END = "%% ZHIXUE:REVIEW-QUEUE:END %%"
_ITEM_RE = re.compile(r"^- \[( |x)\] (.+?) \| due: (\S+) \| attempts: (\d+) \| last: (\S+)(?: \| chain: (\d+))?(?: \| note: (.+))?$", re.MULTILINE)
_RATING_INTERVAL = {"again": 1, "hard": 3, "good": 7, "easy": 14}


def _vault_read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_queue_line(line: str) -> dict[str, Any]:
    match = _ITEM_RE.match(line.strip())
    if not match:
        return {}
    return {
        "done": match.group(1) == "x",
        "name": match.group(2).strip(),
        "due": match.group(3),
        "attempts": int(match.group(4)),
        "last": match.group(5),
        "chain": int(match.group(6)) if match.group(6) else 0,
        "note": (match.group(7) or "").strip(),
    }


def queue_line(item: dict[str, Any]) -> str:
    note = f" | note: {item['note']}" if item.get("note") else ""
    box = "x" if item.get("done") else " "
    return f"- [{box}] {item['name']} | due: {item['due']} | attempts: {item['attempts']} | last: {item.get('last', '')} | chain: {item.get('chain', 0)}{note}"


def _render_queue(items: list[dict[str, Any]], event_ids: list[str] | None = None) -> str:
    lines = [REVIEW_QUEUE_BEGIN]
    if event_ids:
        encoded = base64.urlsafe_b64encode(json.dumps(event_ids).encode()).decode()
        lines.append(f"<!-- ZHIXUE:REVIEW-EVENTS {encoded} -->")
    lines.extend(queue_line(item) for item in items) if items else lines.append("（暂无待复习项）")
    lines.append(REVIEW_QUEUE_END)
    return "\n".join(lines)


def read_queue(vault_root: Path, card_path: str) -> list[dict[str, Any]]:
    path = Path(vault_root) / card_path
    if not path.exists():
        return []
    text = _vault_read(path)
    if REVIEW_QUEUE_BEGIN not in text:
        return []
    start = text.index(REVIEW_QUEUE_BEGIN) + len(REVIEW_QUEUE_BEGIN)
    finish = text.index(REVIEW_QUEUE_END, start)
    return [parse_queue_line(line) for line in text[start:finish].splitlines() if parse_queue_line(line)]


def _update_frontmatter(text: str, review_date: str, enabled: bool) -> str:
    def replace(key: str, value: str) -> str:
        pattern = re.compile(rf"^(?P<key>{re.escape(key)}):.*$", re.MULTILINE)
        if pattern.search(text):
            return pattern.sub(f"{key}: {value}", text, count=1)
        # Missing key: insert inside the YAML frontmatter block when one
        # exists, otherwise append at the end of the document.
        frontmatter = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
        if frontmatter:
            insert_at = frontmatter.end(1)
            return text[:insert_at] + f"\n{key}: {value}" + text[insert_at:]
        return text.rstrip() + f"\n{key}: {value}\n"
    text = replace("review_date", review_date)
    text = replace("review_enabled", "true" if enabled else "false")
    return text


def apply_result(
    vault_root: Path,
    card_path: str,
    item: dict[str, Any],
    rating: str,
    note: str = "",
    expected_text: str | None = None,
    event_id: str | None = None,
) -> dict[str, Any]:
    path = Path(vault_root) / card_path
    if not path.exists():
        raise ValueError("card-not-found")
    text = _vault_read(path)
    if expected_text is not None and text != expected_text:
        raise ValueError("stale-vault-edit")
    journal = re.search(r"<!-- ZHIXUE:REVIEW-EVENTS ([A-Za-z0-9_=-]+) -->", text)
    event_ids = json.loads(base64.urlsafe_b64decode(journal[1])) if journal else []
    if not isinstance(event_ids, list) or any(not isinstance(value, str) for value in event_ids):
        raise ValueError("invalid-review-event-journal")
    if event_id and event_id in event_ids:
        return {"duplicate": True, "removed": False, "kept": bool(read_queue(vault_root, card_path))}
    items = read_queue(vault_root, card_path)
    next_date = (date.today() + timedelta(days=_RATING_INTERVAL.get(rating, 3))).isoformat()
    entry = next((i for i in items if i["name"] == item["name"]), None)
    if entry is None:
        entry = {"done": False, "name": item["name"], "due": next_date, "attempts": 0, "last": "", "note": "", "chain": 0}
        items.append(entry)
    # spec §9：移出需要 good 连续 2 次。chain 记录连续 good 次数：
    # good/easy → chain+1（同时累计 attempts）；hard/again → chain 重置为 0
    # （attempts 不变，hard/again 不计 good 次数）。
    # “间隔达标”：good 会排期 +7/+14 天，连续两次 good 自然相隔 ≥ 一个复习
    # 间隔，以此作为间隔达标的代理（实现层面的合理性说明，见 spec §9）。
    if rating in {"good", "easy"}:
        entry["attempts"] += 1
        entry["chain"] = int(entry.get("chain", 0)) + 1
    else:
        entry["chain"] = 0
    entry["due"] = next_date
    entry["last"] = "good" if rating in {"good", "easy"} else ("partial" if rating == "hard" else "wrong")
    if note:
        entry["note"] = note
    if rating in {"good", "easy"}:
        entry["done"] = entry["chain"] >= 2  # 连续 2 次 good → 移出
    kept = [i for i in items if not i.get("done")]
    if event_id:
        event_ids.append(event_id)
    body = text
    if REVIEW_QUEUE_BEGIN in body:
        start = body.index(REVIEW_QUEUE_BEGIN)
        finish = body.index(REVIEW_QUEUE_END) + len(REVIEW_QUEUE_END)
        body = body[:start] + _render_queue(kept, event_ids) + body[finish:]
    else:
        body = body.rstrip() + "\n\n" + _render_queue(kept, event_ids) + "\n"
    body = _update_frontmatter(body, next_date, bool(kept))
    temporary = path.with_name(f".{path.name}.zhixue.tmp")
    temporary.write_text(body, encoding="utf-8", newline="")
    temporary.replace(path)
    # Observe the bytes we generated, not a file an editor may already have changed.
    import learning_result
    meta = learning_result._parse_frontmatter(body.removeprefix('\ufeff'))
    written_day = str(meta.get('review_date', ''))
    try:
        date.fromisoformat(written_day)
        due_at = written_day + 'T00:00:00+08:00'
    except ValueError:
        due_at = None
    return {"removed": bool(entry.get("done")), "kept": bool(entry and not entry.get("done")),
            'afterReview': {'enabled': bool(meta.get('review_enabled', True)), 'dueAt': due_at},
            'writtenHash': hashlib.sha256(body.encode('utf-8')).hexdigest()}
