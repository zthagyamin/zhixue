from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import source_area  # noqa: E402


class SourceAreaParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.sources = self.root / "_System/Integrations/Study Loop/sources"
        self.sources.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_source(self, relative: str, content: str) -> Path:
        path = self.sources / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_vocabulary_table_rows_become_study_items(self) -> None:
        self.write_source("知学资料.md", """---
type: study-loop-source
status: active
updated: 2026-08-25
---

# 知学资料

## 词汇

| 单词/词组 | 释义 | 原文语境 | 来源笔记 |
|---|---|---|---|
| pooling layer | 池化层 | Pooling layers in CNNs summarize ... | [[02 项目与研究/论文阅读/P2|P2]] |
| overfit | 过拟合 | models find it slightly more difficult to overfit | [[P2]] |
""")
        items = source_area.parse_source_area(self.root)
        self.assertEqual(len(items), 2)
        first = items[0]
        self.assertEqual(first["word"], "pooling layer")
        self.assertEqual(first["meaning"], "池化层")
        self.assertEqual(first["context"], "Pooling layers in CNNs summarize ...")
        self.assertEqual(first["sourceNote"], "02 项目与研究/论文阅读/P2.md")
        self.assertTrue(first["abilityId"])

    def test_quiz_table_rows_become_quiz_items(self) -> None:
        self.write_source("题目.md", """---
type: study-loop-source
status: active
---

# 题目

## 选择题

| 主题 | 题干 | 选项 | 答案 | 解析 |
|---|---|---|---|---|
| CNN 池化 | 相邻池化单元的区域关系是？ | 重叠；不重叠；随机；未知 | 不重叠 | 传统 non-overlapping pooling 中相邻单元区域不重叠 |
""")
        items = source_area.parse_source_area(self.root)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["topic"], "CNN 池化")
        self.assertEqual(item["prompt"], "相邻池化单元的区域关系是？")
        self.assertEqual(item["options"], ["重叠", "不重叠", "随机", "未知"])
        self.assertEqual(item["answer"], "不重叠")
        self.assertEqual(item["explanation"], "传统 non-overlapping pooling 中相邻单元区域不重叠")

    def test_python_code_table_rows_become_renderable_code_items(self) -> None:
        self.write_source("Python Day 001.md", """---
type: study-loop-source
status: active
domain: python
---

## Python 代码题

| 主题 | 题干 | 初始代码 | 测试代码 | 参考代码 | 能力ID | 来源笔记 | 状态记录 |
|---|---|---|---|---|---|---|---|
| 统计函数 | 实现 summarize_scores | def summarize_scores(scores):\\n    raise NotImplementedError | assert summarize_scores([2, 4])[\"mean\"] == 3 | def summarize_scores(scores):\\n    return {\"mean\": sum(scores) / len(scores)} | PYN-BAS-01 | [[02 项目与研究/项目/PY100/Day 001]] | [[02 项目与研究/项目/PY100/00 项目导航]] |
""")

        items = source_area.parse_source_area(self.root)

        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["kind"], "code")
        self.assertEqual(item["domain"], "python")
        self.assertEqual(item["pluginType"], "code")
        self.assertEqual(item["abilityId"], "PYN-BAS-01")
        self.assertEqual(item["initialCode"], "def summarize_scores(scores):\n    raise NotImplementedError")
        self.assertEqual(item["testCode"], 'assert summarize_scores([2, 4])["mean"] == 3')
        self.assertEqual(item["sourceNote"], "02 项目与研究/项目/PY100/Day 001.md")
        self.assertEqual(item["stateRef"], "02 项目与研究/项目/PY100/00 项目导航.md")

    def test_incomplete_code_row_does_not_fall_back_to_quiz(self) -> None:
        text = "---\ntype: study-loop-source\n---\n## Python 代码题\n| 主题 | 题干 | 初始代码 | 测试代码 | 能力ID | 来源笔记 | 状态记录 |\n|---|---|---|---|---|---|---|\n| missing | 实现函数 | pass | | PYN-BAS-01 | [[source]] | [[state]] |\n"
        self.assertEqual(source_area.parse_source_text(text, Path("code.md")), [])

    def test_two_code_questions_can_share_an_ability_without_sharing_item_id(self) -> None:
        text = "---\ntype: study-loop-source\n---\n## Python 代码题\n| 条目ID | 主题 | 题干 | 初始代码 | 测试代码 | 能力ID | 来源笔记 | 状态记录 |\n|---|---|---|---|---|---|---|---|\n| py:q1 | first | 实现 first | pass | assert True | PYN-BAS-01 | [[source]] | [[state]] |\n| py:q2 | second | 实现 second | pass | assert True | PYN-BAS-01 | [[source]] | [[state]] |\n"
        items = source_area.parse_source_text(text, Path("code.md"))
        self.assertEqual([item.get("itemId") for item in items], ["py:q1", "py:q2"])
        self.assertEqual([item["abilityId"] for item in items], ["PYN-BAS-01", "PYN-BAS-01"])

    def test_wikilink_resolution_handles_alias_and_md_suffix(self) -> None:
        self.assertEqual(source_area.resolve_wikilink("[[01 学习/词库|词库]]"), "01 学习/词库.md")
        self.assertEqual(source_area.resolve_wikilink("[[P2]]"), "P2.md")
        self.assertIsNone(source_area.resolve_wikilink("plain text"))
        self.assertIsNone(source_area.resolve_wikilink(""))

    def test_non_source_files_and_files_without_frontmatter_are_ignored(self) -> None:
        self.write_source("other.md", "# 普通笔记\n\n没有 frontmatter")
        (self.sources / "notes.txt").write_text("plain", encoding="utf-8")
        self.write_source("disabled.md", """---
type: study-loop-source
status: inactive
---

## 词汇

| 单词/词组 | 释义 | 原文语境 |
|---|---|---|
| skip | 跳过 | not active |
""")
        items = source_area.parse_source_area(self.root)
        self.assertEqual(items, [])

    def test_invalid_rows_are_skipped(self) -> None:
        self.write_source("知学资料.md", """---
type: study-loop-source
status: active
---

## 词汇

| 单词/词组 | 释义 | 原文语境 |
|---|---|---|
| valid | 有效 | context here |
|  | 缺单词 | 缺单词行应跳过 |
""")
        items = source_area.parse_source_area(self.root)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["word"], "valid")

    def test_dedupe_by_content_hash(self) -> None:
        content = """---
type: study-loop-source
status: active
---

## 词汇

| 单词/词组 | 释义 | 原文语境 | 来源笔记 |
|---|---|---|---|
| alpha | 阿尔法 | context alpha | [[P1]] |
| alpha | 阿尔法 | context alpha | [[P1]] |
"""
        self.write_source("知学资料.md", content)
        items = source_area.parse_source_area(self.root)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["contentHash"], source_area.content_hash(items[0]))
        self.assertEqual(len(source_area.content_hash(items[0])), 64)

    def test_ability_id_is_deterministic(self) -> None:
        self.write_source("知学资料.md", """---
type: study-loop-source
status: active
---

## 词汇

| 单词/词组 | 释义 | 原文语境 |
|---|---|---|
| pooling layer | 池化层 | context |
""")
        first = source_area.parse_source_area(self.root)
        second = source_area.parse_source_area(self.root)
        self.assertEqual(first[0]["abilityId"], second[0]["abilityId"])
        self.assertRegex(first[0]["abilityId"], r"^word:pooling")


if __name__ == "__main__":
    unittest.main()
