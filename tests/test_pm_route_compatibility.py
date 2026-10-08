"""Exercise the HTTP boundary with a temporary installation and synthetic data."""
import contextlib
import io
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import test_companion as fixtures

server = fixtures.server
ORIGIN = 'https://pm-route-fixture.example'


class RouteCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompanionSyncTests()
        self.fixture.setUp()
        self.original_state = server.STATE
        server.CONFIG['allowed_origins'] = [ORIGIN]
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.worker.start()
        self.base = f'http://127.0.0.1:{self.httpd.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.session = ''
        with contextlib.redirect_stdout(io.StringIO()):
            status, _, paired = self.request('POST', '/v1/pair/', {'code': 'A1B2C3', 'userId': 'pm-synthetic-user'})
        self.assertEqual(status, 200)
        self.session = paired['sessionToken']

    def tearDown(self):
        self.httpd.shutdown()
        self.worker.join(3)
        self.httpd.server_close()
        server.STATE = self.original_state
        self.fixture.tearDown()

    def request(self, method, path, payload=None, *, origin=ORIGIN, session=None, raw=None):
        data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, method=method, data=data, headers={
            'Origin': origin, 'Content-Type': 'application/json',
            'X-Study-Loop-Session': self.session if session is None else session,
        })
        try:
            response = self.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            return response.status, response.headers, json.loads(body) if body else None

    def test_paths_preflight_and_errors_keep_wire_contract(self):
        status, headers, health = self.request('GET', '/v1//health/?fixture=1', session='')
        self.assertEqual(status, 200)
        self.assertTrue(health['pairingRequired'])
        self.assertIn('paper-library-v1', health['capabilities'])
        self.assertIn('practice-budget-v1', health['capabilities'])
        self.assertIn('native-course-v1', health['capabilities'])
        self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
        status, headers, _ = self.request('OPTIONS', '/v1/activity')
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS')
        self.assertEqual(self.request('GET', '/v1/practice', session='bad')[0], 401)
        self.assertEqual(self.request('POST', '/v1/activity', {}, origin='https://other.example')[0], 403)
        self.assertEqual(self.request('POST', '/v1/activity', raw=b'')[0], 413)
        self.assertEqual(self.request('POST', '/v1/activity', raw=b'{')[0], 400)
        self.assertEqual(self.request('GET', '/v1/not-a-route')[0], 404)
        self.assertEqual(self.request('POST', '/v1/not-a-route', {})[0], 404)

    def test_refresh_reads_state_replaced_during_request(self):
        server.STATE = {'status': 'old', 'marker': 'before'}
        with mock.patch.object(server, 'indexed_study_payload', return_value=None), \
                mock.patch.object(server, 'safe_refresh', side_effect=lambda: server.set_state({'status': 'ready', 'marker': 'after'})), \
                mock.patch.object(server, 'merge_source_area', side_effect=lambda payload, *_: payload), \
                mock.patch.object(server, 'normalize_question_subjects', side_effect=lambda payload: payload), \
                mock.patch.object(server, 'with_connections', side_effect=lambda payload: payload):
            status, _, result = self.request('POST', '/v1/refresh', {})
        self.assertEqual(status, 200)
        self.assertEqual(result['marker'], 'after')

    def test_route_failure_preserves_status_and_next_request(self):
        with mock.patch.object(server, 'get_hint_deepseek', side_effect=RuntimeError('synthetic-provider-unavailable')):
            status, _, result = self.request('POST', '/v1/hint', {'question': {}, 'wrongAnswer': ''})
        self.assertEqual((status, result), (500, {'message': 'synthetic-provider-unavailable'}))
        self.assertEqual(self.request('GET', '/v1/health')[0], 200)
        with mock.patch.object(server, 'vault_mapping_request', side_effect=ValueError('stale-mapping')):
            self.assertEqual(self.request('POST', '/v1/vault-mapping', {})[0], 409)
