"""Actual mapping entry point, isolated owner/Vault and preview receipts."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import server
import vault_topology as topology
import companion_setup
from infrastructure.mapping_adapter import mapping_request, PREVIEW_TTL_SECONDS
from application.mapping import MappingApplication, MappingPorts


class MappingContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.a = self.base / 'A'; self.b = self.base / 'B'
        for root in (self.a, self.b):
            root.mkdir(); (root / 'lesson.md').write_text('## Why\nBecause', encoding='utf-8')
        self.current = self.a
        self.generation = 0
        self.owner = 'owner'
        self.database = self.base / 'vault-mappings.db'
        self.rule = dict(pathGlob='*.md', subjectId='mapped:concepts', subjectLabel='Concepts', contentKind='quiz', splitMode='heading', headingLevel=2)
        for name, value in (
            ('LOCAL_DATABASE_PATH', self.base / 'study.db'),
            ('source_path', lambda _key: self.current),
            ('installation_owner_hash', lambda: self.owner),
            ('CONFIG', {'workspace_generation': 0}),
        ):
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(server, 'effective_gateway', return_value={'mappingDiagnostics': []})
        self.gateway = p.start(); self.addCleanup(p.stop)

    def preview(self):
        inspection = server.vault_mapping_request('owner')
        return server.vault_mapping_request('owner', dict(action='preview', schemaVersion=2, contextId=inspection.get('contextId'), rules=[self.rule]))

    def confirm(self, preview, **extra):
        return server.vault_mapping_request('owner', dict(action='confirm', schemaVersion=2, contextId=preview.get('contextId'), previewId=preview.get('previewId'), revision=preview['revision'], rules=[self.rule], **extra))

    def test_old_preview_cannot_write_new_vault_with_same_revision(self):
        preview = self.preview(); self.current = self.b
        with self.assertRaisesRegex(ValueError, 'mapping-context-changed'):
            self.confirm(preview)
        self.assertEqual(topology.load(self.database, self.a, 'owner')['revision'], 0)
        self.assertEqual(topology.load(self.database, self.b, 'owner')['revision'], 0)
        self.gateway.assert_not_called()

    def test_legacy_confirmation_needs_repreview_without_write(self):
        with self.assertRaisesRegex(ValueError, 'mapping-preview-required'):
            server.vault_mapping_request('owner', dict(action='confirm', revision=0, rules=[self.rule]))
        self.gateway.assert_not_called()

    def test_duplicate_confirmation_reuses_atomic_receipt(self):
        preview = self.preview(); first = self.confirm(preview); second = self.confirm(preview)
        self.assertEqual(first, second)
        self.assertEqual(first['revision'], 1)
        self.assertEqual(topology.load(self.database, self.a, 'owner')['revision'], 1)

    def test_preview_is_invalid_after_source_edit(self):
        preview = self.preview(); (self.a / 'lesson.md').write_text('## Why\nChanged', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'mapping-source-changed'):
            self.confirm(preview)
        self.gateway.assert_not_called()

    def test_rule_edit_cannot_reuse_preview(self):
        preview = self.preview(); self.rule = {**self.rule, 'subjectLabel': 'Changed'}
        with self.assertRaisesRegex(ValueError, 'mapping-preview-mismatch'):
            self.confirm(preview)
        self.gateway.assert_not_called()

    def test_a_b_a_setup_generation_invalidates_old_preview(self):
        preview = self.preview(); server.CONFIG['workspace_generation'] = 2
        with self.assertRaisesRegex(ValueError, 'mapping-context-changed'):
            self.confirm(preview)
        self.gateway.assert_not_called()

    def test_receipt_cannot_be_used_by_changed_owner(self):
        preview = self.preview(); self.owner = 'other'
        with self.assertRaisesRegex(ValueError, 'mapping-owner-required'):
            self.confirm(preview)
        self.gateway.assert_not_called()

    def test_applied_receipt_does_not_overwrite_newer_mapping(self):
        preview = self.preview(); self.confirm(preview)
        topology.save(self.database, self.a, 'owner', [], 1)
        with self.assertRaisesRegex(ValueError, 'stale-mapping'):
            self.confirm(preview)
        self.assertEqual(topology.load(self.database, self.a, 'owner')['rules'], [])

    def test_actual_workspace_switch_back_advances_generation(self):
        profile = self.base / 'profile'; profile.mkdir()
        (profile / 'config.local.json').write_text(json.dumps(dict(learning_vault_root=str(self.a))), encoding='utf-8')
        preview = self.preview()
        for root in (self.b, self.a):
            _, revision = companion_setup.settings(profile)
            updated = companion_setup.configure_workspace(profile, dict(expectedRevision=revision, mode='existing', path=str(root), confirmed=True), has_history=lambda: False)
            self.current = root; server.CONFIG.update(updated)
        self.assertEqual(server.CONFIG['workspace_generation'], 2)
        with self.assertRaisesRegex(ValueError, 'mapping-context-changed'):
            self.confirm(preview)
        self.gateway.assert_not_called()

    def test_expired_preview_requires_repreview(self):
        context = server.vault_mapping_request('owner')['contextId']
        preview = mapping_request(server, 'owner', dict(action='preview', schemaVersion=2, contextId=context, rules=[self.rule]), now=lambda: 1000)
        body = dict(action='confirm', schemaVersion=2, contextId=context, previewId=preview['previewId'], revision=0, rules=[self.rule])
        with self.assertRaisesRegex(ValueError, 'mapping-preview-expired'):
            mapping_request(server, 'owner', body, now=lambda: 1001 + PREVIEW_TTL_SECONDS)
        self.gateway.assert_not_called()

    def test_mapping_and_receipt_roll_back_together_on_storage_failure(self):
        preview = self.preview(); original = topology.save_in_transaction
        def failed(*args):
            original(*args)
            raise OSError('synthetic storage failure')
        with patch.object(topology, 'save_in_transaction', failed):
            with self.assertRaisesRegex(OSError, 'synthetic storage failure'):
                self.confirm(preview)
        self.assertEqual(topology.load(self.database, self.a, 'owner')['revision'], 0)
        self.gateway.assert_not_called()
        self.assertEqual(self.confirm(preview)['revision'], 1)

    def test_registration_failure_keeps_receipt_retryable_without_second_revision(self):
        preview = self.preview(); self.gateway.side_effect = OSError('synthetic registration failure')
        with self.assertRaises(OSError):
            self.confirm(preview)
        self.assertEqual(topology.load(self.database, self.a, 'owner')['revision'], 1)
        self.gateway.side_effect = None
        self.assertEqual(self.confirm(preview)['revision'], 1)

    def test_shared_v2_fixture_application_contract_and_errors(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/vault-mapping-context-v2.json').read_text(encoding='utf-8'))
        calls = []
        def preview(owner, context, rules):
            calls.append(('preview', owner, context, rules))
            return dict(previewId=fixture['previewId'], revision=0, itemCount=1, items=[])
        def confirm(owner, context, identity, rules, revision):
            calls.append(('confirm', owner, context, identity, rules, revision))
            return dict(revision=1, rules=rules)
        app = MappingApplication(MappingPorts(lambda _owner: fixture['contextId'], lambda _owner: dict(revision=0, rules=[]), topology.validate, preview, confirm))
        result = app.request('owner', fixture['previewRequest'])
        self.assertEqual(result['previewId'], fixture['previewId'])
        self.assertEqual(app.request('owner', fixture['confirmRequest'])['revision'], 1)
        self.assertEqual(calls[-1], ('confirm', 'owner', fixture['contextId'], fixture['previewId'], fixture['rules'], 0))
        for case in fixture['errors']:
            with self.subTest(case['name']), self.assertRaisesRegex(ValueError, case['message']):
                app.request('owner', case['payload'])
        self.assertEqual(len(calls), 2)

    def test_edit_after_commit_cannot_register_unpreviewed_source(self):
        preview = self.preview()
        import mapped_source_registry
        def changed(root, *, owner, mapping_source_hash):
            (root / 'lesson.md').write_text('## Unexpected\nChanged after metadata commit', encoding='utf-8')
            return mapped_source_registry.load_catalog(root, self.database, owner, expected_source_hash=mapping_source_hash)
        self.gateway.side_effect = changed
        result = self.confirm(preview)
        self.assertTrue(any(row['code'] == 'mapping-source-changed' for row in result['diagnostics']))
        self.assertFalse(list(self.a.rglob('content.md')))

    def test_unreadable_matched_source_preserves_readable_preview(self):
        unreadable = self.a / 'unreadable.md'; unreadable.write_text('## Hidden\nUnknown', encoding='utf-8')
        original_bytes, original_text = Path.read_bytes, Path.read_text
        def read_bytes(path):
            if path == unreadable: raise PermissionError('synthetic unreadable')
            return original_bytes(path)
        def read_text(path, *args, **kwargs):
            if path == unreadable: raise PermissionError('synthetic unreadable')
            return original_text(path, *args, **kwargs)
        with patch.object(Path, 'read_bytes', read_bytes), patch.object(Path, 'read_text', read_text):
            preview = self.preview()
            self.assertEqual(preview['itemCount'], 1)
            self.assertTrue(any(row['code'] == 'mapping-unreadable-file' for row in preview['diagnostics']))
            self.assertEqual(self.confirm(preview)['revision'], 1)


if __name__ == '__main__':
    unittest.main()
