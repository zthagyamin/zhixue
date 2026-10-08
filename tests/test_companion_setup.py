import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import companion_setup as setup


class CompanionSetupTests(unittest.TestCase):
    def test_fresh_install_creates_personal_learning_space_without_obsidian(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '用户 A 空格'; root.mkdir()
            (root / 'config.json').write_text(json.dumps({'port':43121,'learning_vault_root':'','allowed_origins':['https://example.test']}), encoding='utf-8')
            result = setup.initialize(root)
            config = json.loads((root/'config.local.json').read_text(encoding='utf-8'))
            workspace = Path(config['learning_vault_root'])
            self.assertTrue(workspace.is_relative_to(root))
            self.assertTrue((workspace/'_System/Integrations/Study Loop/gateway/index.md').is_file())
            self.assertEqual(result['mode'],'managed')
            self.assertEqual(workspace,root/'data'/'learning-workspace')

    def test_existing_config_is_byte_preserved_even_when_sources_temporarily_offline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); raw=b'{"port":43199,"learning_vault_root":"Z:/offline","custom":"keep"}\r\n'
            (root/'config.local.json').write_bytes(raw)
            self.assertEqual(setup.initialize(root)['mode'],'existing')
            self.assertEqual((root/'config.local.json').read_bytes(),raw)

    def test_installations_never_share_default_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots=[Path(temporary)/name for name in ['Alice','Bob']]
            for root in roots:
                root.mkdir();(root/'config.json').write_text('{"port":43121}',encoding='utf-8');setup.initialize(root)
            self.assertNotEqual(*[json.loads((root/'config.local.json').read_text())['learning_vault_root'] for root in roots])

    def test_missing_or_invalid_template_never_reports_setup_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with self.assertRaises(ValueError):setup.initialize(root)
            (root/'config.json').write_text('{"port":0}',encoding='utf-8')
            with self.assertRaises(ValueError):setup.initialize(root)
            self.assertFalse((root/'config.local.json').exists())


if __name__=='__main__':unittest.main()
