"""Shared reference-formatting regressions; no real materials or AI calls."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))
from recall_quality import is_recall_echo, recall_reference  # noqa: E402
from practice_engine import grade_answer  # noqa: E402


class ReferenceEchoFormattingTests(unittest.TestCase):
    def test_shared_formatting_contract(self):
        fixture = json.loads((ROOT / "tests/fixtures/reference-echo-v1.json").read_text(encoding="utf-8"))
        self.assertEqual(fixture["version"], "reference-echo-v1")
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(is_recall_echo(case["reference"], case["prompt"]), case["echo"])

    def test_formatted_echo_does_not_reach_grader_or_replace_actual_reference(self):
        item = {"questionType": "recall", "prompt": "BN vs LN？", "answer": "**BN vs LN**"}
        before = dict(item)
        calls = []
        result = grade_answer(item, "attempt", ai_available=True, recall_grader=lambda *args: calls.append(args))
        self.assertEqual(calls, [])
        self.assertIsNone(result["correct"])
        self.assertIn("缺少可核对", result["explanation"])
        self.assertIsNone(recall_reference(item))
        self.assertEqual(recall_reference({**item, "explanation": "归一化的维度不同。"}), "归一化的维度不同。")
        self.assertEqual(item, before)


if __name__ == "__main__":
    unittest.main()
