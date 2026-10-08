import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from course_model_qa_observation import observe_reply, safe_failure_code


class QAObservationTests(unittest.TestCase):
    def test_authored_reply_is_preserved_without_request_headers_or_error_details(self):
        raw = json.dumps({'model': 'synthetic', 'usage': {'total_tokens': 12, 'secret': 'hidden'},
                          'authorization': 'synthetic-sensitive', 'error': {'message': 'hidden'},
                          'choices': [{'finish_reason': 'stop', 'message': {'content': '{"status":"undetermined"}', 'other': 'hidden'}}]}).encode()
        result = observe_reply(raw)
        self.assertEqual(result['qaAssistantContent'], '{"status":"undetermined"}')
        self.assertEqual(result['usageTokens'], 12)
        self.assertNotIn('synthetic-sensitive', json.dumps(result))
        self.assertNotIn('hidden', json.dumps(result))

    def test_malformed_envelopes_do_not_break_provider_validation(self):
        for raw in (b'bad json', b'[]', b'{"usage":null,"choices":[null]}',
                    b'{"choices":null}', b'{"choices":[{}],"usage":{"total_tokens":true}}'):
            result = observe_reply(raw)
            self.assertIn('observationStatus', result)
            self.assertNotIn('usageTokens', result)

    def test_multiple_choices_are_not_silently_selected(self):
        result = observe_reply(b'{"choices":[{"message":{"content":"a"}},{"message":{"content":"b"}}]}')
        self.assertEqual(result['observationStatus'], 'invalid-choice')
        self.assertNotIn('qaAssistantContent', result)

    def test_oversize_preserves_only_size_and_hash(self):
        result = observe_reply(b'x' * 100001)
        self.assertEqual(result['observationStatus'], 'oversize')
        self.assertNotIn('qaAssistantContent', result)

    def test_only_machine_codes_are_reported(self):
        self.assertEqual(safe_failure_code(ValueError('course-provider-invalid-source')), 'course-provider-invalid-source')
        for text in ('secret-value', 'https://private.example/key', 'frozen-profile-changed: private detail'):
            self.assertEqual(safe_failure_code(ValueError(text)), 'detail-suppressed')

    def test_unpaired_unicode_never_breaks_metadata_or_qa_file_serialization(self):
        raw = b'{"model":"\\ud800","choices":[{"finish_reason":"\\ud800","message":{"content":"\\ud800"}}]}'
        result = observe_reply(raw)
        json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.assertEqual(result['responseBytes'], len(raw))
        self.assertEqual(result['observationStatus'], 'captured-qa-reply')


if __name__ == '__main__':
    unittest.main()
