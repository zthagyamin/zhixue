from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import events_archive  # noqa: E402


class EventsArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.events_root = self.vault / "_System/Integrations/Study Loop/events"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_event_file(self, day: str, lines: list[dict]) -> Path:
        year = day[:4]
        path = self.events_root / year / f"{day}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8")
        return path

    def test_archive_moves_old_months_and_keeps_current(self) -> None:
        self.write_event_file("2026-06-30", [{"eventId": "e1", "domain": "ielts", "durationMin": 5}])
        self.write_event_file("2026-07-15", [{"eventId": "e2", "domain": "python", "durationMin": 8}])
        current = self.write_event_file("2026-08-25", [{"eventId": "e3", "domain": "ielts", "durationMin": 2}])

        archived = events_archive.archive_old_months(self.vault, 2026, 8)
        self.assertEqual(len(archived), 2)
        self.assertFalse((self.events_root / "2026" / "2026-06-30.jsonl").exists())
        self.assertTrue((self.events_root / "archive" / "2026-06" / "2026-06-30.jsonl").exists())
        self.assertTrue((self.events_root / "archive" / "2026-07" / "2026-07-15.jsonl").exists())
        self.assertTrue(current.exists(), "current month must not be archived")

    def test_archive_is_idempotent(self) -> None:
        self.write_event_file("2026-06-30", [{"eventId": "e1", "domain": "ielts", "durationMin": 5}])
        first = events_archive.archive_old_months(self.vault, 2026, 8)
        second = events_archive.archive_old_months(self.vault, 2026, 8)
        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 0)

    def test_month_summary_counts_events_and_minutes(self) -> None:
        self.write_event_file("2026-08-20", [
            {"eventId": "a1", "domain": "ielts", "durationMin": 5, "title": "词卡"},
            {"eventId": "a2", "domain": "python", "durationMin": 8, "title": "练习"},
        ])
        self.write_event_file("2026-08-25", [
            {"eventId": "a3", "domain": "ielts", "durationMin": 2, "title": "复习"},
        ])
        summary = events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertTrue(summary.exists())
        content = summary.read_text(encoding="utf-8")
        self.assertIn("2026-08", content)
        self.assertIn("3", content)  # event count
        self.assertIn("15", content)  # total minutes
        self.assertIn("ielts", content)

    def test_summary_writes_only_to_integration_area(self) -> None:
        self.write_event_file("2026-08-25", [{"eventId": "a1", "domain": "ielts", "durationMin": 2}])
        summary = events_archive.write_month_summary(self.vault, 2026, 8)
        relative = str(summary.relative_to(self.vault))
        self.assertTrue(relative.startswith("_System"), relative)


if __name__ == "__main__":
    unittest.main()
