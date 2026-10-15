import tempfile
import json
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

    def test_opaque_ids_have_stable_distinct_filenames(self):
        names = [snapshot_schema._safe_filename(value) for value in
                 ('opaque:one', 'opaque?one', '普通捕获', 'CON')]
        self.assertEqual(len(set(names)), len(names))
        for name in names:
            self.assertRegex(name, r'^capture-sha256-[a-f0-9]{64}\.json$')
        self.assertEqual(snapshot_schema._safe_filename('cap-1'), 'cap-1.json')
        self.assertEqual(snapshot_schema._safe_filename('opaque:one'), names[0])
        self.assertNotEqual(snapshot_schema._safe_filename(names[0][:-5]), names[0])

    def test_legacy_approved_filename_is_reused_without_duplicate(self):
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        snapshot = snapshot_schema.build_snapshot({
            'captureId': '课程-1', 'itemId': 'i', 'domain': 'course',
            'sourceNote': 'note.md', 'stateRef': 'state.md', 'abilityId': 'a',
            'contentFingerprint': 'old-fingerprint', 'pluginType': 'quiz', 'planRevision': 0,
        })
        path = dirs['approved'] / '1.json'
        path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(snapshot_schema.write_approved_snapshot(self.vault, snapshot), path)
        self.assertEqual(list(dirs['approved'].iterdir()), [path])
        self.assertEqual(snapshot_schema.approved_snapshots(self.vault), [snapshot])
        revised = {**snapshot, 'summary': 'updated synthetic material'}
        self.assertEqual(snapshot_schema.write_approved_snapshot(self.vault, revised), path)
        self.assertEqual(snapshot_schema.approved_snapshots(self.vault), [revised])

    def test_legacy_cleaning_collision_preserves_the_other_capture(self):
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        snapshot = snapshot_schema.build_snapshot({
            'captureId': '课程-1', 'itemId': 'i', 'domain': 'course',
            'sourceNote': 'note.md', 'stateRef': 'state.md', 'abilityId': 'a',
            'contentFingerprint': 'old-fingerprint', 'pluginType': 'quiz', 'planRevision': 0,
        })
        legacy = dirs['approved'] / '1.json'
        original = json.dumps(snapshot).encode('utf-8')
        legacy.write_bytes(original)
        other = {**snapshot, 'captureId': '讲义-1', 'itemId': 'other'}
        target = snapshot_schema.write_approved_snapshot(self.vault, other)
        self.assertNotEqual(target, legacy)
        self.assertEqual(legacy.read_bytes(), original)
        self.assertEqual(snapshot_schema.read_approved_snapshot(self.vault, target.name), other)

    def test_long_opaque_identity_leaves_room_for_the_atomic_filename(self):
        capture_id = 'ordinary-' + 'x' * 171
        name = snapshot_schema._safe_filename(capture_id)
        self.assertLessEqual(len(name), 105)
        self.assertEqual(name, snapshot_schema._safe_filename(capture_id))

    def test_approved_reader_preserves_legacy_status_compatibility(self):
        dirs = snapshot_schema.ensure_sources_dirs(self.vault)
        template = snapshot_schema.build_snapshot({
            'captureId': 'legacy-status', 'itemId': 'i', 'domain': 'course',
            'sourceNote': 'note.md', 'stateRef': 'state.md', 'abilityId': 'a',
            'contentFingerprint': 'old-fingerprint', 'pluginType': 'quiz', 'planRevision': 0,
        })
        for status in (None, 'approved', 'pending', 'rejected'):
            name = f'status-{status}.json'
            snapshot = dict(template)
            if status is not None:
                snapshot['status'] = status
            (dirs['approved'] / name).write_text(json.dumps(snapshot), encoding='utf-8')
            if status in ('pending', 'rejected'):
                with self.assertRaisesRegex(ValueError, 'snapshot-not-approved'):
                    snapshot_schema.read_approved_snapshot(self.vault, name)
            else:
                self.assertEqual(snapshot_schema.read_approved_snapshot(self.vault, name), snapshot)
        self.assertEqual(len(snapshot_schema.approved_snapshots(self.vault)), 2)


if __name__ == "__main__":
    unittest.main()
