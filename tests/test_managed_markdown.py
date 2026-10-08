from __future__ import annotations

import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import managed_markdown  # noqa: E402


BEGIN = "%% ZHIXUE:TEST:BEGIN %%"
END = "%% ZHIXUE:TEST:END %%"


class ManagedMarkdownTests(unittest.TestCase):
    def test_inserts_after_first_h1_and_preserves_user_text(self) -> None:
        source = "---\ntitle: 计划\n---\n\n# 学习计划\n\n用户前言\n"
        result = managed_markdown.replace_managed_block(source, BEGIN, END, "系统内容")

        self.assertEqual(
            result,
            "---\ntitle: 计划\n---\n\n# 学习计划\n"
            f"\n{BEGIN}\n系统内容\n{END}\n\n用户前言\n",
        )

    def test_replaces_only_managed_block_bytes(self) -> None:
        source = f"# 标题\r\n\r\n前文\r\n{BEGIN}\r\n旧内容\r\n{END}\r\n尾注\r\n"
        result = managed_markdown.replace_managed_block(source, BEGIN, END, "新内容")
        self.assertEqual(result, f"# 标题\r\n\r\n前文\r\n{BEGIN}\r\n新内容\r\n{END}\r\n尾注\r\n")

    def test_rejects_duplicate_or_unbalanced_markers(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate-managed-block"):
            managed_markdown.replace_managed_block(f"{BEGIN}\n{END}\n{BEGIN}\n{END}", BEGIN, END, "x")
        with self.assertRaisesRegex(ValueError, "unbalanced-managed-block"):
            managed_markdown.replace_managed_block(f"# 标题\n{BEGIN}\n", BEGIN, END, "x")


if __name__ == "__main__":
    unittest.main()
