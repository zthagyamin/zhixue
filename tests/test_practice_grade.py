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

    def test_nonfinite_numeric_reference_cannot_produce_an_incorrect_grade(self):
        for reference in ("NaN", "Infinity", "1e999"):
            with self.subTest(reference=reference):
                result = practice_engine.grade_answer(
                    {"questionType": "calculation", "prompt": "计算 1 + 1。", "answer": reference},
                    "2", ai_available=False)
                self.assertIsNone(result["correct"])
                self.assertEqual(result["verdict"], "unknown")
                self.assertNotEqual(result.get("source"), "self-assess")

    def test_taskless_numeric_review_point_does_not_become_a_correct_answer(self):
        item = practice_engine.build_base_item({"itemId": "synthetic-numeric-note",
            "abilityId": "synthetic-ability", "domain": "mathematics", "reviewPoints": ["42"]}, {})
        result = practice_engine.grade_answer(item, "42", ai_available=False)
        self.assertIsNone(result["correct"])
        self.assertEqual(result["verdict"], "unknown")
        self.assertIn("问题", result["explanation"])

    def test_zero_reference_material_preserves_the_actual_question(self):
        item = practice_engine.build_base_item({"itemId": "synthetic-zero",
            "abilityId": "synthetic-ability", "domain": "mathematics", "reviewPoints": ["A review label"]},
            {"level": "C", "prompt": "计算 1 - 1。", "answer": 0})
        self.assertEqual(item["prompt"], "计算 1 - 1。")
        self.assertEqual(item["answer"], "0")
        self.assertTrue(practice_engine.grade_answer(item, "0", ai_available=False)["correct"])

    def test_nonfinite_input_is_pending_and_finite_wrong_answer_stays_wrong(self):
        item = {"questionType": "calculation", "prompt": "计算 1 + 1。", "answer": "2"}
        for answer in ("NaN", "Infinity", "1e999"):
            with self.subTest(answer=answer):
                result = practice_engine.grade_answer(item, answer, ai_available=False)
                self.assertIsNone(result["correct"])
                self.assertEqual(result["verdict"], "unknown")
        result = practice_engine.grade_answer(item, "3", ai_available=False)
        self.assertFalse(result["correct"])
        self.assertEqual(result["verdict"], "wrong")

    def test_calculation_with_text_reference_remains_undetermined(self) -> None:
        # Unsupported numeric reference cannot become a score or auto self-assessment.
        item = {
            "questionType": "calculation",
            "answer": "Kaiming 初始化方差 $2/D_{in}$；ReLU 杀一半信号",
            "explanation": "要点",
        }
        result = practice_engine.grade_answer(item, "任意", ai_available=False)
        self.assertIsNone(result["correct"])
        self.assertEqual(result["verdict"], "unknown")
        self.assertEqual(result["source"], "deterministic")
        self.assertNotIn("rating",result)
        self.assertIn("无法可靠核对",result["explanation"])

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
