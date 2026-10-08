"""Actual HTTP boundary/registry with isolated services and no installation startup."""
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import routes_course
from server_route_fixture import load_route_methods


class CourseSourceRouteTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.namespace = {
            'json': json, 'normalize_request_path': lambda path: path,
            'authenticate_session': lambda token: 'a' * 64 if token == 'paired' else None,
            'allowed_origin': lambda origin: origin == 'https://site.example',
            'MAX_UPLOAD_BYTES': 1500000,
        }
        self.methods = load_route_methods(self.namespace)

    def request(self, action, *, paired=True, origin='https://site.example', payload=None):
        raw = json.dumps(payload or {}).encode()
        responses = []
        request = types.SimpleNamespace(
            path='/v1/course/source/' + action,
            headers={'Origin': origin, 'X-Study-Loop-Session': 'paired' if paired else '',
                     'Content-Length': str(len(raw))},
            rfile=io.BytesIO(raw), send_json=lambda status, value: responses.append((status, value)))
        self.methods['do_POST'](request)
        return responses[-1]

    def test_unpaired_and_wrong_origin_never_construct_source_adapter(self):
        with mock.patch.object(routes_course, 'create_course_source_application') as factory:
            for action in ('capture', 'read'):
                self.assertEqual(self.request(action, paired=False)[0], 401)
                self.assertEqual(self.request(action, origin='https://other.example')[0], 403)
            factory.assert_not_called()

    def test_registry_passes_authenticated_owner_and_exact_request(self):
        payload = {'schemaVersion': 1, 'identity': {'libraryId': 'local-vault:test'}}
        app = types.SimpleNamespace(execute=lambda action, value: self.calls.append((action, value)) or
                                    {'schemaVersion': 1, 'durable': True, 'capture': {}})
        with mock.patch.object(routes_course, 'create_course_source_application', return_value=app) as factory:
            for action in ('capture', 'read'):
                self.assertEqual(self.request(action, payload=payload)[0], 200)
            self.assertEqual(self.calls, [('capture', payload), ('read', payload)])
            self.assertTrue(all(call.args[1] == 'a' * 64 for call in factory.call_args_list))
            self.assertEqual(self.request('grade', payload=payload)[0], 404)
            self.assertEqual(factory.call_count, 2)

    def test_source_and_storage_failures_never_expose_private_paths(self):
        for error, expected in (
                (ValueError('native-course-source-changed'), (409, {'error': 'native-course-source-changed'})),
                (ValueError('invalid-course-source-request'), (400, {'error': 'invalid-course-source-request'})),
                (ValueError('private/file.md: invalid'), (409, {'error': 'course-source-unavailable'})),
                (OSError('private/file.md: permission denied'), (503, {'error': 'course-source-storage-unavailable'}))):
            with self.subTest(error=type(error).__name__), mock.patch.object(
                    routes_course, 'create_course_source_application', side_effect=error):
                self.assertEqual(self.request('capture'), expected)


if __name__ == '__main__':
    unittest.main()
