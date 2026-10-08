import contextlib
import importlib
import io
import tempfile
import unittest
from pathlib import Path
import test_index_gateway as fixtures


class GatewayCliTests(unittest.TestCase):
    def test_init_and_new_subject_need_no_program_changes_or_restart(self):
        try:
            cli=importlib.import_module('gateway_cli')
        except ModuleNotFoundError:
            self.fail('Gateway onboarding CLI is missing')
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()):
            vault=Path(root)
            self.assertEqual(cli.main(['--vault',root,'init']),0)
            self.assertEqual(cli.main(['--vault',root,'add-subject','--id','geology','--name','地质学','--domain','geology','--plugin','quiz','--root','01 学习/地质学']),0)
            builder=fixtures.IndexGatewayTests()
            builder.vault=vault
            builder.quiz('01 学习/地质学')
            self.assertEqual(cli.main(['--vault',root,'refresh']),0)
            self.assertEqual(cli.main(['--vault',root,'validate']),0)
            catalog=fixtures.gateway.load_gateway(vault)
            self.assertEqual(catalog['subjects'][0]['items'][0]['itemId'],'geology:lesson-a:q1')
            state=vault/'01 学习/地质学/知学练习/学习状态.md'
            self.assertTrue(state.exists())
            self.assertNotIn('mastered',state.read_text(encoding='utf-8'))
            before=state.read_bytes()
            self.assertEqual(cli.main(['--vault',root,'add-subject','--id','geology','--name','Other','--plugin','quiz','--root','01 学习/地质学']),2)
            self.assertEqual(state.read_bytes(),before)

    def test_unknown_protocol_validation_fails_without_legacy_scan(self):
        try:
            cli=importlib.import_module('gateway_cli')
        except ModuleNotFoundError:
            self.fail('Gateway onboarding CLI is missing')
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['--vault',root,'init']),0)
            path=Path(root)/fixtures.gateway.GATEWAY_ROOT/'index.md'
            path.write_text('---\ntype: zhixue-gateway\nschema_version: 999\n---\n',encoding='utf-8')
            self.assertEqual(cli.main(['--vault',root,'validate']),2)
