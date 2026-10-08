# tests/test_practice_grade.py
import sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import practice_engine  # noqa: E402


class PracticeGradeTests(unittest.TestCase):
    def test_quiz_grade_compares_option_index(self) -> None:
        item = {"questionType": "quiz", "answer": 1}
        self.assertTrue(practice_engine.grade_answer(item, 1)["correct"])
        self.assertFalse(practice_engine.grade_answer(item, 0)["correct"])

    def test_calculation_grade_uses_tolerance(self) -> None:
        item = {"questionType": "calculation", "answer": 2.0}
        self.assertTrue(practice_engine.grade_answer(item, 2.000001, ai_available=False)["correct"])
        self.assertFalse(practice_engine.grade_answer(item, 3.0, ai_available=False)["correct"])

    def test_calculation_with_text_answer_degrades_to_self_assess(self) -> None:
        # P2：I1 之后，无素材的公式/要点点会产出 answer 为复习要点文本的
        # calculation 条目——文本答案没有客观数值，判定必须降级自评
        # （spec §8：表达式不匹配 → 自评），否则用户永远答不对、队列永远
        # again。数值型答案仍走严格容差判定（见 test_calculation_grade_uses_tolerance）。
        item = {
            "questionType": "calculation",
            "answer": "Kaiming 初始化方差 $2/D_{in}$；ReLU 杀一半信号",
            "explanation": "要点",
        }
        result = practice_engine.grade_answer(item, "任意", ai_available=False)
        self.assertIsNone(result["correct"])
        self.assertEqual(result["verdict"], "self-assess")
        self.assertEqual(result["explanation"], "要点")

    def test_recall_offline_returns_self_assess(self) -> None:
        item = {"questionType": "recall", "explanation": "要点", "answer": "要点"}
        result = practice_engine.grade_answer(item, "任意回答", ai_available=False)
        self.assertIsNone(result["correct"])
        self.assertEqual(result["verdict"], "self-assess")

    def test_recall_ai_grader_returns_structured_partial_feedback(self) -> None:
        item = {
            "questionType": "recall",
            "prompt": "解释归一化的作用",
            "reviewPoint": "归一化解决信号失控；γ 缩放 β 平移",
            "answer": "归一化让信号更稳定",
            "explanation": "归一化解决信号失控；γ 缩放 β 平移",
        }
        calls = []

        def grader(received_item, received_answer):
            calls.append((received_item, received_answer))
            return {
                "verdict": "partial",
                "confidence": 0.78,
                "feedback": "方向正确，但遗漏了可学习缩放和平移参数。",
                "matched_points": ["让信号更稳定"],
                "missed_points": ["γ 缩放", "β 平移"],
            }

        result = practice_engine.grade_answer(item, "让信号更稳定", recall_grader=grader)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "让信号更稳定")
        self.assertFalse(result["correct"])
        self.assertEqual(result["verdict"], "partial")
        self.assertEqual(result["rating"], "hard")
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["confidence"], 0.78)
        self.assertEqual(result["matchedPoints"], ["让信号更稳定"])
        self.assertEqual(result["missedPoints"], ["γ 缩放", "β 平移"])
        self.assertIn("遗漏", result["explanation"])

    def test_recall_ai_grader_failure_falls_back_to_self_assess(self) -> None:
        item = {"questionType": "recall", "explanation": "要点"}

        def grader(_item, _answer):
            raise RuntimeError("provider unavailable")

        result = practice_engine.grade_answer(item, "任意回答", recall_grader=grader)
        self.assertIsNone(result["correct"])
        self.assertEqual(result["verdict"], "self-assess")
        self.assertEqual(result["source"], "self-assess")
        self.assertTrue(result["aiFallback"])

    def test_variant_rotates_quiz_options_deterministically(self) -> None:
        item = {"questionType": "quiz", "options": ["A", "B", "C"], "answer": 0}
        v1 = practice_engine.variant_for(item, 1)
        v2 = practice_engine.variant_for(item, 1)
        self.assertEqual(v1["options"], v2["options"])
        self.assertNotEqual(v1["options"], item["options"])
        self.assertEqual(v1["answer"], v1["options"].index(item["options"][item["answer"]]))

    def test_unstructured_calculation_retry_preserves_the_actual_problem(self) -> None:
        item = {"questionType": "calculation", "prompt": "x", "answer": "2.0"}
        v = practice_engine.variant_for(item, 2)
        self.assertEqual(v["answer"], item["answer"])
        self.assertEqual(v["prompt"], item["prompt"])
        self.assertEqual(v, item)
        self.assertIsNot(v, item)
