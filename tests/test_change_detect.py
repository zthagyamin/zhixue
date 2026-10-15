from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import change_detect  # noqa: E402
import source_area  # noqa: E402


def source_file(vault: Path, relative: str, content: str) -> Path:
    path = vault / "_System/Integrations/Study Loop/sources" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class ChangeDetectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.db = sqlite3.connect(":memory:")

    def tearDown(self) -> None:
        self.db.close()
        self.temp_dir.cleanup()

    def test_first_scan_reports_everything_as_added(self) -> None:
        source_file(self.vault, "a.md", "# A")
        source_file(self.vault, "b.md", "# B")
        candidates = change_detect.detect_changes(self.db, self.vault)
        kinds = sorted(candidate["kind"] for candidate in candidates)
        self.assertEqual(kinds, ["added", "added"])
        self.assertTrue(all(candidate["path"].endswith((".md")) for candidate in candidates))
        # The scan has not persisted yet: applying it changes nothing else.
        change_detect.apply_scan(self.db, self.vault)
        self.assertEqual(change_detect.detect_changes(self.db, self.vault), [])

    def test_modified_file_is_detected(self) -> None:
        path = source_file(self.vault, "a.md", "# A")
        change_detect.apply_scan(self.db, self.vault)
        path.write_text("# A changed", encoding="utf-8")
        candidates = change_detect.detect_changes(self.db, self.vault)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["kind"], "modified")
        self.assertEqual(candidates[0]["path"], "a.md")

    def test_removed_file_is_detected(self) -> None:
        path = source_file(self.vault, "a.md", "# A")
        change_detect.apply_scan(self.db, self.vault)
        path.unlink()
        candidates = change_detect.detect_changes(self.db, self.vault)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["kind"], "removed")
        self.assertEqual(candidates[0]["path"], "a.md")

    def test_rename_is_detected_from_same_content(self) -> None:
        old = source_file(self.vault, "old.md", "# Same content")
        change_detect.apply_scan(self.db, self.vault)
        old.unlink()
        new = source_file(self.vault, "new.md", "# Same content")
        candidates = change_detect.detect_changes(self.db, self.vault)
        renames = [candidate for candidate in candidates if candidate["kind"] == "renamed"]
        self.assertEqual(len(renames), 1)
        self.assertEqual(renames[0]["path"], "new.md")
        self.assertEqual(renames[0]["oldPath"], "old.md")
        self.assertEqual(renames[0]["contentHash"], change_detect.content_hash("# Same content"))

    def test_decisions_gate_pending_changes(self) -> None:
        source_file(self.vault, "a.md", "# A")
        candidates = change_detect.detect_changes(self.db, self.vault)
        change_id = candidates[0]["changeId"]
        self.assertTrue(change_detect.is_pending(self.db, candidates[0]))
        change_detect.decide(self.db, change_id, "approved", "user-001")
        self.assertFalse(change_detect.is_pending(self.db, candidates[0]))
        log = change_detect.decision_log(self.db, change_id)
        self.assertEqual(log[-1]["decision"], "approved")
        self.assertEqual(log[-1]["operator"], "user-001")
        # A later scan of the same change keeps the decision.
        change_detect.apply_scan(self.db, self.vault)
        self.assertEqual(change_detect.detect_changes(self.db, self.vault), [])

    def test_pending_filters_out_decided_changes(self) -> None:
        source_file(self.vault, "a.md", "# A")
        source_file(self.vault, "b.md", "# B")
        candidates = change_detect.detect_changes(self.db, self.vault)
        change_detect.decide(self.db, candidates[0]["changeId"], "rejected", "user-001")
        pending = change_detect.pending_changes(self.db, candidates)
        self.assertEqual(len(pending), 1)
        self.assertNotEqual(pending[0]["changeId"], candidates[0]["changeId"])

    def test_scan_projection_contains_pending_only_and_no_absolute_paths(self) -> None:
        source_file(self.vault, "a.md", "# A")
        source_file(self.vault, "b.md", "# B")
        first = change_detect.detect_changes(self.db, self.vault)
        change_detect.decide(self.db, first[0]["changeId"], "rejected", "user-001")

        status = change_detect.scan_and_project(
            self.db,
            self.vault,
            datetime(2026, 8, 25, 8, 30, tzinfo=timezone.utc),
        )
        projection = json.loads(status.projection_path.read_text(encoding="utf-8"))
        self.assertEqual(status.pending_count, 1)
        self.assertEqual(projection["pendingCount"], 1)
        self.assertEqual(projection["scannedAt"], "2026-08-25T08:30:00+00:00")
        self.assertNotIn(str(self.vault), json.dumps(projection))
        self.assertEqual(projection["changes"][0]["path"], "b.md")

    def test_failed_scan_preserves_previous_projection(self) -> None:
        source_file(self.vault, "a.md", "# A")
        first = change_detect.scan_and_project(self.db, self.vault, datetime(2026, 8, 25, tzinfo=timezone.utc))
        previous = first.projection_path.read_bytes()
        with mock.patch.object(change_detect, "detect_changes", side_effect=OSError("locked")):
            failed = change_detect.scan_and_project(self.db, self.vault, datetime(2026, 8, 25, 1, tzinfo=timezone.utc))
        self.assertEqual(failed.error, "locked")
        self.assertEqual(first.projection_path.read_bytes(), previous)

    def test_pending_edit_keeps_last_approved_source_content(self) -> None:
        old = "---\ntype: study-loop-source\nstatus: active\n---\n# 词汇\n| 单词 | 释义 |\n|---|---|\n| old-word | 旧释义 |\n"
        new = old.replace("old-word", "new-word").replace("旧释义", "新释义")
        path = source_file(self.vault, "vocabulary.md", old)
        change_detect.apply_scan(self.db, self.vault)
        path.write_text(new, encoding="utf-8")

        documents = change_detect.approved_source_documents(self.db)
        items = [item for document in documents for item in source_area.parse_source_text(document["content"], Path(document["path"]))]
        self.assertEqual([item["word"] for item in items], ["old-word"])

        candidate = change_detect.detect_changes(self.db, self.vault)[0]
        change_detect.decide_candidate(self.db, candidate, "approved", "user-001", self.vault)
        documents = change_detect.approved_source_documents(self.db)
        items = [item for document in documents for item in source_area.parse_source_text(document["content"], Path(document["path"]))]
        self.assertEqual([item["word"] for item in items], ["new-word"])

    def test_apply_scan_reads_once_for_hash_and_approved_content(self) -> None:
        path = source_file(self.vault, "a.md", "# Initial")
        original = change_detect.vault_documents.read_complete_source_text
        reads = 0
        def changing_read(current, *args, **kwargs):
            nonlocal reads
            text = original(current, *args, **kwargs)
            reads += 1
            path.write_text("# Changed", encoding="utf-8")
            return text
        with mock.patch.object(change_detect.vault_documents, "read_complete_source_text", changing_read):
            change_detect.apply_scan(self.db, self.vault)
        digest, content = self.db.execute("SELECT content_hash, approved_content FROM source_change_state").fetchone()
        self.assertEqual(digest, change_detect.content_hash(content))
        self.assertEqual(content, "# Initial")
        self.assertEqual(reads, 1)

    def test_failed_apply_scan_retains_all_approved_rows(self) -> None:
        source_file(self.vault, "a.md", "# Approved")
        change_detect.apply_scan(self.db, self.vault)
        before = self.db.execute("SELECT * FROM source_change_state").fetchall()
        with mock.patch.object(change_detect.vault_documents, "read_complete_source_text", side_effect=OSError("unreadable")):
            with self.assertRaises(OSError):
                change_detect.apply_scan(self.db, self.vault)
        self.assertEqual(self.db.execute("SELECT * FROM source_change_state").fetchall(), before)

    def _redirect(self, target):
        original = Path.lstat
        def attributes(current, *args, **kwargs):
            info = original(current, *args, **kwargs)
            if current == target:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400,
                                       st_reparse_tag=0xA0000003)
            return info
        return mock.patch.object(Path, "lstat", attributes)

    def test_redirected_source_is_error_not_removed_candidate(self) -> None:
        path = source_file(self.vault, "nested/a.md", "# Approved")
        change_detect.apply_scan(self.db, self.vault)
        before = self.db.execute("SELECT * FROM source_change_state").fetchall()
        for target in (path, path.parent):
            with self.subTest(target=target.name), self._redirect(target):
                with self.assertRaises(ValueError):
                    change_detect.detect_changes(self.db, self.vault)
                with self.assertRaises(ValueError):
                    change_detect.apply_scan(self.db, self.vault)
            self.assertEqual(self.db.execute("SELECT * FROM source_change_state").fetchall(), before)

    def test_candidate_rejects_escaping_or_invalid_relative_names(self) -> None:
        outside = self.vault / "synthetic-outside.md"
        outside.write_text("# Outside", encoding="utf-8")
        for raw in (str(outside), "../../../../synthetic-outside.md", "nested/../a.md",
                    "C:\\synthetic\\outside.md", "a.md:stream", "nested\\a.md"):
            with self.subTest(raw=raw):
                candidate = change_detect._make_candidate("added", raw, change_detect.content_hash("# Outside"))
                with self.assertRaises(ValueError):
                    change_detect.decide_candidate(self.db, candidate, "approved", "synthetic-operator", self.vault)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM source_change_state").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM source_change_log").fetchone()[0], 0)

    def test_legacy_backfill_never_reads_outside_source_area(self) -> None:
        outside = self.vault / "synthetic-outside.md"
        outside.write_text("# Outside", encoding="utf-8")
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, NULL, NULL, 'old')",
                        (str(outside), change_detect.content_hash("# Outside")))
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                        ("historical.md", "historic-digest", "# Preserved historical content"))
        self.db.commit()
        docs = change_detect.approved_source_documents(self.db, self.vault)
        self.assertEqual(docs, [{"path": "historical.md", "content": "# Preserved historical content"}])
        self.assertIsNone(self.db.execute("SELECT approved_content FROM source_change_state WHERE path = ?", (str(outside),)).fetchone()[0])

    def test_projection_redirect_fails_without_reading_other_root(self) -> None:
        source_file(self.vault, "a.md", "# A")
        status = change_detect.scan_and_project(self.db, self.vault)
        original = status.projection_path.read_bytes()
        for target in (status.projection_path, status.projection_path.parent):
            with self.subTest(target=target.name), self._redirect(target):
                with self.assertRaises(ValueError):
                    change_detect.read_projection(self.vault)
                failed = change_detect.scan_and_project(self.db, self.vault)
                self.assertIsNotNone(failed.error)
                self.assertEqual(failed.pending_count, 0)
            self.assertEqual(status.projection_path.read_bytes(), original)

    def test_projection_rejects_fixed_temporary_redirection(self) -> None:
        source_file(self.vault, "a.md", "# A")
        status = change_detect.scan_and_project(self.db, self.vault)
        temporary = status.projection_path.with_name(f".{status.projection_path.name}.zhixue.tmp")
        temporary.write_bytes(b"synthetic foreign temporary")
        with self._redirect(temporary):
            change_detect.scan_and_project(self.db, self.vault)
            # Implementations may avoid the old fixed name entirely.
            self.assertEqual(temporary.read_bytes(), b"synthetic foreign temporary")
        self.assertEqual(json.loads(status.projection_path.read_text(encoding="utf-8"))["pendingCount"], 1)

    def test_oversized_source_does_not_remove_approved_snapshot(self) -> None:
        path = source_file(self.vault, "a.md", "# Approved")
        change_detect.apply_scan(self.db, self.vault)
        before = self.db.execute("SELECT * FROM source_change_state").fetchall()
        with path.open("r+b") as handle:
            handle.seek(20_000_000)
            handle.write(b"x")
        self.assertEqual(path.stat().st_size, 20_000_001)
        for action in (change_detect.scan_files, lambda vault: change_detect.apply_scan(self.db, vault),
                       lambda vault: change_detect.detect_changes(self.db, vault)):
            with self.subTest(action=action), self.assertRaises(ValueError):
                action(self.vault)
        self.assertEqual(self.db.execute("SELECT * FROM source_change_state").fetchall(), before)

    def test_complete_content_keeps_vocabulary_beyond_excerpt_limit(self) -> None:
        text = "---\ntype: study-loop-source\nstatus: active\n---\n" + "padding\n" * 12_000
        text += "\n| 单词 | 释义 |\n|---|---|\n| tail-word | 完整释义 |\n"
        source_file(self.vault, "long.md", text)
        change_detect.apply_scan(self.db, self.vault)
        row = self.db.execute("SELECT content_hash, approved_content FROM source_change_state").fetchone()
        self.assertEqual(row, (change_detect.content_hash(text), text))
        documents = change_detect.approved_source_documents(self.db)
        items = source_area.parse_source_text(documents[0]["content"], Path("long.md"))
        self.assertEqual([item["word"] for item in items], ["tail-word"])

    def test_invalid_renamed_old_path_cannot_delete_existing_row(self) -> None:
        source_file(self.vault, "new.md", "# New")
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                        ("../old.md", "old-digest", "# Preserved"))
        self.db.commit()
        candidate = change_detect._make_candidate("renamed", "new.md", change_detect.content_hash("# New"))
        candidate["oldPath"] = "../old.md"
        with self.assertRaises(ValueError):
            change_detect.decide_candidate(self.db, candidate, "approved", "synthetic-operator", self.vault)
        self.assertEqual(self.db.execute("SELECT path, approved_content FROM source_change_state").fetchall(),
                         [("../old.md", "# Preserved")])

    def test_projection_concurrent_edit_is_not_overwritten(self) -> None:
        source_file(self.vault, "a.md", "# A")
        status = change_detect.scan_and_project(self.db, self.vault)
        edit = b'{"pendingCount": 7, "changes": []}'
        original = change_detect.detect_changes
        def concurrent_edit(*args):
            candidates = original(*args)
            status.projection_path.write_bytes(edit)
            return candidates
        with mock.patch.object(change_detect, "detect_changes", concurrent_edit):
            failed = change_detect.scan_and_project(self.db, self.vault)
        self.assertIn("conflict", failed.error)
        self.assertEqual(failed.pending_count, 7)
        self.assertEqual(status.projection_path.read_bytes(), edit)

    def test_backfill_failed_read_does_not_partially_update_rows(self) -> None:
        change_detect.ensure_schema(self.db)
        for name in ("a.md", "b.md"):
            source_file(self.vault, name, "# Approved")
            self.db.execute("INSERT INTO source_change_state VALUES (?, ?, NULL, NULL, 'old')",
                            (name, change_detect.content_hash("# Approved")))
        self.db.commit()
        original = change_detect.vault_documents.read_complete_source_text
        def fail_second(path, *args, **kwargs):
            if path.name == "b.md":
                raise OSError("synthetic unreadable source")
            return original(path, *args, **kwargs)
        with mock.patch.object(change_detect.vault_documents, "read_complete_source_text", fail_second):
            with self.assertRaises(OSError):
                change_detect.approved_source_documents(self.db, self.vault)
        self.assertEqual(self.db.execute("SELECT approved_content FROM source_change_state").fetchall(), [(None,), (None,)])

    def test_legacy_absolute_approved_source_keeps_detection_and_backfill(self) -> None:
        path = source_file(self.vault, "nested/a.md", "# Approved")
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, NULL, NULL, 'old')",
                        (str(path), change_detect.content_hash("# Approved")))
        self.db.commit()
        self.assertEqual(change_detect.detect_changes(self.db, self.vault), [])
        self.assertEqual(change_detect.approved_source_paths(self.db, self.vault), {str(path)})
        self.assertEqual(change_detect.approved_source_documents(self.db, self.vault),
                         [{"path": str(path), "content": "# Approved"}])
        self.assertEqual(self.db.execute("SELECT path, approved_content FROM source_change_state").fetchall(),
                         [(str(path), "# Approved")])
        path.unlink()
        changes = change_detect.detect_changes(self.db, self.vault)
        self.assertEqual([(item["kind"], item["path"]) for item in changes], [("removed", "nested/a.md")])

    def test_legacy_outside_absolute_row_is_never_read_or_reclassified(self) -> None:
        outside = self.vault / "synthetic-outside.md"
        outside.write_text("# Outside", encoding="utf-8")
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, NULL, NULL, 'old')",
                        (str(outside), change_detect.content_hash("# Outside")))
        self.db.commit()
        original = change_detect.vault_documents.read_complete_source_text
        reads = []
        def read_only_sources(path, *args, **kwargs):
            reads.append(path)
            if path == outside:
                raise AssertionError("Outside source was read")
            return original(path, *args, **kwargs)
        with mock.patch.object(change_detect.vault_documents, "read_complete_source_text", read_only_sources):
            self.assertEqual(change_detect.detect_changes(self.db, self.vault), [])
            self.assertEqual(change_detect.approved_source_paths(self.db, self.vault), set())
            self.assertEqual(change_detect.approved_source_documents(self.db, self.vault), [])
        self.assertEqual(reads, [])
        self.assertEqual(self.db.execute("SELECT path, approved_content FROM source_change_state").fetchall(),
                         [(str(outside), None)])

    def test_saved_absolute_approved_content_needs_no_filesystem_read(self) -> None:
        missing = self.vault / "synthetic-missing.md"
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                        (str(missing), "historic-digest", "# Historical approved snapshot"))
        self.db.commit()
        with mock.patch.object(change_detect.vault_documents, "read_complete_source_text", side_effect=AssertionError("Unexpected source read")):
            self.assertEqual(change_detect.approved_source_documents(self.db, self.vault),
                             [{"path": str(missing), "content": "# Historical approved snapshot"}])

    def _seed_historical_path_controls(self, old: Path) -> None:
        change_detect.ensure_schema(self.db)
        rows = [(str(old), change_detect.content_hash("# Approved"), "# Approved"),
                (str(self.vault / "synthetic-other-root" / old.name), "outside-digest", "# Outside retained"),
                ("different.md", "different-digest", "# Different source retained")]
        self.db.executemany("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')", rows)
        self.db.commit()

    def test_removed_approval_deletes_matching_legacy_absolute_key_only(self) -> None:
        old = source_file(self.vault, "old.md", "# Approved")
        self._seed_historical_path_controls(old)
        old.unlink()
        removed = next(item for item in change_detect.detect_changes(self.db, self.vault) if item["path"] == "old.md")
        change_detect.decide_candidate(self.db, removed, "approved", "synthetic-operator", self.vault)
        rows = dict(self.db.execute("SELECT path, approved_content FROM source_change_state").fetchall())
        self.assertNotIn(str(old), rows)
        self.assertEqual(rows, {str(self.vault / "synthetic-other-root/old.md"): "# Outside retained",
                                "different.md": "# Different source retained"})

    def test_renamed_approval_deletes_matching_legacy_absolute_key_only(self) -> None:
        old = source_file(self.vault, "old.md", "# Approved")
        self._seed_historical_path_controls(old)
        old.unlink()
        source_file(self.vault, "new.md", "# Approved")
        renamed = next(item for item in change_detect.detect_changes(self.db, self.vault) if item["kind"] == "renamed")
        change_detect.decide_candidate(self.db, renamed, "approved", "synthetic-operator", self.vault)
        rows = dict(self.db.execute("SELECT path, approved_content FROM source_change_state").fetchall())
        self.assertNotIn(str(old), rows)
        self.assertEqual(rows["new.md"], "# Approved")
        self.assertEqual(rows[str(self.vault / "synthetic-other-root/old.md")], "# Outside retained")
        self.assertEqual(rows["different.md"], "# Different source retained")
        digest, content = self.db.execute("SELECT content_hash, approved_content FROM source_change_state WHERE path='new.md'").fetchone()
        self.assertEqual(digest, change_detect.content_hash(content))

    def test_redirected_historical_source_keys_are_not_deleted(self) -> None:
        old = source_file(self.vault, "old.md", "# Approved")
        change_detect.ensure_schema(self.db)
        for key in (str(old), "old.md"):
            self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                            (key, change_detect.content_hash("# Approved"), "# Approved"))
        self.db.commit()
        before = self.db.execute("SELECT * FROM source_change_state").fetchall()
        removed = change_detect._make_candidate("removed", "old.md", change_detect.content_hash("# Approved"))
        with self._redirect(old):
            change_detect.decide_candidate(self.db, removed, "approved", "synthetic-operator", self.vault)
        self.assertEqual(self.db.execute("SELECT * FROM source_change_state").fetchall(), before)

    def test_removed_without_vault_keeps_old_relative_only_behavior(self) -> None:
        old = source_file(self.vault, "old.md", "# Approved")
        change_detect.ensure_schema(self.db)
        for key in (str(old), "old.md"):
            self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                            (key, change_detect.content_hash("# Approved"), "# Approved"))
        self.db.commit()
        removed = change_detect._make_candidate("removed", "old.md", change_detect.content_hash("# Approved"))
        change_detect.decide_candidate(self.db, removed, "approved", "synthetic-operator")
        self.assertEqual(self.db.execute("SELECT path FROM source_change_state").fetchall(), [(str(old),)])

    def test_modified_absolute_key_updates_existing_snapshot_without_migration(self) -> None:
        path = source_file(self.vault, "a.md", "# Approved old")
        change_detect.ensure_schema(self.db)
        self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                        (str(path), change_detect.content_hash("# Approved old"), "# Approved old"))
        self.db.commit()
        path.write_text("# Approved new", encoding="utf-8")
        candidate = change_detect.detect_changes(self.db, self.vault)[0]
        self.assertEqual(candidate["kind"], "modified")
        change_detect.decide_candidate(self.db, candidate, "approved", "synthetic-operator", self.vault)
        self.assertEqual(change_detect.approved_source_documents(self.db),
                         [{"path": str(path), "content": "# Approved new"}])
        self.assertEqual(self.db.execute("SELECT path, content_hash FROM source_change_state").fetchall(),
                         [(str(path), change_detect.content_hash("# Approved new"))])

    def test_duplicate_absolute_and_relative_keys_require_conflict_review(self) -> None:
        path = source_file(self.vault, "a.md", "# Approved new")
        change_detect.ensure_schema(self.db)
        for second_content in ("# Old same", "# Old different"):
            with self.subTest(second_content=second_content):
                self.db.execute("DELETE FROM source_change_state")
                for key, content in ((str(path), "# Old same"), ("a.md", second_content)):
                    self.db.execute("INSERT INTO source_change_state VALUES (?, ?, ?, NULL, 'old')",
                                    (key, change_detect.content_hash(content), content))
                self.db.commit()
                before = self.db.execute("SELECT * FROM source_change_state ORDER BY path").fetchall()
                candidate = change_detect._make_candidate("modified", "a.md", change_detect.content_hash("# Approved new"))
                with self.assertRaisesRegex(ValueError, "source-change-conflict"):
                    change_detect.decide_candidate(self.db, candidate, "approved", "synthetic-operator", self.vault)
                self.assertEqual(self.db.execute("SELECT * FROM source_change_state ORDER BY path").fetchall(), before)
                self.assertEqual(change_detect.decision_log(self.db, candidate["changeId"]), [])


if __name__ == "__main__":
    unittest.main()
