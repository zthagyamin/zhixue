from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import constraint_area  # noqa: E402


class ConstraintAreaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.path = self.vault / "01 学习/学习计划/01 学习约束.md"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_missing_file_returns_safe_auto_defaults(self) -> None:
        doc = constraint_area.read_constraints(
            self.vault,
            datetime(2026, 8, 25, tzinfo=timezone.utc),
        )
        self.assertEqual(doc["mode"], "auto")
        self.assertEqual(doc["effective"]["dailyMinutes"], {"min": 30, "max": 60})
        self.assertGreaterEqual(doc["effective"]["minimumReviewMinutes"], 10)

    def test_round_trip_preserves_user_notes_outside_managed_block(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text("# 学习约束\n\n这里是我自己的说明。\n", encoding="utf-8")
        document = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
        document["mode"] = "locked"
        document["override"] = {"dailyMinutes": {"min": 45, "max": 90}}

        constraint_area.write_constraints(
            self.vault,
            document,
            datetime(2026, 8, 25, tzinfo=timezone.utc),
        )

        self.assertIn("这里是我自己的说明。", self.path.read_text(encoding="utf-8"))
        stored = constraint_area.read_constraints(self.vault, datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertEqual(stored["mode"], "locked")
        self.assertEqual(stored["effective"]["dailyMinutes"], {"min": 45, "max": 90})

    def test_expired_temporary_override_falls_back_to_system_estimate(self) -> None:
        document = constraint_area.default_constraints(datetime(2026, 8, 20, tzinfo=timezone.utc))
        document["mode"] = "temporary"
        document["temporaryUntil"] = "2026-08-24T00:00:00+00:00"
        document["override"] = {"dailyMinutes": {"min": 100, "max": 120}}
        constraint_area.write_constraints(self.vault, document, datetime(2026, 8, 20, tzinfo=timezone.utc))

        stored = constraint_area.read_constraints(self.vault, datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertEqual(stored["effective"]["dailyMinutes"], stored["system"]["dailyMinutes"])

    def test_invalid_locked_override_does_not_overwrite_existing_file(self) -> None:
        valid = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
        constraint_area.write_constraints(self.vault, valid, datetime(2026, 8, 25, tzinfo=timezone.utc))
        previous = self.path.read_bytes()
        invalid = dict(valid)
        invalid["mode"] = "locked"
        invalid["override"] = {"dailyMinutes": {"min": 90, "max": 20}}
        with self.assertRaisesRegex(ValueError, "invalid-daily-minutes"):
            constraint_area.write_constraints(self.vault, invalid, datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertEqual(self.path.read_bytes(), previous)

    def test_invalid_deadline_priority_is_rejected_without_overwrite(self) -> None:
        valid = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
        constraint_area.write_constraints(self.vault, valid, datetime(2026, 8, 25, tzinfo=timezone.utc))
        previous = self.path.read_bytes()
        invalid = dict(valid)
        invalid["deadlines"] = [{"date": "2026-09-01", "title": "考试", "priority": 6, "scopeRef": "ielts"}]
        with self.assertRaisesRegex(ValueError, "invalid-deadline"):
            constraint_area.write_constraints(self.vault, invalid, datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertEqual(self.path.read_bytes(), previous)

    def test_temporary_mode_requires_a_future_expiry_and_override(self) -> None:
        document = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
        document["mode"] = "temporary"
        document["override"] = {"dailyMinutes": {"min": 45, "max": 60}}
        with self.assertRaisesRegex(ValueError, "invalid-temporary-expiry"):
            constraint_area.write_constraints(self.vault, document, datetime(2026, 8, 25, tzinfo=timezone.utc))

    def test_invalid_rhythm_load_and_review_minutes_are_rejected(self) -> None:
        for override in (
            {"weeklyRhythm": {"workdayMinutes": -1, "weekendMinutes": 45}},
            {"loadFactor": 1.5},
            {"minimumReviewMinutes": 181},
        ):
            document = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
            document["mode"] = "locked"
            document["override"] = override
            with self.assertRaises(ValueError):
                constraint_area.write_constraints(self.vault, document, datetime(2026, 8, 25, tzinfo=timezone.utc))

    def test_constraint_write_preserves_crlf_outside_the_block(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b"# constraints\r\n\r\nuser text\r\n")
        document = constraint_area.default_constraints(datetime(2026, 8, 25, tzinfo=timezone.utc))
        constraint_area.write_constraints(self.vault, document, datetime(2026, 8, 25, tzinfo=timezone.utc))
        self.assertIn(b"user text\r\n", self.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
