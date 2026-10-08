import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
SPEC = importlib.util.find_spec('vault_identity')
if SPEC:
    from vault_identity import local_vault_library_id


class VaultIdentityTests(unittest.TestCase):
    def test_resolved_root_identity_is_stable_and_does_not_expose_a_path(self):
        self.assertIsNotNone(SPEC, 'Stable local library identity must exist')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'a').mkdir()
            (root / 'b').mkdir()
            first = local_vault_library_id(root / 'a')
            self.assertRegex(first, r'^local-vault:[a-f0-9]{64}$')
            self.assertEqual(first, local_vault_library_id(root / 'a' / '..' / 'a'))
            self.assertNotEqual(first, local_vault_library_id(root / 'b'))
            self.assertIsNone(local_vault_library_id(root / 'missing'))


if __name__ == '__main__':
    unittest.main()
