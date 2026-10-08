import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))
import capture_store  # noqa: E402


def make_capture(capture_id="cap-1", evidence="explicit"):
    return {
        "captureId": capture_id, "itemId": "zhx-word-pooling", "domain": "ielts",
        "sourceNote": "P2.md", "stateRef": "L16.md", "abilityId": "pooling-layer",
        "contentFingerprint": "abc", "pluginType": "three-stage", "planRevision": 0,
        "evidence": evidence, "summary": "今天论文里的 pooling layer",
    }


class CaptureStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.db.close()
        self.temp_dir.cleanup()

    def test_store_capture_is_idempotent_by_capture_id(self):
        first = capture_store.store_capture(self.db, self.vault, make_capture())
        second = capture_store.store_capture(self.db, self.vault, make_capture())
        self.assertEqual(first["captureId"], "cap-1")
        self.assertEqual(second["captureId"], "cap-1")
        self.assertEqual(len(capture_store.pending_captures(self.db)), 1)

    def test_evidence_classification(self):
        self.assertEqual(capture_store.capture_evidence(make_capture()), "explicit")
        self.assertEqual(capture_store.capture_evidence(make_capture("cap-2", "speculative")), "speculative")
        with self.assertRaisesRegex(ValueError, "evidence"):
            capture_store.capture_evidence({**make_capture(), "evidence": "maybe"})

    def test_pending_captures_exclude_processed(self):
        capture_store.store_capture(self.db, self.vault, make_capture())
        capture_store.mark_processed(self.db, "cap-1")
        self.assertEqual(capture_store.pending_captures(self.db), [])


if __name__ == "__main__":
    unittest.main()
