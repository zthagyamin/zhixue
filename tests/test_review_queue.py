# tests/test_review_queue.py
import sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import review_queue  # noqa: E402
import learning_result  # noqa: E402


class ReviewQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.root = self.vault / "01 学习/学习结果"
        self.root.mkdir(parents=True)
        self.card = self.root / "l6-norm.md"
        self.card.write_text("""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2026-08-18
---

# L6 · 归一化作用

复习要点：
- 一个要点
""", encoding="utf-8")
        self.rel = "01 学习/学习结果/l6-norm.md"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_apply_again_keeps_and_appends_note(self) -> None:
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "again", note="误答为治过拟合")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["name"], "归一化作用")
        self.assertEqual(queue[0]["last"], "wrong")
        self.assertEqual(queue[0]["note"], "误答为治过拟合")
        self.assertEqual(queue[0]["attempts"], 0)  # again does not count as a good pass

    def test_apply_good_twice_removes_from_queue(self) -> None:
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(queue, [])
        text = self.card.read_text(encoding="utf-8")
        self.assertIn("review_enabled: false", text)

    def test_stale_edit_is_rejected(self) -> None:
        original = self.card.read_text(encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale"):
            review_queue.apply_result(self.vault, self.rel, {"name": "X"}, "again", note="n", expected_text="不同内容")
        self.assertEqual(self.card.read_text(encoding="utf-8"), original)

    def test_managed_block_preserves_user_text_outside(self) -> None:
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "again", note="错")
        text = self.card.read_text(encoding="utf-8")
        self.assertIn("# L6 · 归一化作用", text)
        self.assertIn("复习要点：", text)

    def test_missing_review_enabled_written_inside_frontmatter(self) -> None:
        # setUp card has no review_enabled key; after the queue empties the
        # key must land inside the YAML block so parse_result_cards sees it.
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        text = self.card.read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1]
        self.assertIn("review_enabled: false", frontmatter)
        cards = learning_result.parse_result_cards(self.vault)
        card = next(c for c in cards if c["itemId"] == "cs231n-l6-norm")
        self.assertFalse(card["reviewEnabled"])

    def test_again_then_good_keeps_until_second_good(self) -> None:
        # spec §9: removal needs 2 good passes — a good right after an again
        # must keep the entry in the queue.
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "again", note="误答")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["attempts"], 1)
        self.assertEqual(queue[0]["chain"], 1)
        self.assertFalse(queue[0]["done"])
        self.assertNotIn("review_enabled: false", self.card.read_text(encoding="utf-8"))
        # second good removes the entry
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(queue, [])
        self.assertIn("review_enabled: false", self.card.read_text(encoding="utf-8"))

    def test_good_again_good_does_not_remove_entry(self) -> None:
        # spec §9: 移出需要 good 连续 2 次——good→again→good 里 chain 被重置，
        # 第二次 good 不连续，条目必须保留（当前实现按累计 attempts 会错误移除）。
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "again", note="又忘了")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["chain"], 1)
        self.assertEqual(queue[0]["attempts"], 2)
        self.assertFalse(queue[0]["done"])
        self.assertNotIn("review_enabled: false", self.card.read_text(encoding="utf-8"))
        # 接下来再一次 good → 连续 2 次 → 移出
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(queue, [])

    def test_hard_resets_consecutive_good_chain(self) -> None:
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "good")
        review_queue.apply_result(self.vault, self.rel, {"name": "归一化作用"}, "hard")
        queue = review_queue.read_queue(self.vault, self.rel)
        self.assertEqual(queue[0]["chain"], 0)
        self.assertEqual(queue[0]["attempts"], 1)  # hard 不计 good 次数
        self.assertEqual(queue[0]["last"], "partial")

    def test_queue_line_roundtrips_chain_field(self) -> None:
        line = review_queue.queue_line({
            "done": False, "name": "归一化作用", "due": "2026-08-26",
            "attempts": 1, "last": "good", "chain": 1, "note": "",
        })
        self.assertIn("chain: 1", line)
        parsed = review_queue.parse_queue_line(line)
        self.assertEqual(parsed["chain"], 1)
        self.assertEqual(parsed["attempts"], 1)
