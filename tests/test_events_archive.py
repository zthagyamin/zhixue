from __future__ import annotations

import json
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
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

    def test_summary_preserves_foreign_page(self) -> None:
        target = self.vault / events_archive.STUDY_LOOP_INTEGRATION_ROOT / "学习记录/2026-08.md"
        target.parent.mkdir(parents=True)
        original = b"# User-owned monthly notes\n"
        target.write_bytes(original)
        with self.assertRaisesRegex(ValueError, "summary.*conflict"):
            events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertEqual(target.read_bytes(), original)

    def test_summary_regenerates_only_its_own_format(self) -> None:
        self.write_event_file("2026-08-25", [{"durationMin": 2}])
        target = events_archive.write_month_summary(self.vault, 2026, 8)
        self.write_event_file("2026-08-26", [{"durationMin": 3}])
        events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertIn("event_count: 2", target.read_text(encoding="utf-8"))
        original = target.read_bytes() + b"\nPersonal addition\n"
        target.write_bytes(original)
        with self.assertRaisesRegex(ValueError, "summary.*conflict"):
            events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertEqual(target.read_bytes(), original)

    def test_summary_rejects_wrong_month_and_marker_only_page(self) -> None:
        target = self.vault / events_archive.STUDY_LOOP_INTEGRATION_ROOT / "学习记录/2026-08.md"
        target.parent.mkdir(parents=True)
        for original in (
            "---\ntype: study-loop-month-summary\nstatus: derived\nmonth: 2026-08\n---\n# Private note\n",
            "---\ntype: study-loop-month-summary\nstatus: derived\nmonth: 2026-07\n---\n",
        ):
            with self.subTest(original=original):
                target.write_text(original, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "summary.*conflict"):
                    events_archive.write_month_summary(self.vault, 2026, 8)
                self.assertEqual(target.read_text(encoding="utf-8"), original)

    def test_existing_archive_target_keeps_both_files(self) -> None:
        source = self.write_event_file("2026-06-30", [{"eventId": "original"}])
        target = self.events_root / "archive/2026-06/2026-06-30.jsonl"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"previous archive\n")
        before = source.read_bytes()
        self.assertEqual(events_archive.archive_old_months(self.vault, 2026, 8), [])
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(target.read_bytes(), b"previous archive\n")

    def _pretend_redirect(self, path: Path):
        original_lstat = Path.lstat
        def synthetic_lstat(current, *args, **kwargs):
            info = original_lstat(current, *args, **kwargs)
            if current == path:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400,
                                       st_reparse_tag=0xA0000003)
            return info
        return mock.patch.object(Path, "lstat", synthetic_lstat)

    def test_archive_preflights_all_targets_before_any_move(self) -> None:
        first = self.write_event_file("2026-06-30", [{"eventId": "first"}])
        second = self.write_event_file("2026-07-30", [{"eventId": "second"}])
        redirected = self.events_root / "archive/2026-07"
        redirected.mkdir(parents=True)
        with self._pretend_redirect(redirected):
            with self.assertRaises(ValueError):
                events_archive.archive_old_months(self.vault, 2026, 8)
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertFalse((self.events_root / "archive/2026-06").exists())

    def test_redirected_source_and_summary_ancestors_are_rejected(self) -> None:
        source = self.write_event_file("2026-06-30", [{"eventId": "first"}])
        summary_dir = self.vault / events_archive.STUDY_LOOP_INTEGRATION_ROOT / "学习记录"
        summary_dir.mkdir()
        for redirected, action in (
            (source, lambda: events_archive.archive_old_months(self.vault, 2026, 8)),
            (source.parent, lambda: events_archive.archive_old_months(self.vault, 2026, 8)),
            (summary_dir, lambda: events_archive.write_month_summary(self.vault, 2026, 8)),
        ):
            with self.subTest(path=redirected.name), self._pretend_redirect(redirected):
                with self.assertRaises(ValueError):
                    action()
        self.assertTrue(source.exists())
        self.assertFalse((summary_dir / "2026-08.md").exists())

    def test_summary_rejects_redirected_input_before_output(self) -> None:
        source = self.write_event_file("2026-08-30", [{"durationMin": 5}])
        with self._pretend_redirect(source):
            with self.assertRaises(ValueError):
                events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertFalse((self.vault / events_archive.STUDY_LOOP_INTEGRATION_ROOT / "学习记录").exists())

    def test_archive_rechecks_destination_after_directory_creation(self) -> None:
        source = self.write_event_file("2026-06-30", [{"eventId": "first"}])
        target_dir = self.events_root / "archive/2026-06"
        created = False
        original_lstat, original_mkdir = Path.lstat, Path.mkdir
        def synthetic_lstat(current, *args, **kwargs):
            info = original_lstat(current, *args, **kwargs)
            if created and current == target_dir:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400,
                                       st_reparse_tag=0xA0000003)
            return info
        def simulated_swap(current, *args, **kwargs):
            nonlocal created
            result = original_mkdir(current, *args, **kwargs)
            if current == target_dir:
                created = True
            return result
        with mock.patch.object(Path, "mkdir", simulated_swap), mock.patch.object(Path, "lstat", synthetic_lstat):
            with self.assertRaises(ValueError):
                events_archive.archive_old_months(self.vault, 2026, 8)
        self.assertTrue(source.exists())
        self.assertEqual(list(target_dir.iterdir()), [])

    def test_summary_concurrent_edit_preserves_new_preimage(self) -> None:
        target = events_archive.write_month_summary(self.vault, 2026, 8)
        original_reader = events_archive._read_month_events
        edit = b"# Concurrent personal edit\n"
        def concurrent_edit(*args):
            events = original_reader(*args)
            target.write_bytes(edit)
            return events
        with mock.patch.object(events_archive, "_read_month_events", concurrent_edit):
            with self.assertRaisesRegex(ValueError, "edit-conflict"):
                events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertEqual(target.read_bytes(), edit)
        self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    def test_redirected_vault_ancestor_rejects_both_actions(self) -> None:
        nested = self.vault / "nested-vault"
        nested.mkdir()
        with self._pretend_redirect(self.vault):
            for action in (
                lambda: events_archive.archive_old_months(nested, 2026, 8),
                lambda: events_archive.write_month_summary(nested, 2026, 8),
            ):
                with self.subTest(action=action), self.assertRaises(ValueError):
                    action()
        self.assertEqual(list(nested.iterdir()), [])

    def test_old_generated_crlf_summary_remains_compatible(self) -> None:
        target = events_archive.write_month_summary(self.vault, 2026, 8)
        target.write_bytes(target.read_bytes().replace(b"\n", b"\r\n"))
        events_archive.write_month_summary(self.vault, 2026, 8)
        self.assertIn("event_count: 0", target.read_text(encoding="utf-8"))

    def test_actual_linked_archive_is_rejected_if_available(self) -> None:
        source = self.write_event_file("2026-06-30", [{"eventId": "first"}])
        outside = self.vault / "synthetic-other-directory"
        outside.mkdir()
        link = self.events_root / "archive"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Actual synthetic symlink unavailable: {error}")
        with self.assertRaises(ValueError):
            events_archive.archive_old_months(self.vault, 2026, 8)
        self.assertTrue(source.exists())
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
