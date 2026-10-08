"""Two independent HTTP sessions share approved plans and subject-local evidence."""
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import test_gateway_server as fixtures
import test_task_events
import task_plan_schema

server = fixtures.server


class TaskPlanIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GatewayServerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_two_clients_recover_plan_and_task_evidence_without_changing_source_or_formal_state(self):
        original = self.fixture.source.read_bytes()
        server.CONFIG['allowed_origins'] = ['http://127.0.0.1:3080', 'http://127.0.0.1:3081']
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        def request(headers, path, data=None):
            req = urllib.request.Request(base + path, headers=headers, data=None if data is None else json.dumps(data).encode())
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read())
        try:
            clients = []
            for origin in server.CONFIG['allowed_origins']:
                headers = {'Origin': origin, 'Content-Type': 'application/json'}
                headers['X-Study-Loop-Session'] = request(headers, '/v1/pair', {'code': server.PAIRING_CODE, 'userId': 'two-client-test'})['sessionToken']
                clients.append(headers)
            first, second = clients
            catalog = request(first, '/v1/plan/context')['catalog']
            subject = catalog['subjects'][0]
            task = {'taskId': 'manual:integration', 'subjectId': subject['subjectId'], 'title': 'Read fixture note',
                    'sourceHash': catalog['sourceHash'], 'completionRule': 'self-report', 'action': {'kind': 'manual'},
                    'category': 'subject', 'origin': 'manual', 'required': False, 'unitIds': [], 'quantity': 2}
            candidate = {'schemaVersion': 2, 'day': '2026-08-31', 'sourceHash': catalog['sourceHash'], 'inputHash': 'a' * 64,
                         'draftVersion': 1, 'tasks': [task], 'manual': {'lockedTaskIds': [task['taskId']], 'excludedUnitIds': []},
                         'vocabulary': {'target': 20, 'assignedLexemeKeys': []}}
            candidate['planHash'] = task_plan_schema.hash_task_plan(candidate)
            self.assertEqual(request(first, '/v1/plan/apply', {'candidate': candidate, 'expectedRevision': 0})['revision']['after'], candidate)
            self.assertEqual(request(second, '/v1/plan/current')['candidate'], candidate)
            event = test_task_events.sealed(subjectId=subject['subjectId'], taskId=task['taskId'], unitIds=[])
            self.assertEqual(request(first, '/v1/tasks/events', {'event': event})['status'], 'accepted')
            self.assertEqual(request(second, '/v1/tasks/events', {'event': event})['status'], 'duplicate')
            self.assertEqual(request(second, '/v1/tasks/events')['events'], [event])
            self.assertEqual(request(second, '/v1/study-data')['gateway']['progressEvents'], [])
            self.assertEqual(self.fixture.source.read_bytes(), original)
            self.assertNotIn('mastered', (self.fixture.vault / self.fixture.root / 'state.md').read_text(encoding='utf-8'))
            with self.assertRaises(urllib.error.HTTPError) as conflict:
                request(second, '/v1/plan/apply', {'candidate': candidate, 'expectedRevision': 0})
            self.assertEqual(conflict.exception.code, 409)
            self.assertEqual(request(first, '/v1/plan/current')['candidate'], candidate)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
