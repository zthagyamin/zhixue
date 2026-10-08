# tests/test_learning_result.py
import sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import learning_result  # noqa: E402


def make_card(text: str) -> Path:
    # 由测试 setUp 的 vault 写入
    ...


class LearningResultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.root = learning_result.result_cards_root(self.vault)
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write(self, name: str, content: str) -> Path:
        path = self.root / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_parses_frontmatter_review_points_and_wikilinks(self) -> None:
        self.write("l6-norm.md", """---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
status: active
review_date: 2026-08-18
source_note: "[[01 学习/专项课程/Stanford CS231n/课程笔记/第06讲 CNN架构与训练]]"
state_ref: "[[01 学习/专项课程/Stanford CS231n/学习记录/第06讲 学习状态]]"
---

# L6 · 归一化作用

复习要点：
- 归一化解决每层信号失控→梯度不稳；γ 缩放、β 平移
- 常见错误：误答为"治过拟合"
""")
        cards = learning_result.parse_result_cards(self.vault)
        self.assertEqual(len(cards), 1)
        card = cards[0]
        self.assertEqual(card["itemId"], "cs231n-l6-norm")
        self.assertEqual(card["domain"], "course")
        self.assertEqual(card["reviewDate"], "2026-08-18")
        self.assertEqual(len(card["reviewPoints"]), 2)
        self.assertIn("归一化解决每层信号失控", card["reviewPoints"][0])
        self.assertEqual(card["sourceNote"], "01 学习/专项课程/Stanford CS231n/课程笔记/第06讲 CNN架构与训练")
        self.assertEqual(card["stateRef"], "01 学习/专项课程/Stanford CS231n/学习记录/第06讲 学习状态")

    def test_missing_review_date_marks_disabled(self) -> None:
        self.write("disabled.md", """---
type: learning-result
domain: python
item_id: py-foo
ability_id: foo-ability
review_date: 2026-08-18
review_enabled: false
---

# 已停用

复习要点：
- 一个要点
""")
        cards = learning_result.parse_result_cards(self.vault)
        self.assertFalse(cards[0]["reviewEnabled"])

    def test_non_result_files_are_ignored(self) -> None:
        self.write("random.md", "# 不是学习结果卡\n\n普通内容\n")
        self.assertEqual(learning_result.parse_result_cards(self.vault), [])

    def test_wikilink_target_strips_alias(self) -> None:
        self.assertEqual(learning_result.wikilink_target("[[a/b.md|别名]]"), "a/b.md")
        self.assertEqual(learning_result.wikilink_target("plain.md"), None)
