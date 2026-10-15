import sqlite3
import json
import tempfile
import unittest
from unittest import mock
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

    def test_capture_identifier_cannot_overwrite_a_marker_outside_authorized_vault(self):
        # Both paths belong to this test's outer TemporaryDirectory. The marker
        # represents data outside the narrower caller-authorized Vault boundary.
        vault = self.vault / 'authorized-vault'
        vault.mkdir()
        marker = self.vault / 'synthetic-private-marker.json'
        original = b'{"syntheticResource":"preserve-original"}\n'
        marker.write_bytes(original)
        capture = {**make_capture('../../../synthetic-private-marker', 'speculative'),
                   'itemId': 'synthetic-question', 'domain': 'course',
                   'sourceNote': 'synthetic-source.md', 'stateRef': 'synthetic-state.md',
                   'abilityId': 'course:synthetic-question', 'pluginType': 'quiz'}
        rejected = None
        try:
            capture_store.route_capture(vault, self.db, capture)
        except ValueError as error:
            rejected = str(error)
        self.assertEqual(marker.read_bytes(), original)
        self.assertEqual(rejected, 'invalid-captureId')
        self.assertFalse((vault / 'sources').exists())

    def test_evidence_classification(self):
        self.assertEqual(capture_store.capture_evidence(make_capture()), "explicit")
        self.assertEqual(capture_store.capture_evidence(make_capture("cap-2", "speculative")), "speculative")
        with self.assertRaisesRegex(ValueError, "evidence"):
            capture_store.capture_evidence({**make_capture(), "evidence": "maybe"})

    def test_pending_captures_exclude_processed(self):
        capture_store.store_capture(self.db, self.vault, make_capture())
        capture_store.mark_processed(self.db, "cap-1")
        self.assertEqual(capture_store.pending_captures(self.db), [])

    def test_conflicting_retry_preserves_first_row_and_candidate(self):
        first = make_capture('ordinary-fixture', 'speculative')
        capture_store.route_capture(self.vault, self.db, first)
        path = self.vault / 'sources/pending/ordinary-fixture.json'
        original = path.read_bytes()
        row = capture_store.pending_captures(self.db)[0]
        for field, value in {
            'itemId': 'other-item', 'domain': 'other-domain', 'sourceNote': 'other.md',
            'stateRef': 'other-state.md', 'abilityId': 'other-ability',
            'contentFingerprint': 'other-fingerprint', 'pluginType': 'quiz',
            'planRevision': 1, 'evidence': 'explicit', 'summary': 'other-summary',
        }.items():
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, 'capture-conflict'):
                    capture_store.route_capture(self.vault, self.db, {**first, field: value})
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(capture_store.pending_captures(self.db), [row])

    def test_equivalent_retry_normalizes_defaults_and_revision_without_rewriting(self):
        first = {'captureId': 'default-fixture', 'itemId': 'item', 'domain': '',
                 'contentFingerprint': 'legacy-fingerprint', 'evidence': 'speculative'}
        with mock.patch.object(capture_store, 'datetime', wraps=capture_store.datetime) as clock:
            clock.now.return_value = capture_store.datetime(2026, 1, 1, tzinfo=capture_store.timezone.utc)
            capture_store.route_capture(self.vault, self.db, first)
        path = self.vault / 'sources/pending/default-fixture.json'
        original = path.read_bytes()
        retry = {**first, 'sourceNote': '', 'stateRef': '', 'abilityId': '',
                 'pluginType': 'quiz', 'planRevision': '0', 'summary': None}
        with mock.patch.object(capture_store, 'datetime', wraps=capture_store.datetime) as clock:
            clock.now.return_value = capture_store.datetime(2026, 1, 2, tzinfo=capture_store.timezone.utc)
            self.assertEqual(capture_store.route_capture(self.vault, self.db, retry)['status'], 'candidate')
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(capture_store.pending_captures(self.db)[0]['planRevision'], 0)

    def test_invalid_capture_has_no_schema_or_directory_side_effects(self):
        cases = [('captureId', ''), ('captureId', 7), ('captureId', 'control\nfixture'),
                 ('captureId', 'x' * 181), ('itemId', None), ('contentFingerprint', {}),
                 ('sourceNote', []), ('summary', []), ('planRevision', True),
                 ('planRevision', 0.5), ('planRevision', -1), ('planRevision', 'invalid')]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    capture_store.route_capture(self.vault, self.db, {**make_capture(evidence='speculative'), field: value})
                self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0], 0)
                self.assertFalse((self.vault / 'sources').exists())

    def test_failed_candidate_write_preserves_receipt_for_identical_retry(self):
        import mapped_source_registry
        capture = make_capture('failed-fixture', 'speculative')
        with mock.patch.object(mapped_source_registry.os, 'replace', side_effect=OSError('synthetic-write-failure')):
            with self.assertRaises(OSError):
                capture_store.route_capture(self.vault, self.db, capture)
        stored = capture_store.pending_captures(self.db)[0]
        self.assertIsNone(stored['routeStatus'])
        self.assertIsNone(stored['processedAt'])
        with self.assertRaisesRegex(ValueError, 'capture-conflict'):
            capture_store.route_capture(self.vault, self.db, {**capture, 'contentFingerprint': 'different'})
        self.assertEqual(list((self.vault / 'sources/pending').iterdir()), [])
        self.assertEqual(capture_store.route_capture(self.vault, self.db, capture)['status'], 'candidate')
        snapshot = json.loads((self.vault / 'sources/pending/failed-fixture.json').read_bytes())
        self.assertEqual(snapshot['contentFingerprint'], stored['contentFingerprint'])

    def test_existing_candidate_conflict_is_preserved(self):
        path = self.vault / 'sources/pending/conflict-fixture.json'
        path.parent.mkdir(parents=True)
        original = b'{"unrelated": "synthetic-existing-content"}\n'
        path.write_bytes(original)
        with self.assertRaisesRegex(ValueError, 'capture-candidate-conflict'):
            capture_store.route_capture(self.vault, self.db, make_capture('conflict-fixture', 'speculative'))
        self.assertEqual(path.read_bytes(), original)
        self.assertIsNone(capture_store.pending_captures(self.db)[0]['routeStatus'])

    def test_legacy_candidate_defaults_and_timestamp_are_not_rewritten(self):
        capture = {'captureId': 'legacy-candidate', 'itemId': 'item', 'domain': 'course',
                   'contentFingerprint': 'legacy-fingerprint', 'evidence': 'speculative'}
        capture_store.store_capture(self.db, self.vault, capture)
        path = self.vault / 'sources/pending/legacy-candidate.json'
        path.parent.mkdir(parents=True)
        prior = {key: value for key, value in capture.items() if key != 'evidence'}
        prior.update(schemaVersion=1, status='pending', approvedAt='2026-01-01T00:00:00+00:00')
        original = json.dumps(prior, indent=4).encode('utf-8')
        path.write_bytes(original)
        self.assertEqual(capture_store.route_capture(self.vault, self.db, capture)['status'], 'candidate')
        self.assertEqual(path.read_bytes(), original)

    def test_legacy_unicode_candidate_retry_reuses_original_file(self):
        capture = make_capture('课程-1', 'speculative')
        stored = capture_store.store_capture(self.db, self.vault, capture)
        path = self.vault / 'sources/pending/课程-1.json'
        path.parent.mkdir(parents=True)
        snapshot = {key: capture[key] for key in capture if key not in ('evidence', 'summary')}
        snapshot.update(schemaVersion=1, status='pending', approvedAt=stored['capturedAt'])
        original = json.dumps(snapshot, ensure_ascii=False, indent=4).encode('utf-8')
        path.write_bytes(original)
        self.assertEqual(capture_store.route_capture(self.vault, self.db, capture)['status'], 'candidate')
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(path.parent.iterdir()), [path])

    def test_queued_capture_uses_first_payload_when_vault_becomes_available(self):
        capture = make_capture('queued-fixture', 'speculative')
        self.assertEqual(capture_store.route_capture(None, self.db, capture)['status'], 'queued')
        self.assertFalse((self.vault / 'sources').exists())
        with self.assertRaisesRegex(ValueError, 'capture-conflict'):
            capture_store.route_capture(self.vault, self.db, {**capture, 'summary': 'changed'})
        self.assertFalse((self.vault / 'sources').exists())
        self.assertEqual(capture_store.route_capture(self.vault, self.db, capture)['status'], 'candidate')


if __name__ == "__main__":
    unittest.main()
