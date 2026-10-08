from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

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


if __name__ == "__main__":
    unittest.main()
