"""Protected native grade/claim HTTP boundary without server startup or models."""
import io
import json
import sqlite3
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import routes_course
from server_route_fixture import load_route_methods


class NativeCourseRouteTests(unittest.TestCase):
    def setUp(self):
        self.owner = 'a' * 64
        self.namespace = {
            'json': json, 'normalize_request_path': lambda path: path,
            'authenticate_session': lambda token: self.owner if token == 'paired' else None,
            'allowed_origin': lambda origin: origin == 'https://site.example',
            'MAX_UPLOAD_BYTES': 1500000,
        }
        self.methods = load_route_methods(self.namespace)

    def request(self, action, *, token='paired', origin='https://site.example',
                payload=None, raw=None, length=None, path=None):
        body = raw if raw is not None else json.dumps(payload if payload is not None else {}).encode()
        headers = {'X-Study-Loop-Session': token,
                   'Content-Length': str(len(body) if length is None else length)}
        if origin is not None:
            headers['Origin'] = origin
        responses = []
        request = types.SimpleNamespace(
            path=path or '/v1/course/' + action, headers=headers,
            rfile=io.BytesIO(body),
            send_json=lambda status, value: responses.append((status, value)))
        self.methods['do_POST'](request)
        self.assertEqual(len(responses), 1)
        return responses[0]

    def test_pairing_and_origin_reject_before_constructing_native_application(self):
        with mock.patch.object(routes_course, 'create_native_course_application') as factory:
            for action in ('grade', 'claim'):
                for token in ('', 'expired', 'unpaired'):
                    with self.subTest(action=action, token=token):
                        self.assertEqual(self.request(action, token=token)[0], 401)
                for origin in (None, 'null', 'https://other.example', 'http://site.example'):
                    with self.subTest(action=action, origin=origin):
                        self.assertEqual(self.request(action, origin=origin)[0], 403)
            factory.assert_not_called()

    def test_registry_uses_authenticated_owner_exact_payload_and_correct_operation(self):
        payload = {'schemaVersion': 1, 'binding': {'ownerId': 'browser-namespace'},
                   'identity': {'libraryId': 'local-vault:test'}, 'attemptId': 'attempt-1'}
        grade_receipt = {'schemaVersion': 1, 'durable': True, 'requestId': 'request-1',
                         'diagnostic': {'status': 'undetermined'}}
        claim_receipt = {'schemaVersion': 1, 'durable': True, 'status': 'accepted',
                         'eventId': 'event-1', 'claimHash': 'b' * 64}
        app = types.SimpleNamespace(grade=mock.Mock(return_value=grade_receipt),
                                    claim=mock.Mock(return_value=claim_receipt))
        with mock.patch.object(routes_course, 'create_native_course_application', return_value=app) as factory:
            with mock.patch.object(routes_course, 'create_course_source_application') as source_factory:
                self.assertEqual(self.request('grade', payload=payload), (200, grade_receipt))
                self.assertEqual(self.request('claim', payload=payload), (200, claim_receipt))
                source_factory.assert_not_called()
        app.grade.assert_called_once_with(payload)
        app.claim.assert_called_once_with(payload)
        self.assertEqual(factory.call_count, 2)
        for call in factory.call_args_list:
            self.assertEqual(call.args[1], self.owner)
            self.assertNotEqual(call.args[1], payload['binding']['ownerId'])

    def test_nearby_unregistered_paths_cannot_fall_through_grade_or_claim(self):
        paths = ('/v1/course/grade/extra', '/v1/course/claim-extra', '/v1/course/source/grade')
        with mock.patch.object(routes_course, 'create_native_course_application') as factory:
            with mock.patch.object(routes_course, 'create_course_source_application') as source_factory:
                for path in paths:
                    with self.subTest(path=path):
                        self.assertEqual(self.request('grade', path=path)[0], 404)
                source_factory.assert_not_called()
            factory.assert_not_called()

    def test_json_and_upload_validation_stop_before_factory(self):
        with mock.patch.object(routes_course, 'create_native_course_application') as factory:
            for action in ('grade', 'claim'):
                with self.subTest(action=action):
                    self.assertEqual(self.request(action, raw=b'{invalid JSON')[0], 400)
                    self.assertEqual(self.request(action, length=0)[0], 413)
                    self.assertEqual(self.request(action, length=1500001)[0], 413)
            factory.assert_not_called()

    def test_safe_conflict_validation_codes_preserve_status_for_each_operation(self):
        cases = (
            ('native-course-attempt-inflight', 409),
            ('native-course-claim-formal-binding-conflict', 409),
            ('native-course-ledger-integrity', 409),
            ('invalid-native-course-integer', 400),
            ('unknown-study-field', 400),
        )
        for action in ('grade', 'claim'):
            for code, status in cases:
                app = types.SimpleNamespace(grade=mock.Mock(side_effect=ValueError(code)),
                                            claim=mock.Mock(side_effect=ValueError(code)))
                with self.subTest(action=action, code=code), mock.patch.object(
                        routes_course, 'create_native_course_application', return_value=app):
                    self.assertEqual(self.request(action), (status, {'error': code}))

    def test_factory_and_application_errors_never_expose_paths_credentials_or_raw_sql(self):
        cases = (
            (ValueError('C:\\private\\vault.md: credential=synthetic-secret'),
             (409, {'error': 'native-course-unavailable'})),
            (OSError('C:\\private\\vault.md: permission denied'),
             (503, {'error': 'native-course-storage-unavailable'})),
            (sqlite3.OperationalError('private-db.sqlite SELECT input_json token=synthetic-secret'),
             (503, {'error': 'native-course-storage-unavailable'})),
            (RuntimeError('https://provider.example/private?key=synthetic-secret'),
             (503, {'error': 'native-course-storage-unavailable'})),
        )
        for action in ('grade', 'claim'):
            for error, expected in cases:
                for stage in ('factory', 'application'):
                    app = types.SimpleNamespace(grade=mock.Mock(side_effect=error),
                                                claim=mock.Mock(side_effect=error))
                    options = {'side_effect': error} if stage == 'factory' else {'return_value': app}
                    with self.subTest(action=action, stage=stage, error=type(error).__name__), mock.patch.object(
                            routes_course, 'create_native_course_application', **options):
                        result = self.request(action)
                        self.assertEqual(result, expected)
                        self.assertNotIn('synthetic-secret', json.dumps(result))
                        self.assertNotIn('private', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
