from __future__ import annotations

import tempfile
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock
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

    def constraint_save_race(self, action):
        now = datetime(2026, 8, 25, tzinfo=timezone.utc)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if action != "create":
            self.path.write_bytes(b"# constraints\r\nOriginal explanation.\r\n")
        independent = b"# constraints\r\nIndependent editor change.\r\n"
        write = Path.write_text

        def external_change_after_staging(path, text, *args, **kwargs):
            result = write(path, text, *args, **kwargs)
            if path.name.startswith("." + self.path.name + ".zhixue") and path.suffix == ".tmp":
                if action == "delete":
                    self.path.unlink()
                else:
                    self.path.write_bytes(independent)
            return result

        with mock.patch.object(Path, "write_text", new=external_change_after_staging):
            with self.assertRaisesRegex(ValueError, "stale-vault-edit"):
                constraint_area.write_constraints(self.vault, constraint_area.default_constraints(now), now)
        if action == "delete":
            self.assertFalse(self.path.exists())
        else:
            self.assertEqual(self.path.read_bytes(), independent)
        self.assertFalse(list(self.path.parent.glob(".*.zhixue*.tmp")))

    def test_save_rejects_external_edit_without_overwriting_it(self):
        self.constraint_save_race("edit")

    def test_save_does_not_recreate_a_note_deleted_during_staging(self):
        self.constraint_save_race("delete")

    def test_save_preserves_a_note_created_during_staging(self):
        self.constraint_save_race("create")

    def test_save_reports_a_post_replace_edit_instead_of_claiming_success(self):
        now = datetime(2026, 8, 25, tzinfo=timezone.utc)
        edited = b"# Independent edit after replace\n"
        replace = Path.replace

        def edit_after_replace(path, destination):
            result = replace(path, destination)
            if path.name.startswith("." + self.path.name + ".zhixue"):
                self.path.write_bytes(edited)
            return result

        with mock.patch.object(Path, "replace", new=edit_after_replace):
            with self.assertRaisesRegex(ValueError, "stale-vault-edit"):
                constraint_area.write_constraints(self.vault, constraint_area.default_constraints(now), now)
        self.assertEqual(self.path.read_bytes(), edited)

    def test_refresh_does_not_overwrite_managed_settings_changed_during_estimation(self):
        import test_companion as companion_fixture
        server = companion_fixture.server
        harness = companion_fixture.CompanionSyncTests(
            "test_state_projection_failure_rolls_back_event_and_vault_log")
        harness.setUp()
        self.addCleanup(harness.tearDown)
        now = datetime(2026, 8, 25, tzinfo=timezone.utc)
        document = constraint_area.default_constraints(now)
        constraint_area.write_constraints(harness.vault, document, now)
        document["mode"] = "locked"
        document["override"] = {"dailyMinutes": {"min": 90, "max": 120}}
        constraint_area.write_constraints(self.vault, document, now)
        edited = self.path.read_bytes()
        note = harness.vault / constraint_area.CONSTRAINT_RELATIVE_PATH
        estimate = server.history_estimator.estimate_schedule

        def edit_during_estimation(*args, **kwargs):
            note.write_bytes(edited)
            return estimate(*args, **kwargs)

        with mock.patch.object(server.history_estimator, "estimate_schedule", side_effect=edit_during_estimation):
            with self.assertRaisesRegex(ValueError, "stale-vault-edit"):
                server.effective_constraints(harness.vault, "synthetic-constraint-owner", now)
        self.assertEqual(note.read_bytes(), edited)

    def test_actual_constraints_http_reports_edit_conflict_and_preserves_the_note(self):
        import test_companion as companion_fixture
        server = companion_fixture.server
        harness = companion_fixture.CompanionSyncTests(
            "test_state_projection_failure_rolls_back_event_and_vault_log")
        harness.setUp()
        self.addCleanup(harness.tearDown)
        note = harness.vault / constraint_area.CONSTRAINT_RELATIVE_PATH
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_bytes(b"# constraints\r\nInitial explanation.\r\n")
        edited = b"# constraints\r\nIndependent edit during HTTP save.\r\n"
        origin = "http://127.0.0.1:3080"
        server.CONFIG["allowed_origins"] = [origin]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        def stop():
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=3)

        self.addCleanup(stop)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        headers = {"Origin": origin, "Content-Type": "application/json"}
        request = urllib.request.Request(base + "/v1/pair", method="POST", headers=headers,
            data=json.dumps({"code": "A1B2C3", "userId": "synthetic-constraint-owner"}).encode())
        with urllib.request.urlopen(request, timeout=5) as response:
            paired = json.load(response)
        headers["X-Study-Loop-Session"] = paired["sessionToken"]
        write = Path.write_text

        def edit_during_staging(path, *args, **kwargs):
            result = write(path, *args, **kwargs)
            if path.name.startswith(f".{note.name}.zhixue") and path.suffix == ".tmp":
                note.write_bytes(edited)
            return result

        request = urllib.request.Request(base + "/v1/constraints", method="POST", headers=headers,
            data=json.dumps({"constraints": constraint_area.default_constraints(
                datetime(2026, 8, 25, tzinfo=timezone.utc))}).encode())
        with mock.patch.object(Path, "write_text", new=edit_during_staging):
            try:
                urllib.request.urlopen(request, timeout=5).close()
                self.fail("A changed constraints note was accepted")
            except urllib.error.HTTPError as error:
                with error:
                    self.assertEqual(error.code, 409)
                    payload = json.load(error)
        self.assertEqual(payload["status"], "stale")
        self.assertIn("重新读取", payload["message"])
        self.assertNotIn(str(harness.vault), payload["message"])
        self.assertEqual(note.read_bytes(), edited)
        self.assertFalse(list(note.parent.glob(".*.zhixue*.tmp")))


if __name__ == "__main__":
    unittest.main()
