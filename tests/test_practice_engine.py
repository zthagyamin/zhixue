# tests/test_practice_engine.py
import sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import practice_engine  # noqa: E402
import assessment_material  # noqa: E402


class PracticeEngineTests(unittest.TestCase):
    def test_assessment_matching_prefers_shared_terms_over_list_position(self) -> None:
        parsed = {
            "questions": {
                2: {"level": "A", "prompt": "BN 和 LN 的统计轴分别是什么？", "answer": "BN 跨 batch；LN 不依赖 batch。"},
                6: {"level": "C", "prompt": "sanity check 和学习率怎么判断？", "answer": "先查初始 loss，再调学习率。"},
            },
            "weakNumbers": [2, 6],
            "reviewRecords": [
                {"reviewPoint": "BN 依赖 batch 统计", "questionNo": 2, "detail": "BN 怕小 batch；LN 不依赖 batch"},
                {"reviewPoint": "sanity check ≈ lnK", "questionNo": 6, "detail": "CIFAR-10 初始 loss"},
            ],
        }
        material = assessment_material.material_for_review_point(parsed, "BN vs LN", 1)
        self.assertEqual(material["prompt"], "BN 和 LN 的统计轴分别是什么？")

    def test_assessment_matching_overrides_a_stale_question_reference(self) -> None:
        parsed = {
            "questions": {
                3: {"level": "B", "prompt": "卷积层有哪些参数？", "answer": "核与 bias。"},
                5: {"level": "C", "prompt": "计算卷积输出与 MACs。", "answer": "MACs = 输出位置数 × 每位置乘加数。"},
            },
            "weakNumbers": [3, 5],
            "remarks": {3: "参数量遗漏输入通道", 5: "MACs 计算不稳"},
            "reviewRecords": [
                {"reviewPoint": "MACs 定义与计算", "questionNo": 3, "detail": "输出位置数 × 每位置乘加数"},
            ],
        }
        material = assessment_material.material_for_review_point(parsed, "MACs", 0)
        self.assertEqual(material["prompt"], "计算卷积输出与 MACs。")

    def test_unmatched_point_uses_detection_remark_instead_of_unrelated_question(self) -> None:
        parsed = {
            "questions": {
                5: {"level": "C", "prompt": "I3D 为什么除以 Kt？", "answer": "保持静态响应。"},
            },
            "weakNumbers": [5],
            "remarks": {5: "j_l 是累计 stride，r_l 是感受野；stride 2 表示跨 2 帧。"},
            "reviewRecords": [],
        }
        material = assessment_material.material_for_review_point(parsed, "j_l vs r_l", 0)
        self.assertIn("j_l vs r_l", material["prompt"])
        self.assertIn("累计 stride", material["answer"])

    def test_select_question_type_rules(self) -> None:
        # 有原题 A/B 层 → quiz
        self.assertEqual(practice_engine.select_question_type("归一化作用", {"level": "A"}), "quiz")
        # C 应用 → calculation
        self.assertEqual(practice_engine.select_question_type("Kaiming 初始化", {"level": "C"}), "calculation")
        # 无原题但含公式符号 → calculation
        self.assertEqual(practice_engine.select_question_type("softmax 梯度 ∂L/∂z", {}), "calculation")
        # 含代码关键词 → code
        self.assertEqual(practice_engine.select_question_type("ResNet 残差实现", {}), "code")
        # plugin_hint 采纳
        self.assertEqual(practice_engine.select_question_type("概念点", {}, "recall"), "recall")
        # 兜底 recall
        self.assertEqual(practice_engine.select_question_type("普通概念", {}), "quiz")

    def test_build_base_item_uses_knowledge_materials(self) -> None:
        card = {
            "itemId": "cs231n-l6-norm", "domain": "course", "abilityId": "norm-purpose",
            "sourceNote": "n.md", "stateRef": "s.md", "reviewPoints": ["归一化作用"],
        }
        materials = {
            "prompt": "归一化是做什么的？",
            "answer": "标准化激活，γ 缩放 β 平移",
            "wrong": ["治过拟合"],  # 检测错因当干扰项
            "level": "A",
        }
        item = practice_engine.build_base_item(card, materials)
        self.assertEqual(item["questionType"], "quiz")
        self.assertEqual(item["prompt"], "归一化是做什么的？")
        self.assertEqual(item["options"][0], "标准化激活，γ 缩放 β 平移")
        self.assertIn("治过拟合", item["options"])
        self.assertEqual(item["answer"], 0)
        self.assertEqual(item["sourceLabel"], "cs231n-l6-norm")

    def test_fingerprint_is_stable(self) -> None:
        first = practice_engine.fingerprint_for("归一化作用", "n.md")
        second = practice_engine.fingerprint_for("归一化作用", "n.md")
        self.assertEqual(first, second)
        self.assertEqual(len(first), 16)

    def test_quiz_fallback_to_recall_when_no_materials(self) -> None:
        card = {"itemId": "i", "domain": "x", "abilityId": "a", "sourceNote": "n", "stateRef": "s",
                "reviewPoints": ["某概念"]}
        item = practice_engine.build_base_item(card, {})
        self.assertEqual(item["questionType"], "recall")
        self.assertEqual(item["reviewPoint"], "某概念")

    def test_formula_review_point_without_materials_yields_calculation(self) -> None:
        # spec §7: 无原题但含公式/数值符号 → calculation；复习要点即答案内容
        card = {"itemId": "i", "domain": "x", "abilityId": "a", "sourceNote": "n", "stateRef": "s",
                "reviewPoints": ["softmax 梯度 ∂L/∂z"]}
        item = practice_engine.build_base_item(card, {})
        self.assertEqual(item["questionType"], "calculation")
        self.assertEqual(item["prompt"], "softmax 梯度 ∂L/∂z")
        self.assertIn("softmax 梯度 ∂L/∂z", item["answer"])
        self.assertEqual(item["explanation"], item["answer"])

    def test_code_keyword_review_point_without_materials_yields_code(self) -> None:
        # spec §7: 含代码关键词 → code；无素材时以复习要点为答案内容
        card = {"itemId": "i", "domain": "x", "abilityId": "a", "sourceNote": "n", "stateRef": "s",
                "reviewPoints": ["ResNet 残差实现"]}
        item = practice_engine.build_base_item(card, {})
        self.assertEqual(item["questionType"], "code")
        self.assertEqual(item["prompt"], "ResNet 残差实现")
        self.assertIn("ResNet 残差实现", item["answer"])

    def test_plugin_hint_recall_honored_in_fallback(self) -> None:
        # spec §7 规则 4：学习结果卡 plugin_hint 指定后采纳
        card = {"itemId": "i", "domain": "x", "abilityId": "a", "sourceNote": "n", "stateRef": "s",
                "reviewPoints": ["某个概念点"], "pluginHint": "recall"}
        item = practice_engine.build_base_item(card, {})
        self.assertEqual(item["questionType"], "recall")

    def test_practice_items_emit_typed_items_for_card_review_points(self) -> None:
        # practice_items 必须产出按复习点内容选型的条目（spec §7），
        # 而不是全部退化为 recall。
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            root = vault / "01 学习/学习结果"
            root.mkdir(parents=True)
            (root / "formula.md").write_text("""---
type: learning-result
domain: course
item_id: l6-softmax
ability_id: softmax-grad
review_date: 2000-01-01
---
# L6
复习要点：
- softmax 梯度 ∂L/∂z
""", encoding="utf-8")
            (root / "code.md").write_text("""---
type: learning-result
domain: course
item_id: l6-resnet
ability_id: resnet-impl
review_date: 2000-01-01
---
# L6
复习要点：
- ResNet 残差实现
""", encoding="utf-8")
            items = practice_engine.practice_items(vault)
            types = sorted(item["questionType"] for item in items)
            self.assertIn("calculation", types)
            self.assertIn("code", types)

    def test_legacy_due_review_without_assessment_becomes_recall(self) -> None:
        legacy = [{"itemId": "due:CS231N:6:1", "questionType": "flashcard", "front": "归一化作用",
                   "back": "先回忆再核对", "sourceNote": "s.md", "stateRef": "t.md", "pluginType": "flashcard"}]
        items = practice_engine.practice_items(Path("C:/nonexistent-vault"), legacy_items=legacy)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["questionType"], "recall")
        # Since the anti-answer-echo baseline, unverified topic text stays on the reference side.
        self.assertNotIn("归一化作用", items[0]["prompt"])
        self.assertEqual(items[0]["prompt"], "阅读材料：复习记录（待补具体问题）")
        for field in ("answer", "explanation", "reviewPoint"):
            self.assertEqual(items[0][field], "归一化作用")
        self.assertEqual(items[0]["itemId"], legacy[0]["itemId"])
        self.assertEqual(items[0]["sourceNote"], "s.md")
        self.assertEqual(items[0]["stateRef"], "t.md")
        self.assertEqual(items[0]["fingerprint"], practice_engine.fingerprint_for("归一化作用", "s.md"))

    def test_legacy_entry_uses_mastery_assessment_question_and_answer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            assessment = vault / "01 学习/专项课程/Stanford CS231n/检测与错题/第06讲 掌握检测.md"
            assessment.parent.mkdir(parents=True)
            assessment.write_text("""---
type: assessment
source_note: "[[01 学习/专项课程/Stanford CS231n/课程笔记/第06讲 CNN架构与训练]]"
---
# 第06讲｜掌握检测
## A. 理解
1. 归一化是做什么的？gamma 和 beta 分别有什么作用？
## B. 辨析
2. ResNet 退化是过拟合吗？为什么？
> [!success]- 参考要点
> 1：标准化激活；gamma 缩放，beta 平移。
> 2：不是过拟合，而是优化退化；残差连接让恒等映射更容易。
## 检测结果
| 题号 | 层级 | 结果 | 备注 |
|---|---|---|---|
| 1 | A 理解 | 薄弱 | 误答为只用于正则化 |
| 2 | B 辨析 | 薄弱 | 混淆训练误差与验证误差 |
## 复习队列
| 薄弱点 | 来源 | 复习要点 |
|---|---|---|
| 归一化作用 | 题 1 | 每层信号回到稳定尺度 |
| ResNet 退化与残差 | 题 2 | 优化退化不是过拟合 |
""", encoding="utf-8")
            state_ref = "01 学习/专项课程/Stanford CS231n/学习记录/第06讲 学习状态.md"
            legacy = [{
                "courseId": "CS231N", "lectureNo": 6, "topic": "归一化",
                "reviewDate": "2026-08-26", "timing": "today", "itemCount": 2,
                "nextAction": "", "path": state_ref,
                "studyItems": [
                    {"id": "due:CS231N:6:1", "itemId": "due:CS231N:6:1", "pluginType": "flashcard",
                     "front": "归一化作用", "back": "先回忆再核对", "sourceNote": "s.md",
                     "stateRef": state_ref, "abilityId": "review-6-1", "sourceLabel": "Obsidian 到期复习 · 归一化"},
                    {"id": "due:CS231N:6:2", "itemId": "due:CS231N:6:2", "pluginType": "flashcard",
                     "front": "ResNet 退化与残差", "back": "先回忆再核对", "sourceNote": "s.md",
                     "stateRef": state_ref, "abilityId": "review-6-2", "sourceLabel": "Obsidian 到期复习 · 归一化"},
                ],
            }]
            items = practice_engine.practice_items(vault, legacy_items=legacy)
            self.assertEqual(len(items), 2)
            self.assertTrue(all(item["questionType"] != "flashcard" for item in items))
            self.assertEqual(items[0]["prompt"], "归一化是做什么的？gamma 和 beta 分别有什么作用？")
            self.assertIn("标准化激活", items[0]["explanation"])
            self.assertEqual(items[0]["itemId"], "due:CS231N:6:1")
            self.assertEqual(items[0]["abilityId"], "review-6-1")
            self.assertEqual(items[0]["domain"], "course")

    def test_result_card_uses_linked_mastery_assessment_material(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            assessment = vault / "01 学习/专项课程/Stanford CS231n/检测与错题/第11讲 掌握检测.md"
            assessment.parent.mkdir(parents=True)
            assessment.write_text("""---
type: assessment
source_note: "[[01 学习/专项课程/Stanford CS231n/课程笔记/第11讲 大规模分布式训练]]"
---
# 第11讲｜掌握检测
## A. 理解
1. 数据并行和 FSDP 的本质区别？
> [!success]- 参考要点
> 1：FSDP 分片参数、梯度与优化器状态，前向按层临时 all-gather。
## 检测结果
| 题号 | 层级 | 结果 | 备注 |
|---|---|---|---|
| 1 | A 理解 | 薄弱 | 未说明训练状态全分片 |
## 复习队列
| 薄弱点 | 来源 | 复习要点 |
|---|---|---|
| FSDP 状态分片与时间线 | 题 1 | 前向临时 all-gather，反向 reduce-scatter |
""", encoding="utf-8")
            result_root = vault / "01 学习/学习结果"
            result_root.mkdir(parents=True)
            (result_root / "l11-fsdp.md").write_text("""---
type: learning-result
domain: course
item_id: due:CS231N:11:1
ability_id: review-11-1
review_date: 2000-01-01
source_note: "[[01 学习/专项课程/Stanford CS231n/课程笔记/第11讲 大规模分布式训练]]"
state_ref: "[[01 学习/专项课程/Stanford CS231n/学习记录/第11讲 学习状态]]"
---
# L11 · FSDP
复习要点：
- FSDP 状态分片与时间线
""", encoding="utf-8")

            items = practice_engine.practice_items(vault)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["questionType"], "quiz")
            self.assertEqual(items[0]["prompt"], "数据并行和 FSDP 的本质区别？")
            self.assertIn("all-gather", items[0]["explanation"])

    def _write_card(self, vault: Path, name: str, item_id: str, review_date: str, point: str) -> None:
        root = vault / "01 学习/学习结果"
        root.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(f"""---
type: learning-result
domain: course
item_id: {item_id}
ability_id: {item_id}-ability
review_date: {review_date}
---
# {item_id}
复习要点：
- {point}
""", encoding="utf-8")

    def test_non_due_card_suppresses_only_matching_legacy_item(self) -> None:
        # 渐进迁移：未到期结果卡只覆盖同一 itemId，其他旧复习项继续出题。
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            self._write_card(vault, "future.md", "due:CS231N:6:1", "2999-01-01", "归一化作用")
            legacy = [
                {"itemId": "due:CS231N:6:1", "front": "归一化作用", "back": "旧内容", "sourceNote": "s.md", "stateRef": "t.md"},
                {"itemId": "due:CS231N:6:2", "front": "BN vs LN", "back": "旧内容", "sourceNote": "s.md", "stateRef": "t.md"},
            ]
            items = practice_engine.practice_items(vault, legacy_items=legacy)
            self.assertEqual([item["itemId"] for item in items], ["due:CS231N:6:2"])
            self.assertEqual(items[0]["questionType"], "recall")

    def test_legacy_entry_matching_card_item_id_is_not_requestioned(self) -> None:
        # 同一能力已迁移到学习结果卡（itemId 相同）→ 以卡为准，旧条目不再出题。
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            self._write_card(vault, "norm.md", "cs231n-l6-norm", "2000-01-01", "归一化作用")
            legacy = [{"itemId": "cs231n-l6-norm", "questionType": "flashcard", "front": "旧版闪卡",
                       "back": "旧内容", "sourceNote": "s.md", "stateRef": "t.md"}]
            items = practice_engine.practice_items(vault, legacy_items=legacy)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["itemId"], "cs231n-l6-norm")
            # 条目来自结果卡（非 flashcard 旧结构）
            self.assertNotEqual(items[0]["questionType"], "flashcard")
