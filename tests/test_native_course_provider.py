"""Strict transport protocol uses fake responses, never an external model."""
import copy
import io
import json
import unittest
from types import SimpleNamespace
from unittest import mock
from test_native_course_service import Harness
from infrastructure.course_grade_provider import evaluate_course, provider_body
from infrastructure.course_grade_adapter import create_native_course_application


class NativeCourseProviderTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)
        self.request = self.h.request()
        self.answer = self.request['submission']['answer']
        self.result = self.h.provider(self.h.task, self.answer, 'request-1', self.h.settings, 10000)

    def envelope(self, **patch):
        return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(self.result['diagnostic'])}}],
                'usage': {'total_tokens': 100}, **patch}

    def evaluate(self, envelope):
        observed = []
        def transport(request, timeout):
            observed.append((request, timeout))
            return io.BytesIO(json.dumps(envelope).encode('utf-8'))
        settings = {**self.h.settings, 'baseUrl': 'https://api.deepseek.com'}
        result = evaluate_course(settings, 'synthetic-test-key', self.h.task, self.answer,
                                 'request-1', 10000, transport=transport)
        self.assertEqual(observed[0][1], 40)
        return result

    def test_quote_bound_strict_json_and_trace_no_credentials(self):
        result = self.evaluate(self.envelope())
        self.assertEqual(result['diagnostic'], self.result['diagnostic'])
        self.assertEqual(result['trace']['promptVersion'], 'course-task-json-v1')
        self.assertNotIn('synthetic-test-key', json.dumps(result))
        self.assertNotIn('api.deepseek.com', json.dumps(result))
        body = provider_body(self.h.task, self.answer, self.h.settings)
        self.assertEqual(body['max_tokens'], 2000)
        supplied = json.loads(body['messages'][1]['content'])
        self.assertEqual(supplied['capturedTask'], self.h.task)
        self.assertEqual(supplied['originalLearnerAnswer'], self.answer)

    def test_truncated_oversize_invalid_json_duplicate_keys_and_usage_rejected(self):
        bad = [[], self.envelope(choices=[1]), self.envelope(usage=None),
               self.envelope(choices=[]), self.envelope(usage={'total_tokens': 10001}),
               self.envelope(choices=[{'finish_reason': 'length', 'message': {'content': '{}'}}]),
               self.envelope(choices=[{'finish_reason': 'stop', 'message': {'content': '```json\n{}\n```'}}]),
               self.envelope(choices=[{'finish_reason': 'stop', 'message': {'content': '{"schemaVersion":1,"schemaVersion":1}'}}]),
               self.envelope(extra='x' * 100001)]
        for row in bad:
            with self.subTest(row=str(row)[:80]), self.assertRaises(ValueError):
                self.evaluate(row)

    def test_untrusted_points_quotes_status_and_provider_self_assessment_rejected(self):
        patches = ({'matchedPointIds': ['invented']}, {'source': 'self-assess'},
                   {'pointEvidence': []}, {'rating': 'easy'}, {'status': 'partial'})
        for patch in patches:
            diagnostic = {**self.result['diagnostic'], **patch}
            envelope = self.envelope(choices=[{'finish_reason': 'stop', 'message': {'content': json.dumps(diagnostic)}}])
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.evaluate(envelope)
        diagnostic = copy.deepcopy(self.result['diagnostic'])
        diagnostic['pointEvidence'][0]['sourceQuote'] = 'Absent source wording'
        with self.assertRaises(ValueError):
            self.evaluate(self.envelope(choices=[{'finish_reason': 'stop', 'message': {'content': json.dumps(diagnostic)}}]))

    def test_adapter_rechecks_frozen_settings_revision_without_transport(self):
        snapshots = []
        h = self.h
        class Store:
            def snapshot(self, owner, library):
                self_owner, self_library = '1' * 64, h.identity['libraryId']
                if (owner, library) != (self_owner, self_library):
                    raise AssertionError('Settings must use authenticated owner/library')
                snapshots.append(True)
                return {**h.settings, 'revision': 0 if len(snapshots) == 1 else 1}, 'synthetic-key'
        services = SimpleNamespace(
            source_path=lambda setting: h.source.vault,
            effective_gateway=h.source.loader, LOCAL_DATABASE_PATH=h.source.db,
            local_vault_library_id=lambda root: h.identity['libraryId'], ai_store=lambda db: Store())
        app = create_native_course_application(services, '1' * 64)
        with mock.patch('infrastructure.course_grade_adapter.evaluate_course') as transport:
            pending = app.grade(h.request())
        self.assertEqual(pending['diagnostic']['status'], 'undetermined')
        self.assertEqual(len(snapshots), 2)
        transport.assert_not_called()
        self.assertNotIn('synthetic-key', json.dumps(pending))

    def test_adapter_uses_frozen_actual_limits_and_existing_transport(self):
        h = self.h
        settings = {**h.settings, 'dailyRequestLimit': 1, 'maxOutputTokens': 1200}
        class Store:
            def snapshot(self, owner, library):
                return copy.deepcopy(settings), 'synthetic-key'
        services = SimpleNamespace(
            source_path=lambda setting: h.source.vault,
            effective_gateway=h.source.loader, LOCAL_DATABASE_PATH=h.source.db,
            local_vault_library_id=lambda root: h.identity['libraryId'], ai_store=lambda db: Store())
        app = create_native_course_application(services, '1' * 64)
        with mock.patch('infrastructure.course_grade_adapter.evaluate_course', return_value=self.result) as provider:
            result = app.grade(h.request())
            second = app.grade(h.request(requestId='second', attemptId='second'))
        self.assertEqual(result['diagnostic']['status'], 'correct')
        self.assertEqual(second['diagnostic']['status'], 'undetermined')
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(provider.call_args.args[0]['maxOutputTokens'], 1200)


if __name__ == '__main__':
    unittest.main()
