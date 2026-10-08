from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import state_projection  # noqa: E402


def attempt(event_id: str, occurred_at: str, correct: bool) -> dict:
    return {
        "eventId": event_id,
        "occurredAt": occurred_at,
        "eventType": "practice-attempt",
        "domain": "ielts",
        "item": {"kind": "word", "key": "word-1"},
        "attempt": {"rating": "good" if correct else "again", "correct": correct},
    }


class StateProjectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
        self.state_note = self.vault / self.state_ref
        self.state_note.parent.mkdir(parents=True)
        self.state_note.write_text(
            "---\ntype: learning-state\n---\n# 学习状态\n\n这是我的人工判断。\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_two_correct_retrievals_24_hours_apart_become_stable_evidence(self) -> None:
        result = state_projection.project_mapped_events(
            self.vault,
            self.state_ref,
            "ability-1",
            [
                attempt("e-1", "2026-08-20T08:00:00Z", True),
                attempt("e-2", "2026-08-21T08:01:00Z", True),
            ],
        )
        content = self.state_note.read_text(encoding="utf-8")
        self.assertEqual(result.status, "stable-evidence")
        self.assertIn("这是我的人工判断。", content)
        self.assertIn("stable-evidence", content)
        self.assertNotIn("mastered", content.lower())

    def test_later_failure_resets_stable_evidence(self) -> None:
        result = state_projection.project_mapped_events(
            self.vault,
            self.state_ref,
            "ability-1",
            [
                attempt("e-2", "2026-08-21T08:01:00Z", True),
                attempt("e-3", "2026-08-22T09:00:00Z", False),
                attempt("e-1", "2026-08-20T08:00:00Z", True),
            ],
        )
        self.assertEqual(result.status, "needs-review")

    def test_again_rating_is_negative_even_if_correct_flag_is_inconsistent(self) -> None:
        inconsistent = attempt("e-1", "2026-08-20T08:00:00Z", True)
        inconsistent["attempt"]["rating"] = "again"
        result = state_projection.project_mapped_events(
            self.vault,
            self.state_ref,
            "ability-1",
            [inconsistent],
        )
        self.assertEqual(result.status, "needs-review")

    def test_projection_preserves_crlf_outside_managed_block(self) -> None:
        self.state_note.write_bytes(b"---\r\ntype: learning-state\r\n---\r\n# state\r\n\r\nuser text\r\n")
        state_projection.project_mapped_events(
            self.vault,
            self.state_ref,
            "ability-1",
            [attempt("e-1", "2026-08-20T08:00:00Z", True)],
        )
        self.assertIn(b"user text\r\n", self.state_note.read_bytes())

    def test_one_correct_attempt_is_reviewed_and_projection_is_idempotent(self) -> None:
        events = [attempt("e-1", "2026-08-20T08:00:00Z", True)]
        first = state_projection.project_mapped_events(self.vault, self.state_ref, "ability-1", events)
        previous = self.state_note.read_bytes()
        second = state_projection.project_mapped_events(self.vault, self.state_ref, "ability-1", events)
        self.assertEqual(first.status, "reviewed")
        self.assertEqual(second.status, "reviewed")
        self.assertEqual(self.state_note.read_bytes(), previous)

    def test_invalid_or_non_state_target_is_refused_without_write(self) -> None:
        self.state_note.write_text("# 普通笔记\n\n不要修改\n", encoding="utf-8")
        before = self.state_note.read_bytes()
        with self.assertRaisesRegex(ValueError, "invalid-learning-state-note"):
            state_projection.project_mapped_events(
                self.vault,
                self.state_ref,
                "ability-1",
                [attempt("e-1", "2026-08-20T08:00:00Z", True)],
            )
        self.assertEqual(self.state_note.read_bytes(), before)

    def _write_result_card(self, item_id: str, state_ref: str, points: list[str]) -> str:
        root = self.vault / "01 学习/学习结果"
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{item_id}.md"
        points_text = "\n".join(f"- {point}" for point in points)
        path.write_text(
            f"""---
type: learning-result
domain: course
item_id: {item_id}
ability_id: ability-1
review_date: 2026-08-18
state_ref: "{state_ref}"
---

# {item_id}

复习要点：
{points_text}
""",
            encoding="utf-8",
        )
        return "01 学习/学习结果/" + path.name

    def test_result_card_for_state_matches_prefixed_practice_item_key(self) -> None:
        card_path = self._write_result_card("cs231n-l6-norm", "[[s.md]]", ["归一化作用"])
        self.assertEqual(
            state_projection.result_card_for_state(
                self.vault,
                "s.md",
                item_id="practice:cs231n-l6-norm",
            ),
            card_path,
        )

    def test_result_card_for_state_normalizes_state_ref_md_suffix_and_wikilinks(self) -> None:
        card_path = self._write_result_card(
            "other-item", "[[01 学习/专项课程/Test/学习记录/第06讲 学习状态]]", ["要点"]
        )
        self.assertEqual(
            state_projection.result_card_for_state(
                self.vault,
                "01 学习/专项课程/Test/学习记录/第06讲 学习状态.md",
                item_id="word-1",
                ability_id="ability-1",
            ),
            card_path,
        )

    def test_result_card_for_state_returns_none_without_any_match(self) -> None:
        self._write_result_card("cs231n-l6-norm", "[[s.md]]", ["归一化作用"])
        self.assertIsNone(
            state_projection.result_card_for_state(
                self.vault,
                "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
                item_id="word-1",
            )
        )


if __name__ == "__main__":
    unittest.main()
