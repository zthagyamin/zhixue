import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))
import capture_store  # noqa: E402
import plan_authority  # noqa: E402


def make_capture(capture_id="cap-1", evidence="explicit", with_state=True):
    capture = {
        "captureId": capture_id, "itemId": "zhx-word-pooling", "domain": "ielts",
        "sourceNote": "P2.md", "abilityId": "pooling-layer",
        "contentFingerprint": "abc", "pluginType": "three-stage", "planRevision": 0,
        "evidence": evidence, "summary": "今天论文里的 pooling layer",
    }
    if with_state:
        capture["stateRef"] = "L16.md"
    return capture


def candidate(plan_hash: str = "a" * 64) -> dict:
    return {
        "day": "2026-08-25",
        "planHash": plan_hash,
        "items": [{"kind": "review", "itemKey": "word-1", "domain": "ielts", "estimatedMinutes": 8}],
        "totalMinutes": 8,
        "overloaded": False,
        "skipped": [],
    }


class CaptureFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.plan_path = self.vault / "01 学习/学习计划/00 学习计划总览.md"
        self.plan_path.parent.mkdir(parents=True)
        self.plan_path.write_text("# 学习计划总览\n\n用户说明。\n", encoding="utf-8")
        plan_authority.apply_current_plan(self.vault, candidate(), revision=1)

    def tearDown(self) -> None:
        self.db.close()
        self.temp_dir.cleanup()

    def test_explicit_capture_enters_review_and_marks_processed(self) -> None:
        result = capture_store.route_capture(self.vault, self.db, make_capture())
        self.assertEqual(result["status"], "review")
        self.assertGreaterEqual(result["revision"], 2)
        # Capture is processed and no longer pending.
        self.assertEqual(capture_store.pending_captures(self.db), [])
        # Managed block contains the stable itemId.
        content = self.plan_path.read_text(encoding="utf-8")
        self.assertIn("zhx-word-pooling", content)

    def test_capture_due_day_uses_the_learning_timezone_at_shanghai_midnight(self):
        with mock.patch.object(capture_store, 'datetime', wraps=datetime) as clock:
            clock.now.return_value = datetime(2026, 8, 30, 16, 30, tzinfo=timezone.utc)
            capture_store.route_capture(self.vault, self.db, make_capture())
        self.assertEqual(plan_authority.parse_review_items(self.vault)[0]['due'], '2026-08-31')

    def test_explicit_capture_deduplicates_by_item_and_ability(self) -> None:
        first = capture_store.route_capture(self.vault, self.db, make_capture("cap-1"))
        # Same captureId retry is idempotent: same revision, no new write.
        retry = capture_store.route_capture(self.vault, self.db, make_capture("cap-1"))
        self.assertEqual(retry["revision"], first["revision"])
        # A new negative evidence (new captureId, same item+ability) strengthens
        # the entry: revision bumps, entry not duplicated (spec §4).
        second = capture_store.route_capture(self.vault, self.db, make_capture("cap-5"))
        self.assertGreater(second["revision"], first["revision"])
        content = self.plan_path.read_text(encoding="utf-8")
        self.assertEqual(content.count("zhx-word-pooling"), 1)

    def test_speculative_capture_stays_in_candidates(self) -> None:
        result = capture_store.route_capture(self.vault, self.db, make_capture("cap-2", "speculative"))
        self.assertEqual(result["status"], "candidate")
        self.assertIsNone(result["revision"])
        # Plan managed block is untouched.
        self.assertNotIn("zhx-word-pooling", self.plan_path.read_text(encoding="utf-8"))
        # Capture stays pending and a candidate JSON lands in sources/pending.
        self.assertEqual(len(capture_store.pending_captures(self.db)), 1)
        pending = self.vault / "sources/pending/cap-2.json"
        self.assertTrue(pending.exists())
        self.assertEqual(pending.read_text(encoding="utf-8").count("cap-2"), 1)

    def test_missing_state_ref_is_unmapped_not_fabricated(self) -> None:
        result = capture_store.route_capture(self.vault, self.db, make_capture("cap-3", "explicit", with_state=False))
        self.assertEqual(result["status"], "unmapped")
        self.assertNotIn("zhx-word-pooling", self.plan_path.read_text(encoding="utf-8"))
        # Still pending for later mapping, no formal state written.
        self.assertEqual(len(capture_store.pending_captures(self.db)), 1)

    def test_route_capture_rejects_invalid_evidence(self) -> None:
        with self.assertRaisesRegex(ValueError, "evidence"):
            capture_store.route_capture(self.vault, self.db, make_capture("cap-4", "maybe"))


if __name__ == "__main__":
    unittest.main()
