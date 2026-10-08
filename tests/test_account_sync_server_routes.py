"""Execute only Handler AST methods; never import server/config at test load."""
import ast
import io
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_local_api
from server_route_fixture import load_route_methods
from test_account_sync_local_api import FakeService, ORIGIN


class AccountSyncServerRouteTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService(); self.factory_calls = 0
        def factory(): self.factory_calls += 1; return self.service
        namespace = {'json': json, 'normalize_request_path': lambda path: path,
            'authenticate_session': lambda token: 'a' * 64 if token == 'paired-test' else None,
            'allowed_origin': lambda origin: origin == ORIGIN, 'MAX_UPLOAD_BYTES': 1500000,
            'account_sync_local_api': account_sync_local_api, 'get_account_sync_service': factory, 'CONFIG': {'allowed_origins': [ORIGIN]}}
        self.methods = load_route_methods(namespace)

    def request(self, method, action, *, paired=True, origin=ORIGIN, payload=None):
        raw = json.dumps(payload).encode() if payload is not None else b''
        request = types.SimpleNamespace(path='/v1/account-sync/' + action,
            headers={'Origin': origin, 'X-Study-Loop-Session': 'paired-test' if paired else '', 'Content-Length': str(len(raw))}, rfile=io.BytesIO(raw))
        responses = []; request.send_json = lambda status, body: responses.append((status, body))
        self.methods['do_' + method](request)
        return responses[-1]

    def test_server_routes_require_existing_pairing_and_origin(self):
        self.assertEqual(self.request('POST', 'prepare', payload={'label': 'Computer'}, paired=False)[0], 401)
        self.assertEqual(self.request('GET', 'status', origin='https://other.example.test')[0], 403)
        self.assertEqual(self.factory_calls, 0)

    def test_all_four_routes_reach_new_adapter_without_touching_old_handlers(self):
        self.assertEqual(self.request('POST', 'prepare', payload={'label': 'Computer'})[0], 200)
        self.assertEqual(self.request('POST', 'start', payload={'grantId': 'grant-one'})[0], 200)
        self.assertEqual(self.request('GET', 'status')[0], 200)
        self.assertEqual(self.request('POST', 'stop', payload={'grantId': 'grant-one'})[1]['cloudRevoked'], False)
        self.assertEqual([call[0] for call in self.service.calls], ['prepare', 'start', 'status', 'stop'])


if __name__ == '__main__': unittest.main()
