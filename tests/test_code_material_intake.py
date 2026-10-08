"""Real source catalog regression; isolated fixture vaults never touch user notes."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_export
import account_sync_schema
from learning_support import has_executable_code_material
from application.generated_content import validate_cards
import test_index_gateway as gateway_fixtures


class CodeMaterialIntakeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = gateway_fixtures.IndexGatewayTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        contracts = json.loads((Path(__file__).parent / 'fixtures/stage3-code-support-contract.json').read_text(encoding='utf-8'))
        self.support = next(row['input'] for row in contracts if row['valid'])

    def source(self, support, script=''):
        root = self.fixture.subject('code', 'code')
        return self.fixture.write(root + '/code.md',
            '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: code\nstatus: ready\n---\n'
            '| ID | 题干 | 初始代码 | 测试代码 | 学习配置 |\n|---|---|---|---|---|\n'
            '| one | Implement add(a,b). | def add(a,b):\\n    pass | ' + script + ' | ' +
            (json.dumps(support) if support is not None else '') + ' |\n')

    def test_structured_only_markdown_capture_exports_bound_code_with_unchanged_source(self):
        source = self.source(self.support)
        original = source.read_bytes()
        catalog, identities = account_sync_export.capture_catalog(self.fixture.vault)
        bundle, bindings = account_sync_export.export_catalog(catalog, identities, 'library-code', 'snapshot-code', 1, '2026-10-08T00:00:00.000Z')
        item = bundle['items'][0]
        self.assertEqual(item['practice']['questionType'], 'code')
        self.assertEqual(item['practice']['testCode'], '')
        self.assertTrue(has_executable_code_material({**item['practice'], 'learningSupport': item['learningSupport']}))
        self.assertIn(item['itemKey'], bindings)
        self.assertEqual(account_sync_schema.validate_bundle(bundle), bundle)
        self.assertEqual(source.read_bytes(), original)
        second, _ = account_sync_export.export_catalog(catalog, identities, 'library-code', 'snapshot-code', 1, '2026-10-08T00:00:00.000Z')
        self.assertEqual(second, bundle)

    def test_malformed_support_cannot_hide_behind_a_legacy_script(self):
        self.source({**self.support, 'cases': []}, 'assert True')
        with self.assertRaises(ValueError):
            account_sync_export.capture_catalog(self.fixture.vault)

    def test_legacy_missing_script_still_rejects_capture(self):
        self.source(None)
        with self.assertRaises(ValueError):
            account_sync_export.capture_catalog(self.fixture.vault)

    def test_generated_material_uses_injected_strict_gate_and_preserves_support(self):
        material = {'id': 'one', 'prompt': 'Implement add.', 'initialCode': 'def add(a,b): pass', 'learningSupport': self.support}
        payload = {'subjects': [{'id': 'code', 'pluginType': 'code', 'items': [material]}]}
        result = validate_cards(payload, 'Synthetic', 'Synthetic', seed={}, stamp=lambda fmt: '2026-10-08', code_material_available=has_executable_code_material)
        generated = result['subjects'][0]['items'][0]
        self.assertEqual(generated['learningSupport'], self.support)
        generated['learningSupport']['cases'][0]['args'].append(99)
        self.assertEqual(material['learningSupport']['cases'][0]['args'], [1, 2])

    def test_real_server_normalization_wrapper_supplies_strict_code_port(self):
        import server
        material = {'id': 'one', 'prompt': 'Implement add.', 'initialCode': 'def add(a,b): pass', 'learningSupport': self.support}
        payload = {'subjects': [{'id': 'code', 'pluginType': 'code', 'items': [material]}]}
        result = server.validate_cards(payload, 'Synthetic', 'Synthetic')
        self.assertEqual(result['subjects'][0]['items'][0]['learningSupport'], self.support)
        material['testCode'] = 'assert True'
        material['learningSupport'] = {**self.support, 'cases': []}
        with self.assertRaises(ValueError):
            server.validate_cards(payload, 'Synthetic', 'Synthetic')


if __name__ == '__main__':
    unittest.main()
