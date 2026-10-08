import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
if importlib.util.find_spec('account_sync_local_api'):
    from account_sync_local_api import dispatch
else:
    dispatch = None

ORIGIN = 'https://study.example.test'


class FakeService:
    def __init__(self): self.calls = []; self.error = None
    def prepare(self, *args):
        if self.error: raise self.error
        self.calls.append(('prepare', args)); return {'grantId': 'grant-one', 'libraryId': 'library-a', 'tokenHash': 'a' * 64, 'label': args[-1]}
    def status(self, *args): self.calls.append(('status', args)); return {'links': []}
    def start(self, *args): self.calls.append(('start', args)); return {'status': 'running'}
    def stop(self, *args): self.calls.append(('stop', args)); return {'status': 'stopped', 'cloudRevoked': False}


class AccountSyncLocalApiTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(dispatch, 'Paired account-sync endpoint adapter must exist')
        self.service = FakeService()

    def call(self, method, action, payload=None, *, owner='a' * 64, origin=ORIGIN):
        return dispatch(self.service, method, '/v1/account-sync/' + action, owner, origin, [ORIGIN], payload)

    def test_missing_pairing_and_wrong_origin_do_not_invoke_service(self):
        self.assertEqual(self.call('POST', 'prepare', {'label': 'Computer'}, owner=None)[0], 401)
        self.assertEqual(self.call('GET', 'status', origin='https://other.example.test')[0], 403)
        self.assertEqual(self.service.calls, [])

    def test_actions_are_strict_scoped_and_stop_does_not_claim_cloud_revocation(self):
        self.assertEqual(self.call('POST', 'prepare', {'label': 'Computer'})[0], 200)
        self.assertEqual(self.call('POST', 'start', {'grantId': 'grant-one'})[0], 200)
        self.assertEqual(self.call('GET', 'status')[0], 200)
        self.assertEqual(self.call('POST', 'stop', {'grantId': 'grant-one'})[1]['cloudRevoked'], False)
        self.assertTrue(all(call[1][0] == 'a' * 64 for call in self.service.calls))
        for payload in ({'label': 'Computer', 'userId': 'other'}, {'label': 'Computer', 'apiKey': 'do-not-use'}, []):
            self.assertEqual(self.call('POST', 'prepare', payload)[0], 400)
        self.assertEqual(self.call('POST', 'unknown', {})[0], 404)

    def test_runtime_errors_do_not_echo_credentials_paths_or_raw_sql(self):
        for error in (sqlite3.OperationalError('secret C:/private/db'), RuntimeError('secret provider response')):
            self.service.error = error
            status, result = self.call('POST', 'prepare', {'label': 'Computer'})
            self.assertEqual(status, 503); self.assertNotIn('secret', str(result)); self.assertNotIn('C:/private', str(result))


if __name__ == '__main__': unittest.main()
