from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from datetime import datetime, timezone
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import authoritative_migration  # noqa: E402
import constraint_area  # noqa: E402
import plan_authority  # noqa: E402
import plan_area


def candidate(plan_hash: str = "a" * 64) -> dict:
    return {
        "day": "2026-08-25",
        "planHash": plan_hash,
        "items": [{"kind": "review", "itemKey": "word-1", "domain": "ielts", "estimatedMinutes": 8}],
        "totalMinutes": 8,
        "overloaded": False,
        "skipped": [],
    }


class AuthoritativeMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.plan = self.vault / plan_authority.PLAN_RELATIVE_PATH
        self.plan.parent.mkdir(parents=True)
        self.plan.write_text("# 学习计划总览\n\n保留我的说明。\n", encoding="utf-8")
        self.legacy = self.vault / "_System/Integrations/Study Loop/plan/revisions.jsonl"
        self.legacy.parent.mkdir(parents=True)
        self.legacy.write_text(
            json.dumps({"revision": 2, "after": candidate()}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self.now = datetime(2026, 8, 25, 8, 9, 10, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_preview_is_read_only_and_apply_requires_exact_preview_hash(self) -> None:
        before = self.plan.read_bytes()
        preview = authoritative_migration.preview(self.vault)
        self.assertEqual(self.plan.read_bytes(), before)
        self.assertEqual(preview["actions"]["plan"], "migrate")
        self.assertEqual(preview["actions"]["constraints"], "initialize")

        self.plan.write_text("# 学习计划总览\n\n用户在预览后修改了内容。\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale-migration-preview"):
            authoritative_migration.apply(self.vault, preview["previewId"], now=self.now)

    def test_preview_hash_also_binds_new_revision_history(self) -> None:
        migration_preview = authoritative_migration.preview(self.vault)
        history = self.vault / "_System/Integrations/Study Loop/plan-changes/revisions.jsonl"
        history.parent.mkdir(parents=True)
        history.write_text('{"revision":99}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale-migration-preview"):
            authoritative_migration.apply(self.vault, migration_preview["previewId"], now=self.now)

    def test_migration_note_and_history_are_one_locked_boundary_for_capture(self):
        preview = authoritative_migration.preview(self.vault)
        waiting, release, captured = threading.Event(), threading.Event(), threading.Event()
        append = plan_area.record_migrated_plan
        def pause(*args, **kwargs):
            waiting.set()
            if not release.wait(5):
                raise RuntimeError('fixture barrier timed out')
            return append(*args, **kwargs)
        def capture():
            try:
                return plan_authority.add_review_item(self.vault, {'itemId': 'captured', 'abilityId': 'ability'}, 2)
            finally:
                captured.set()
        with mock.patch.object(plan_area, 'record_migrated_plan', side_effect=pause), ThreadPoolExecutor(2) as pool:
            migration = pool.submit(authoritative_migration.apply, self.vault, preview['previewId'], self.now)
            try:
                self.assertTrue(waiting.wait(3))
                review = pool.submit(capture)
                captured.wait(.2)
            finally:
                release.set()
            self.assertEqual(migration.result(timeout=5)['status'], 'applied')
            self.assertEqual(review.result(timeout=5)['revision'], 3)
        area = plan_area.plan_area_root(self.vault)
        self.assertEqual([row['revision'] for row in plan_area.read_revisions(area)], [2, 3])
        self.assertEqual(plan_area.current_revision(area), 3)

    def test_apply_then_rollback_restores_original_bytes(self) -> None:
        before_plan = self.plan.read_bytes()
        state = self.vault / "01 学习/课程/learning-state.md"
        state.parent.mkdir(parents=True)
        state.write_text("---\ntype: learning-state\n---\n\n用户学习状态。\n", encoding="utf-8")
        event = self.vault / "_System/Integrations/Study Loop/events/2026/2026-08-25.jsonl"
        event.parent.mkdir(parents=True)
        event.write_text('{"eventId":"fixture-event"}\n', encoding="utf-8")
        before_state = state.read_bytes()
        before_event = event.read_bytes()
        preview = authoritative_migration.preview(self.vault)
        result = authoritative_migration.apply(self.vault, preview["previewId"], now=self.now)

        self.assertEqual(result["status"], "applied")
        self.assertIsNotNone(plan_authority.read_current_plan(self.vault))
        self.assertEqual(constraint_area.read_constraints(self.vault)["mode"], "auto")
        self.assertTrue(self.legacy.exists())
        history = self.vault / "_System/Integrations/Study Loop/plan-changes/revisions.jsonl"
        imported = [json.loads(line) for line in history.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(imported[0]["decision"], "migrated")
        self.assertEqual(imported[0]["revision"], 2)
        self.assertEqual(state.read_bytes(), before_state)
        self.assertEqual(event.read_bytes(), before_event)

        rollback = authoritative_migration.rollback(self.vault, result["backupId"])
        self.assertEqual(rollback["status"], "rolled-back")
        self.assertEqual(self.plan.read_bytes(), before_plan)
        self.assertFalse((self.vault / constraint_area.CONSTRAINT_RELATIVE_PATH).exists())
        self.assertFalse(history.exists())
        self.assertTrue(self.legacy.exists())
        self.assertEqual(state.read_bytes(), before_state)
        self.assertEqual(event.read_bytes(), before_event)

    def test_reapplying_after_migration_is_a_noop(self) -> None:
        first = authoritative_migration.preview(self.vault)
        authoritative_migration.apply(self.vault, first["previewId"], now=self.now)
        second = authoritative_migration.preview(self.vault)
        self.assertEqual(second["actions"], {"plan": "noop", "constraints": "noop"})
        result = authoritative_migration.apply(self.vault, second["previewId"], now=self.now)
        self.assertEqual(result["status"], "no-op")
        self.assertIsNone(result["backupId"])

    def migration_with_existing_constraints(self):
        constraints = self.vault / constraint_area.CONSTRAINT_RELATIVE_PATH
        constraints.parent.mkdir(parents=True, exist_ok=True)
        constraints.write_text("# Constraints\nOriginal user explanation.\n", encoding="utf-8")
        result = authoritative_migration.apply(
            self.vault, authoritative_migration.preview(self.vault)["previewId"], now=self.now
        )
        backup = self.vault / authoritative_migration.MIGRATION_BACKUP_ROOT / result["backupId"]
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        current = {record["relativePath"]: (self.vault / record["relativePath"]).read_bytes()
                   for record in manifest["files"]}
        return result, backup, manifest, current

    def assert_migration_targets_unchanged(self, current):
        actual = {relative: (self.vault / relative).read_bytes()
                  if (self.vault / relative).exists() else None for relative in current}
        self.assertEqual(actual, current)

    def test_corrupted_backup_is_rejected_before_any_target_is_restored(self):
        result, backup, manifest, current = self.migration_with_existing_constraints()
        last = manifest["files"][-1]
        (backup / "files" / last["relativePath"]).write_bytes(b"corrupted backup")
        with self.assertRaisesRegex(ValueError, "migration-backup-integrity"):
            authoritative_migration.rollback(self.vault, result["backupId"])
        self.assert_migration_targets_unchanged(current)

    def test_missing_late_backup_does_not_partially_restore_prior_targets(self):
        result, backup, manifest, current = self.migration_with_existing_constraints()
        (backup / "files" / manifest["files"][-1]["relativePath"]).unlink()
        with self.assertRaisesRegex(ValueError, "migration-backup-incomplete"):
            authoritative_migration.rollback(self.vault, result["backupId"])
        self.assert_migration_targets_unchanged(current)

    def test_invalid_late_target_does_not_partially_restore_prior_targets(self):
        result, backup, manifest, current = self.migration_with_existing_constraints()
        manifest["files"].append({"relativePath": "../outside.md", "existed": False, "sha256": None})
        (backup / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "migration-path-outside-vault"):
            authoritative_migration.rollback(self.vault, result["backupId"])
        self.assert_migration_targets_unchanged(current)

    def test_nonfile_late_target_is_rejected_before_prior_targets_are_restored(self):
        result, backup, manifest, current = self.migration_with_existing_constraints()
        blocked = self.vault / "blocked-directory"
        blocked.mkdir()
        manifest["files"].append({"relativePath": blocked.name, "existed": False, "sha256": None})
        (backup / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "migration-target-not-file"):
            authoritative_migration.rollback(self.vault, result["backupId"])
        self.assert_migration_targets_unchanged(current)
        self.assertTrue(blocked.is_dir())

    def test_restore_uses_verified_bytes_when_a_backup_changes_during_restore(self):
        result, backup, manifest, _current = self.migration_with_existing_constraints()
        late = manifest["files"][-1]["relativePath"]
        backup_file = backup / "files" / late
        expected = backup_file.read_bytes()
        write = Path.write_bytes

        def mutate_later_backup(path, content):
            if path == self.plan:
                write(backup_file, b"later unverified bytes")
            return write(path, content)

        with mock.patch.object(Path, "write_bytes", new=mutate_later_backup):
            restored = authoritative_migration.rollback(self.vault, result["backupId"])
        self.assertEqual(restored["status"], "rolled-back")
        self.assertEqual((self.vault / late).read_bytes(), expected)

    def test_backup_hash_matches_copied_edit_and_failed_apply_restores_that_edit(self):
        original = self.plan.read_bytes()
        edited = original + b"\nIndependent edit during backup.\n"
        copy = authoritative_migration.shutil.copy2

        def edit_before_copy(source, destination):
            if source == self.plan:
                self.plan.write_bytes(edited)
            return copy(source, destination)

        with mock.patch.object(authoritative_migration.shutil, "copy2", side_effect=edit_before_copy), \
                mock.patch.object(constraint_area, "write_constraints", side_effect=RuntimeError("fixture-apply-failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture-apply-failure"):
                authoritative_migration.apply(
                    self.vault, authoritative_migration.preview(self.vault)["previewId"], now=self.now
                )
        self.assertEqual(self.plan.read_bytes(), edited)
        backup_root = self.vault / authoritative_migration.MIGRATION_BACKUP_ROOT
        manifest_path = next(backup_root.glob("*/manifest.json"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for record in manifest["files"]:
            if record["existed"]:
                saved = manifest_path.parent / "files" / record["relativePath"]
                self.assertEqual(record["sha256"], hashlib.sha256(saved.read_bytes()).hexdigest())

    def migration_constraint_conflict(self, action):
        note = self.vault / constraint_area.CONSTRAINT_RELATIVE_PATH
        note.parent.mkdir(parents=True, exist_ok=True)
        if action != "create":
            note.write_bytes(b"# Original constraint explanation\n")
        edited = b"# Independent constraint editor change\n"
        write = Path.write_text

        def change_during_staging(path, text, *args, **kwargs):
            result = write(path, text, *args, **kwargs)
            if path.name.startswith("." + note.name + ".zhixue") and path.suffix == ".tmp":
                if action == "delete":
                    note.unlink()
                else:
                    note.write_bytes(edited)
            return result

        with mock.patch.object(Path, "write_text", new=change_during_staging):
            with self.assertRaisesRegex(ValueError, "stale-vault-edit"):
                authoritative_migration.apply(
                    self.vault, authoritative_migration.preview(self.vault)["previewId"], now=self.now)
        if action == "delete":
            self.assertFalse(note.exists())
        else:
            self.assertTrue(note.exists())
            self.assertEqual(note.read_bytes(), edited)
        self.assertIsNone(plan_authority.read_current_plan(self.vault))

    def test_failed_migration_preserves_external_constraint_edit(self):
        self.migration_constraint_conflict("edit")

    def test_failed_migration_does_not_recreate_deleted_constraints(self):
        self.migration_constraint_conflict("delete")

    def test_failed_migration_preserves_newly_created_constraints(self):
        self.migration_constraint_conflict("create")

    def test_failed_migration_restores_the_actual_plan_write_preimage(self):
        edited = self.plan.read_bytes() + b"\nEditor change after backup, before actual plan write.\n"
        backup = authoritative_migration._backup

        def edit_after_backup(*args, **kwargs):
            result = backup(*args, **kwargs)
            self.plan.write_bytes(edited)
            return result

        with mock.patch.object(authoritative_migration, "_backup", side_effect=edit_after_backup), \
                mock.patch.object(constraint_area, "write_constraints", side_effect=RuntimeError("fixture-later-failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture-later-failure"):
                authoritative_migration.apply(
                    self.vault, authoritative_migration.preview(self.vault)["previewId"], now=self.now)
        self.assertEqual(self.plan.read_bytes(), edited)

    def test_failed_migration_preserves_independent_edits_to_completed_plan_and_history(self):
        observed = {}
        history = self.vault / authoritative_migration.INTEGRATION_ROOT / plan_area.PLAN_SUBFOLDER / plan_area.REVISIONS_FILE

        def edit_completed_targets(*_args, **_kwargs):
            observed["plan"] = self.plan.read_bytes() + b"\nIndependent plan edit after write.\n"
            observed["history"] = history.read_bytes() + b'{"revision":77,"decision":"rejected"}\n'
            self.plan.write_bytes(observed["plan"])
            history.write_bytes(observed["history"])
            raise ValueError("stale-vault-edit")

        with mock.patch.object(constraint_area, "write_constraints", side_effect=edit_completed_targets):
            with self.assertRaisesRegex(ValueError, "stale-vault-edit"):
                authoritative_migration.apply(
                    self.vault, authoritative_migration.preview(self.vault)["previewId"], now=self.now)
        self.assertEqual(self.plan.read_bytes(), observed["plan"])
        self.assertEqual(history.read_bytes(), observed["history"])

    def test_missing_legacy_plan_does_not_create_empty_migration_backups(self) -> None:
        self.legacy.unlink()
        constraint_area.write_constraints(
            self.vault,
            constraint_area.default_constraints(self.now),
            self.now,
        )
        migration_preview = authoritative_migration.preview(self.vault)
        self.assertEqual(migration_preview["actions"], {"plan": "no-legacy-plan", "constraints": "noop"})

        result = authoritative_migration.apply(self.vault, migration_preview["previewId"], now=self.now)

        self.assertEqual(result["status"], "no-op")
        self.assertIsNone(result["backupId"])
        self.assertFalse((self.vault / authoritative_migration.MIGRATION_BACKUP_ROOT).exists())


if __name__ == "__main__":
    unittest.main()
