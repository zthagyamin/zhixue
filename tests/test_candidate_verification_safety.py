import importlib.util
import tempfile
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'scripts/verify-companion-candidate.py'
candidate = None
if path.exists():
    spec = importlib.util.spec_from_file_location('candidate_verifier', path)
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)


class CandidateVerificationSafetyTests(unittest.TestCase):
    def test_verification_requires_a_named_temporary_root_not_a_home_or_workspace(self):
        self.assertIsNotNone(candidate)
        for path in (Path.home(), Path(tempfile.gettempdir()), Path(__file__).resolve().parents[1]):
            with self.assertRaises(ValueError): candidate.safe_root(path)
        with tempfile.TemporaryDirectory(prefix='zhixue-g5-') as root:
            self.assertEqual(candidate.safe_root(Path(root)), Path(root).resolve())

    def test_normal_installs_never_start_setup_or_register_the_real_installation(self):
        self.assertIsNotNone(candidate)
        command = candidate.installer_command(Path('payload'), Path('target'), Path('backup'), 'pwsh.exe')
        for flag in ('-NoStart', '-SkipSetup', '-SkipRegistration', '-TargetPath', '-BackupBasePath'):
            self.assertIn(flag, command)
        with tempfile.TemporaryDirectory(prefix='zhixue-g5-') as root:
            payload = Path(root)
            (payload / 'setup-and-start.ps1').write_text('throw "not the approved fixture"', encoding='utf-8')
            with self.assertRaises(ValueError): candidate.installer_command(payload, payload/'target', payload/'backup', 'pwsh.exe', fault=True)

    def test_program_check_rejects_a_changed_module_even_when_version_matches(self):
        with tempfile.TemporaryDirectory(prefix='zhixue-g5-') as root:
            payload, installed = Path(root)/'payload', Path(root)/'installed'
            payload.mkdir(); installed.mkdir()
            for directory in (payload, installed):
                (directory/'version.json').write_text('{"version":"1.11.5"}', encoding='utf-8')
                (directory/'server.py').write_text('original = True', encoding='utf-8')
            self.assertEqual(len(candidate.verify_program_files(installed, payload)), 2)
            (installed/'server.py').write_text('original = False', encoding='utf-8')
            with self.assertRaises(AssertionError): candidate.verify_program_files(installed, payload)

    def test_first_resume_cannot_silently_change_configuration(self):
        before = {'databases':{'account-study.db':'core','study-loop.db':'native'},'config':'original','vault':{'core.json':'core'}}
        after = {**before,'vault':{**before['vault'],'month.md':'new'}}
        candidate.verify_resume_preserved(before, after)
        with self.assertRaises(AssertionError): candidate.verify_resume_preserved(before, {**after,'config':'changed'})
