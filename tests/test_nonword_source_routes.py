"""Real HTTP registration and protected temporary-answer envelope."""
import copy
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import routes_nonword_source
import test_native_course_routes as fixtures


class NonwordSourceRouteTests(unittest.TestCase):
    def setUp(self):
        self.transport = fixtures.NativeCourseRouteTests()
        self.transport.setUp()

    def request(self, action='capture', body=None, **options):
        return self.transport.request('unused', path='/v1/nonword/source',
            payload={'schemaVersion': 1, 'action': action, 'request': body or {}}, **options)

    def test_origin_and_pairing_fail_before_service_construction(self):
        with mock.patch.object(routes_nonword_source, 'create_source_admission') as factory:
            for token in ('', 'expired', 'unpaired'):
                self.assertEqual(self.request(token=token)[0], 401)
            for origin in (None, 'null', 'https://other.example'):
                self.assertEqual(self.request(origin=origin)[0], 403)
            factory.assert_not_called()

    def test_authenticated_owner_cannot_be_selected_from_body(self):
        store = types.SimpleNamespace(capture=mock.Mock(return_value={'status': 'pending', 'durable': True}))
        body = {'ownerId': 'caller-owner', 'libraryId': 'caller-library'}
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store) as factory:
            self.assertEqual(self.request(body=body)[0], 200)
        self.assertEqual(factory.call_args.args[1], self.transport.owner)
        store.capture.assert_called_once_with(body)

    def test_read_returns_saved_answer_without_private_route(self):
        attempt = {'submission': {'answer': '原答案\noriginal'}, 'binding': {}, 'sourceBinding': None,
                   'evaluation': {'status': 'pending'}, 'receipt': {'durable': True},
                   'capture': {'descriptor': {'route': {'stateRef': 'PRIVATE/route.md'}}}}
        store = types.SimpleNamespace(read_attempt=mock.Mock(return_value=copy.deepcopy(attempt)))
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store):
            status, body = self.request('read', {'attemptId': 'attempt-a'})
        self.assertEqual(status, 200)
        self.assertEqual(body['submission']['answer'], attempt['submission']['answer'])
        self.assertNotIn('PRIVATE', json.dumps(body))
        self.assertNotIn('capture', body)

    def test_self_assessment_action_dispatches_only_to_authenticated_store_and_returns_original_receipt(self):
        body = {'schemaVersion': 1, 'attemptId': 'original', 'binding': {'ownerId': 'remote-owner'},
                'answerRevision': 1, 'submittedAt': '2026-10-10T09:00:00.000Z', 'rating': 'easy'}
        receipt = {'schemaVersion': 1, 'durable': True, 'selfAssessment': body, 'selfAssessmentHash': 'a' * 64}
        store = types.SimpleNamespace(self_assess=mock.Mock(return_value=receipt))
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store) as factory:
            self.assertEqual(self.request('self-assess', body), (200, receipt))
        self.assertEqual(factory.call_args.args[1], self.transport.owner)
        store.self_assess.assert_called_once_with(body)

    def test_read_exposes_only_original_self_assessment_and_active_request(self):
        assessment = {'schemaVersion': 1, 'rating': 'hard', 'binding': {'captureId': 'original-pending-capture'}}
        attempt = {'submission': {'answer': ''}, 'binding': {}, 'sourceBinding': {},
                   'evaluation': None, 'receipt': {}, 'selfAssessment': assessment, 'evaluationRequest': 'inflight',
                   'capture': {'descriptor': {'route': {'stateRef': 'PRIVATE/route.md'}}}}
        store = types.SimpleNamespace(read_attempt=mock.Mock(return_value=attempt))
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store):
            status, body = self.request('read', {'attemptId': 'original'})
        self.assertEqual(status, 200)
        self.assertEqual(body['selfAssessment'], assessment)
        self.assertEqual(body['activeRequestId'], 'inflight')
        self.assertNotIn('PRIVATE', json.dumps(body))

    def test_storage_error_does_not_become_a_durable_receipt(self):
        store = types.SimpleNamespace(submit=mock.Mock(side_effect=OSError('private-path test failure')))
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store):
            self.assertEqual(self.request('submit'), (503, {'error': 'source-admission-storage-unavailable'}))

    def test_invalid_protocol_and_actions_cannot_dispatch_write_methods(self):
        store = types.SimpleNamespace(capture=mock.Mock(), submit=mock.Mock(), claim=mock.Mock())
        with mock.patch.object(routes_nonword_source, 'create_source_admission', return_value=store):
            self.assertEqual(self.request('unknown')[0], 409)
            self.assertEqual(self.transport.request('unused', path='/v1/nonword/source',
                payload={'schemaVersion': True, 'action': 'capture', 'request': {}})[0], 409)
        store.capture.assert_not_called()
        store.submit.assert_not_called()
        store.claim.assert_not_called()


if __name__ == '__main__':
    unittest.main()
