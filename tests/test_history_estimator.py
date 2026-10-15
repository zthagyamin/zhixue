from __future__ import annotations

import unittest
from unittest import mock
from datetime import date
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

from history_estimator import _event_day, estimate_schedule  # noqa: E402


def events_for_minutes(minutes: list[int]) -> list[dict]:
    return [
        {
            "eventId": f"event-{index}",
            "occurredAt": f"2026-08-{20 + index:02d}T10:00:00Z",
            "durationMin": value,
            "item": {"key": f"item-{index}"},
        }
        for index, value in enumerate(minutes)
    ]


class HistoryEstimatorTests(unittest.TestCase):
    def test_event_day_uses_shanghai_calendar_boundary(self) -> None:
        self.assertEqual(_event_day({"occurredAt": "2026-08-24T16:30:00Z"}), date(2026, 8, 25))

    def test_fewer_than_three_active_days_uses_documented_fallback(self) -> None:
        estimate = estimate_schedule(events_for_minutes([45, 70]), [], [], date(2026, 8, 25))
        self.assertEqual((estimate.minimum_minutes, estimate.maximum_minutes), (30, 60))
        self.assertIn("证据不足", estimate.explanation)

    def test_median_baseline_and_high_skip_rate_reduce_capacity(self) -> None:
        events = events_for_minutes([40, 60, 80])
        plans = [
            {"day": "2026-08-20", "items": [{"itemKey": "item-0"}, {"itemKey": "miss-0"}]},
            {"day": "2026-08-21", "items": [{"itemKey": "item-1"}, {"itemKey": "miss-1"}]},
            {"day": "2026-08-22", "items": [{"itemKey": "item-2"}, {"itemKey": "miss-2"}]},
        ]
        estimate = estimate_schedule(events, plans, [], date(2026, 8, 25))
        self.assertLess(estimate.maximum_minutes, 60)
        self.assertEqual(estimate.evidence_days, 3)
        self.assertIn("跳过率", estimate.explanation)

    def test_sustained_high_completion_increases_modestly_and_is_bounded(self) -> None:
        events = [
            {
                "eventId": f"e-{index}",
                "occurredAt": f"2026-08-{index + 1:02d}T10:00:00Z",
                "durationMin": 175,
                "item": {"key": f"i-{index}"},
            }
            for index in range(14)
        ]
        plans = [{"day": f"2026-08-{index + 1:02d}", "items": [{"itemKey": f"i-{index}"}]} for index in range(14)]
        estimate = estimate_schedule(events, plans, [], date(2026, 8, 25))
        self.assertEqual(estimate.maximum_minutes, 180)
        self.assertIn("完成率", estimate.explanation)

    def test_out_of_window_events_do_not_change_estimate(self) -> None:
        recent = events_for_minutes([30, 40, 50])
        old = {"eventId": "old", "occurredAt": "2026-01-01T10:00:00Z", "durationMin": 180}
        self.assertEqual(
            estimate_schedule(recent, [], [], date(2026, 8, 25)),
            estimate_schedule([old, *recent], [], [], date(2026, 8, 25)),
        )

    def test_fourteen_revisions_on_one_day_are_not_fourteen_plan_days(self):
        events = events_for_minutes([60, 60, 60])
        plan = {"day": "2026-08-20", "items": [{"itemKey": "item-0"}]}
        estimate = estimate_schedule(events, [plan] * 14, [], date(2026, 8, 25))
        self.assertEqual(estimate.maximum_minutes, 60)
        self.assertEqual(estimate.completion_ratio, 1)
        self.assertNotIn("上调", estimate.explanation)

    def test_latest_plan_for_a_day_replaces_earlier_unfinished_items(self):
        events = events_for_minutes([60, 60, 60])
        plans = [{"day": "2026-08-20", "items": [{"itemKey": "replaced-item"}]},
                 {"day": "2026-08-20", "items": [{"itemKey": "item-0"}]}]
        estimate = estimate_schedule(events, plans, [], date(2026, 8, 25))
        self.assertEqual(estimate.completion_ratio, 1)
        self.assertEqual(estimate.maximum_minutes, 60)

    def test_latest_empty_plan_removes_earlier_completion_denominator(self):
        events = events_for_minutes([60, 60, 60])
        plans = [{"day": "2026-08-20", "items": [{"itemKey": "replaced-item"}]},
                 {"day": "2026-08-20", "items": []}]
        estimate = estimate_schedule(events, plans, [], date(2026, 8, 25))
        self.assertIsNone(estimate.completion_ratio)
        self.assertEqual(estimate.maximum_minutes, 60)

    def test_actual_revision_history_does_not_raise_capacity_for_one_plan_day(self):
        import test_companion as companion_fixture
        import plan_area
        from datetime import datetime, timezone
        server = companion_fixture.server
        harness = companion_fixture.CompanionSyncTests(
            "test_state_projection_failure_rolls_back_event_and_vault_log")
        harness.setUp()
        self.addCleanup(harness.tearDown)
        area = plan_area.plan_area_root(harness.vault)
        for revision in range(14):
            candidate = {"day": "2026-08-20", "planHash": f"synthetic-{revision}",
                "items": [{"itemKey": "item-0", "kind": "review", "domain": "ielts", "estimatedMinutes": 8}],
                "totalMinutes": 8, "overloaded": False, "skipped": []}
            plan_area.apply_plan_revision(area, candidate, "synthetic-owner", "test", expected_revision=revision)
        self.assertEqual(len(plan_area.read_revisions(area)), 14)
        history = area / plan_area.REVISIONS_FILE
        history_before = history.read_bytes()
        with mock.patch.object(server, "_constraint_history", return_value=events_for_minutes([60, 60, 60])):
            result = server.effective_constraints(
                harness.vault, "synthetic-owner", datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertEqual(result["system"]["dailyMinutes"]["max"], 60)
        self.assertNotIn("上调", result["explanation"])
        self.assertEqual(len(plan_area.read_revisions(area)), 14)
        self.assertEqual(history.read_bytes(), history_before)

    def test_restored_plan_is_the_last_plan_for_its_day(self):
        import tempfile
        import plan_area
        with tempfile.TemporaryDirectory() as directory:
            area = plan_area.plan_area_root(Path(directory))
            first = {"day": "2026-08-20", "planHash": "first", "items": [{"itemKey": "item-0"}]}
            second = {"day": "2026-08-20", "planHash": "second", "items": [{"itemKey": "replaced-item"}]}
            plan_area.apply_plan_revision(area, first, "synthetic-owner", "test", expected_revision=0)
            plan_area.apply_plan_revision(area, second, "synthetic-owner", "test", expected_revision=1)
            plan_area.restore_revision(area, 1, "synthetic-owner", expected_revision=2)
            history = area / plan_area.REVISIONS_FILE
            before = history.read_bytes()
            plans = [row["after"] for row in plan_area.read_revisions(area) if row["decision"] != "rejected"]
            estimate = estimate_schedule(events_for_minutes([60, 60, 60]), plans, [], date(2026, 8, 25))
            self.assertEqual(estimate.completion_ratio, 1)
            self.assertEqual(estimate.maximum_minutes, 60)
            self.assertEqual(history.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
