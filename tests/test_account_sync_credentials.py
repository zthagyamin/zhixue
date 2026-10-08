import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
if importlib.util.find_spec('account_sync_credentials'):
    import account_sync_credentials as credentials
else:
    credentials = None


class FakeKeyring:
    def __init__(self): self.values = {}; self.calls = []; self.fail = False
    def get_password(self, service, key):
        self.calls.append(('get', service, key))
        if self.fail: raise OSError('provider unavailable')
        return self.values.get((service, key))
    def set_password(self, service, key, value):
        self.calls.append(('set', service, key))
        if self.fail: raise OSError('provider unavailable')
        self.values[(service, key)] = value
    def delete_password(self, service, key):
        self.calls.append(('delete', service, key)); self.values.pop((service, key), None)


class AccountSyncCredentialTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(credentials, 'Dedicated machine authorization must exist')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'links.sqlite3'; self.keyring = FakeKeyring()
        self.links = credentials.LinkStore(self.path, self.keyring, allowed_origins=['https://study.example.test'])
        self.owner = 'a' * 64

    def prepare(self, grant_id='grant-one'):
        return self.links.prepare(self.owner, 'library-a', 'https://study.example.test', 'My computer', grant_id=grant_id)

    def test_only_hash_and_nonsecret_registration_metadata_leave_prepare(self):
        prepared = self.prepare(); secret = self.links.secret(self.owner, 'grant-one')
        self.assertEqual(set(prepared), {'grantId', 'libraryId', 'tokenHash', 'label'})
        self.assertEqual(prepared['tokenHash'], credentials.machine_token_hash(secret))
        self.assertNotIn(secret, str(prepared))
        self.assertEqual(self.prepare(), prepared)
        with closing(sqlite3.connect(self.path)) as db:
            dump = '\n'.join(db.iterdump())
        self.assertNotIn(secret, dump)
        self.assertEqual(sum(call[0] == 'set' for call in self.keyring.calls), 1)

    def test_other_account_never_reads_or_changes_link(self):
        self.prepare(); before = len(self.keyring.calls)
        with self.assertRaises(ValueError): self.links.secret('b' * 64, 'grant-one')
        with self.assertRaises(ValueError): self.links.mark_state('b' * 64, 'grant-one', 'active')
        self.assertEqual(len(self.keyring.calls), before)
        self.assertEqual(self.links.list_links('b' * 64), [])

    def test_separate_namespace_and_no_deepseek_access(self):
        self.keyring.values[('Zhixue Companion', 'deepseek-api-key-existing')] = 'keep-private'
        self.prepare()
        self.assertTrue(all(call[1] == credentials.CREDENTIAL_SERVICE for call in self.keyring.calls))
        self.assertTrue(all('deepseek' not in call[2] for call in self.keyring.calls))
        self.assertEqual(self.keyring.values[('Zhixue Companion', 'deepseek-api-key-existing')], 'keep-private')

    def test_keyring_failure_leaves_no_false_ready_metadata(self):
        self.keyring.fail = True
        with self.assertRaisesRegex(ValueError, 'credential'): self.prepare()
        self.assertEqual(self.links.list_links(self.owner), [])

    def test_failed_database_save_removes_only_newly_created_secret(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TRIGGER injected BEFORE INSERT ON account_sync_links BEGIN SELECT RAISE(ABORT,'injected'); END")
        self.keyring.values[('Other', 'old')] = 'preserve'
        with self.assertRaises(sqlite3.DatabaseError): self.prepare()
        self.assertEqual(self.keyring.values, {('Other', 'old'): 'preserve'})
        self.assertEqual(self.links.list_links(self.owner), [])

    def test_origin_is_exact_trusted_https_and_secret_never_redirectable(self):
        for origin in ('http://study.example.test', 'https://evil.example.test', 'https://study.example.test/path',
                       'https://user:pass@study.example.test', 'https://study.example.test?x=1', 'https://study.example.test#x'):
            with self.assertRaises(ValueError): self.links.prepare(self.owner, 'library-a', origin, 'Computer')
        self.assertEqual(self.keyring.calls, [])

    def test_restart_resume_binding_and_changed_grant_conflict(self):
        self.prepare()
        restarted = credentials.LinkStore(self.path, self.keyring, allowed_origins=['https://study.example.test'])
        self.assertEqual(restarted.secret(self.owner, 'grant-one'), self.links.secret(self.owner, 'grant-one'))
        with self.assertRaises(ValueError): self.links.prepare(self.owner, 'library-b', 'https://study.example.test', 'Computer', grant_id='grant-one')
        self.links.mark_state(self.owner, 'grant-one', 'active')
        self.assertEqual(self.links.list_links(self.owner)[0]['state'], 'active')
        self.links.mark_state(self.owner, 'grant-one', 'paused')
        self.assertEqual(self.links.list_links(self.owner)[0]['state'], 'paused')
        self.assertTrue(self.links.secret(self.owner, 'grant-one'))

    def test_changed_keyring_secret_cannot_use_another_authorization(self):
        self.prepare()
        slot = next(iter(self.keyring.values)); self.keyring.values[slot] = 'x' * 43
        with self.assertRaisesRegex(ValueError, 'binding'): self.links.secret(self.owner, 'grant-one')


if __name__ == '__main__': unittest.main()
