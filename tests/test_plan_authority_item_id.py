from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import plan_authority  # noqa: E402


def candidate(plan_hash: str = "a" * 64) -> dict:
    return {
        "day": "2026-08-25",
        "planHash": plan_hash,
        "items": [{"kind": "review", "itemKey": "word-1", "domain": "ielts", "estimatedMinutes": 8}],
        "totalMinutes": 8,
        "overloaded": False,
        "skipped": [],
    }


class PlanAuthorityItemIdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.plan_path = self.vault / "01 学习/学习计划/00 学习计划总览.md"
        self.plan_path.parent.mkdir(parents=True)
        self.plan_path.write_text("# 学习计划总览\n\n用户说明。\n", encoding="utf-8")
        plan_authority.apply_current_plan(self.vault, candidate(), revision=1)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_parse_review_items_includes_stable_item_id(self) -> None:
        plan_authority.add_review_item(self.vault, {
            "itemId": "zhx-word-pooling", "domain": "ielts", "sourceNote": "P2.md",
            "stateRef": "L16.md", "abilityId": "pooling-layer", "due": "2026-08-26",
            "reason": "显式捕获", "pluginType": "three-stage",
        })
        items = plan_authority.parse_review_items(self.vault)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["itemId"], "zhx-word-pooling")
        self.assertEqual(item["abilityId"], "pooling-layer")
        self.assertEqual(item["due"], "2026-08-26")
        self.assertEqual(item["reason"], "显式捕获")

    def test_parse_review_items_empty_without_managed_plan(self) -> None:
        self.plan_path.write_text("# 学习计划总览\n\n无托管块。\n", encoding="utf-8")
        self.assertEqual(plan_authority.parse_review_items(self.vault), [])

    def test_parse_review_items_roundtrips_after_strengthen(self) -> None:
        plan_authority.add_review_item(self.vault, {
            "itemId": "zhx-word-pooling", "abilityId": "pooling-layer",
            "stateRef": "L16.md", "due": "2026-08-26", "reason": "显式捕获",
        })
        plan_authority.add_review_item(self.vault, {
            "itemId": "zhx-word-pooling", "abilityId": "pooling-layer",
            "stateRef": "L16.md", "due": "2026-08-27", "reason": "重复负向证据",
        })
        items = plan_authority.parse_review_items(self.vault)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["due"], "2026-08-27")
        self.assertEqual(items[0]["reason"], "重复负向证据")


if __name__ == "__main__":
    unittest.main()
