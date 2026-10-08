import importlib.util
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('prepare_gateway',Path(__file__).resolve().parents[1]/'scripts/prepare-learning-gateway.py')
migration=importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class GatewayMigrationTests(unittest.TestCase):
    def test_preview_preserves_source_and_old_links_without_duplicate_active_content(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root)
            vault=base/'vault'
            (vault/'subjects/biology').mkdir(parents=True)
            original=vault/'legacy.md'
            text='---\ntype: vocabulary-database\n---\n| word | meaning | context |\n|---|---|---|\n| cell | 细胞 | A cell grows. |\n'
            original.write_text(text,encoding='utf-8')
            before=original.read_bytes()
            config={'subjects':[{'id':'biology','name':'生物','domain':'biology','plugin':'three-stage','root':'subjects/biology','identity':'legacy'}], 'moves':[{'from':'legacy.md','to':'subjects/biology/words.md'}]}
            preview=base/'preview'
            result=migration.prepare(vault,preview,config)
            self.assertEqual(original.read_bytes(),before)
            self.assertEqual(result['diagnostics'],[])
            self.assertEqual(result['subjects'][0]['items'],1)
            self.assertIn('zhixue-migration-redirect',(preview/'legacy.md').read_text(encoding='utf-8'))
            self.assertEqual((preview/'subjects/biology/words.md').read_bytes(),before)
            with self.assertRaises(ValueError):
                migration.prepare(vault,preview,config)

    def test_config_cannot_write_outside_the_staging_directory(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root)
            vault=base/'vault'
            vault.mkdir()
            outside=base/'escaped.md'
            with self.assertRaises(ValueError):
                migration.prepare(vault,base/'preview',{'subjects':[],'new_notes':{'../escaped.md':'not allowed'}})
            self.assertFalse(outside.exists())

    def test_staging_inside_real_vault_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            vault=Path(root)
            with self.assertRaises(ValueError):
                migration.prepare(vault,vault/'preview',{'subjects':[]})
