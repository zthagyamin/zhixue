from __future__ import annotations

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import plan_area  # noqa: E402


def make_candidate(day: str = "2026-08-25", plan_hash: str = "h" * 64) -> dict:
    return {
        "day": day,
        "planHash": plan_hash,
        "items": [
            {"kind": "overdue", "itemKey": "w1", "domain": "ielts", "estimatedMinutes": 5, "reasons": ["已逾期 1 天"]},
            {"kind": "study", "itemKey": "p1", "domain": "ielts", "estimatedMinutes": 10, "reasons": ["当前学习主线"]},
        ],
        "totalMinutes": 15,
        "overloaded": False,
        "skipped": [],
    }


class PlanAreaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.area = plan_area.plan_area_root(self.vault)
        self.main_plan = self.vault / "01 学习/学习计划/00 学习计划总览.md"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_apply_plan_revision_writes_today_plan_and_revision_record(self) -> None:
        candidate = make_candidate()
        revision = plan_area.apply_plan_revision(self.area, candidate, operator="user-001", triggered_by="daily-candidate")

        self.assertEqual(revision["revision"], 1)
        self.assertEqual(revision["triggeredBy"], "daily-candidate")
        self.assertEqual(revision["operator"], "user-001")
        self.assertEqual(revision["inputHash"], "h" * 64)
        self.assertIsNone(revision["before"])
        self.assertEqual(revision["after"]["planHash"], "h" * 64)

        self.assertTrue(self.main_plan.exists())
        content = self.main_plan.read_text(encoding="utf-8")
        self.assertIn("ZHIXUE:CURRENT-PLAN", content)
        self.assertIn("w1", content)
        self.assertIn("p1", content)

        revisions = plan_area.read_revisions(self.area)
        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["revision"], 1)

    def test_revision_numbers_are_append_only_and_incremental(self) -> None:
        first = plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="a" * 64), operator="user-001", triggered_by="daily-candidate")
        second = plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="b" * 64), operator="user-001", triggered_by="daily-candidate")
        self.assertEqual(first["revision"], 1)
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["before"]["planHash"], "a" * 64)
        self.assertEqual(second["after"]["planHash"], "b" * 64)
        self.assertEqual(len(plan_area.read_revisions(self.area)), 2)

    def test_input_provenance_and_frozen_practice_survive_apply_and_restore(self) -> None:
        candidate = make_candidate()
        candidate["inputHash"] = "source-input"
        candidate["items"][0]["practice"] = {
            "kind": "vocab-group", "subjectId": "ielts-vocabulary",
            "groupIndex": 1, "groupQuota": 20, "count": 2,
            "itemKeys": ["word:a", "word:b"],
        }
        applied = plan_area.apply_plan_revision(self.area, candidate, "test", "daily-candidate")
        self.assertEqual(applied["inputHash"], "source-input")
        self.assertEqual(plan_area.current_plan(self.area), candidate)
        restored = plan_area.restore_revision(self.area, 1, "test")
        self.assertEqual(restored["inputHash"], "source-input")
        self.assertEqual(plan_area.current_plan(self.area), candidate)

    def test_failed_revision_append_restores_the_previous_daily_plan(self) -> None:
        plan_area.apply_plan_revision(
            self.area,
            make_candidate(plan_hash="a" * 64),
            operator="user-001",
            triggered_by="daily-candidate",
        )
        previous = self.main_plan.read_bytes()

        with mock.patch.object(plan_area, "_append_revision", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                plan_area.apply_plan_revision(
                    self.area,
                    make_candidate(plan_hash="b" * 64),
                    operator="user-001",
                    triggered_by="daily-candidate",
                )

        self.assertEqual(self.main_plan.read_bytes(), previous)
        self.assertEqual(len(plan_area.read_revisions(self.area)), 1)

    def test_revision_records_before_and_after(self) -> None:
        first = plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="a" * 64), operator="user-001", triggered_by="daily-candidate")
        second = plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="b" * 64), operator="user-001", triggered_by="daily-candidate")
        self.assertEqual(second["before"]["planHash"], first["after"]["planHash"])

    def test_restore_rolls_back_to_a_previous_revision(self) -> None:
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="a" * 64), operator="user-001", triggered_by="daily-candidate")
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="b" * 64), operator="user-001", triggered_by="daily-candidate")
        restored = plan_area.restore_revision(self.area, target=1, operator="user-001")
        self.assertEqual(restored["after"]["planHash"], "a" * 64)
        self.assertEqual(restored["undoTarget"], 1)
        self.assertEqual(restored["revision"], 3)
        revisions = plan_area.read_revisions(self.area)
        self.assertEqual(len(revisions), 3)
        self.assertIn("a" * 64, self.main_plan.read_text(encoding="utf-8"))

    def test_apply_only_touches_main_plan_and_integration_area(self) -> None:
        candidate = make_candidate()
        plan_area.apply_plan_revision(self.area, candidate, operator="user-001", triggered_by="daily-candidate")
        written = [path.relative_to(self.vault).as_posix() for path in self.vault.rglob("*") if path.is_file()]
        for path in written:
            self.assertTrue(path.startswith("_System") or path.startswith("01 学习/学习计划/"), path)

    def test_current_plan_returns_latest_approved_candidate(self) -> None:
        self.assertIsNone(plan_area.current_plan(self.area))
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="a" * 64), operator="user-001", triggered_by="daily-candidate")
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="b" * 64), operator="user-001", triggered_by="daily-candidate")
        current = plan_area.current_plan(self.area)
        self.assertEqual(current["planHash"], "b" * 64)
        self.assertEqual(current["day"], "2026-08-25")

    def test_stale_apply_leaves_plan_and_revision_log_unchanged(self) -> None:
        plan_area.apply_plan_revision(
            self.area,
            make_candidate(plan_hash="a" * 64),
            operator="user-001",
            triggered_by="approval",
            expected_revision=0,
        )
        before_plan = self.main_plan.read_bytes()
        before_log = (self.area / plan_area.REVISIONS_FILE).read_bytes()
        with self.assertRaisesRegex(ValueError, "stale-plan-revision"):
            plan_area.apply_plan_revision(
                self.area,
                make_candidate(plan_hash="b" * 64),
                operator="user-001",
                triggered_by="approval",
                expected_revision=0,
            )
        self.assertEqual(self.main_plan.read_bytes(), before_plan)
        self.assertEqual((self.area / plan_area.REVISIONS_FILE).read_bytes(), before_log)

    def test_stale_apply_does_not_implicitly_migrate_legacy_plan(self) -> None:
        legacy = self.vault / "_System/Integrations/Study Loop/plan"
        legacy.mkdir(parents=True)
        (legacy / "revisions.jsonl").write_text(
            '{"revision":2,"after":' + __import__("json").dumps(make_candidate(plan_hash="a" * 64)) + '}\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "stale-plan-revision"):
            plan_area.apply_plan_revision(
                self.area,
                make_candidate(plan_hash="b" * 64),
                "user-001",
                "approval",
                expected_revision=2,
            )
        self.assertFalse(self.main_plan.exists())

    def test_reject_is_audited_without_changing_main_plan_or_revision(self) -> None:
        plan_area.apply_plan_revision(self.area, make_candidate(), "user-001", "approval", expected_revision=0)
        before = self.main_plan.read_bytes()
        rejection = plan_area.reject_candidate(self.area, "z" * 64, "user-001", "今天时间不足")
        self.assertEqual(rejection["decision"], "rejected")
        self.assertEqual(plan_area.current_revision(self.area), 1)
        self.assertEqual(self.main_plan.read_bytes(), before)
        self.assertEqual(len(plan_area.read_revisions(self.area)), 2)

    def test_restore_requires_expected_revision(self) -> None:
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="a" * 64), "user-001", "approval", expected_revision=0)
        plan_area.apply_plan_revision(self.area, make_candidate(plan_hash="b" * 64), "user-001", "approval", expected_revision=1)
        with self.assertRaisesRegex(ValueError, "stale-plan-revision"):
            plan_area.restore_revision(self.area, target=1, operator="user-001", expected_revision=1)
        restored = plan_area.restore_revision(self.area, target=1, operator="user-001", expected_revision=2)
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(plan_area.current_plan(self.area)["planHash"], "a" * 64)

    def test_concurrent_same_revision_allows_exactly_one_apply(self) -> None:
        barrier = threading.Barrier(2)

        def apply(plan_hash: str) -> str:
            barrier.wait()
            try:
                plan_area.apply_plan_revision(
                    self.area,
                    make_candidate(plan_hash=plan_hash),
                    "user-001",
                    "approval",
                    expected_revision=0,
                )
                return "applied"
            except ValueError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(apply, ["a" * 64, "b" * 64]))
        self.assertEqual(sorted(results), ["applied", "stale-plan-revision"])
        self.assertEqual(len(plan_area.read_revisions(self.area)), 1)


if __name__ == "__main__":
    unittest.main()
