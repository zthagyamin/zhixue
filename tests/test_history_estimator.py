from __future__ import annotations

import unittest
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


if __name__ == "__main__":
    unittest.main()
