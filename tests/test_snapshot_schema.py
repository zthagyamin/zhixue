import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import snapshot_schema  # noqa: E402


class SnapshotSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_build_snapshot_contains_required_fields(self) -> None:
        snapshot = snapshot_schema.build_snapshot({
            "captureId": "cap-1",
            "itemId": "zhx-word-pooling",
            "domain": "ielts",
            "sourceNote": "P2.md",
            "stateRef": "L16 学习状态.md",
            "abilityId": "pooling-layer",
            "contentFingerprint": "abc123",
            "pluginType": "three-stage",
            "planRevision": 3,
        })
        self.assertEqual(snapshot["schemaVersion"], 1)
        for key in ("captureId", "itemId", "domain", "sourceNote", "stateRef", "abilityId",
                    "contentFingerprint", "approvedAt", "pluginType", "planRevision"):
            self.assertIn(key, snapshot)

    def test_validate_snapshot_rejects_missing_capture_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "captureId"):
            snapshot_schema.validate_snapshot({"schemaVersion": 1, "itemId": "x"})

    def test_validate_snapshot_rejects_path_traversal_source_note(self) -> None:
        snapshot = {
            "schemaVersion": 1, "captureId": "c", "itemId": "i", "domain": "ielts",
            "sourceNote": "../outside.md", "stateRef": "s", "abilityId": "a",
            "contentFingerprint": "f", "approvedAt": "t", "pluginType": "quiz", "planRevision": 0,
        }
        with self.assertRaisesRegex(ValueError, "sourceNote"):
            snapshot_schema.validate_snapshot(snapshot)

    def test_ensure_sources_dirs_creates_three_subfolders(self) -> None:
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        for name in ("approved", "pending", "rejected"):
            self.assertTrue(dirs[name].is_dir())
        self.assertEqual(snapshot_schema.sources_root(self.vault).name, "sources")

    def test_write_and_read_approved_snapshot_roundtrip(self) -> None:
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        snapshot = snapshot_schema.build_snapshot({
            "captureId": "cap-1", "itemId": "zhx-word-pooling", "domain": "ielts",
            "sourceNote": "P2.md", "stateRef": "L16.md", "abilityId": "pooling-layer",
            "contentFingerprint": "abc", "pluginType": "three-stage", "planRevision": 1,
            "summary": "pooling layer 释义",
        })
        path = snapshot_schema.write_approved_snapshot(self.vault, snapshot)
        self.assertTrue(path.exists())
        loaded = snapshot_schema.read_approved_snapshot(self.vault, path.name)
        self.assertEqual(loaded["captureId"], "cap-1")
        self.assertEqual(loaded["itemId"], "zhx-word-pooling")

    def test_approved_snapshots_lists_only_valid_files(self) -> None:
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        (dirs["pending"] / "pending-1.json").write_text("{}", encoding="utf-8")
        (dirs["approved"] / "bad.json").write_text("{not json", encoding="utf-8")
        good = snapshot_schema.build_snapshot({
            "captureId": "cap-2", "itemId": "i2", "domain": "python", "sourceNote": "n.py",
            "stateRef": "s2", "abilityId": "a2", "contentFingerprint": "f2",
            "pluginType": "code", "planRevision": 2,
        })
        snapshot_schema.write_approved_snapshot(self.vault, good)
        snapshots = snapshot_schema.approved_snapshots(self.vault)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["captureId"], "cap-2")


if __name__ == "__main__":
    unittest.main()
