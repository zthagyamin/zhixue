"""Saved recall input through the real store, engine and legacy adapter.

Controlled transport replies verify input/state boundaries, not model accuracy.
The resolver is the existing synthetic authoritative-source fixture; this does
not exercise Markdown registration, browser presentation or a live provider.
"""
import copy
import hashlib
import io
import json
import sqlite3
import sys
import unittest
from contextlib import closing
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'companion'),
                str(Path(__file__).resolve().parent)]
import test_nonword_source_store as source_fixture
import practice_engine
from infrastructure.legacy_ai import LegacyLearningProvider, LegacyModelPorts


class LegacyRecallSourceInputTests(unittest.TestCase):
    def setUp(self):
        self.h = source_fixture.SourceAdmissionTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        self.store = self.h.store
        self.prompt = 'Explain the distinction. ' + 'Question context ' * 30 + 'TASK_TAIL'
        self.reference = 'Trusted source reasoning. ' * 140 + 'REFERENCE_TAIL'
        self.points = 'Source review point. ' * 90 + 'POINT_TAIL'
        self.h.item.clear()
        self.h.item.update(questionType='recall', prompt=self.prompt,
                           explanation=self.reference, answer=self.reference,
                           reviewPoints=self.points)
        self.h.query['presentation'] = {'questionType': 'recall', 'prompt': self.prompt}
        self.h.descriptor['sourceHash'] = self.source_hash()
        self.sent = []
        self.engine_inputs = []
        self.engine_outputs = []
        self.reply = {'verdict': 'wrong', 'feedback': 'Controlled protocol reply only.',
                      'matched_points': [], 'missed_points': []}
        self.transport_error = None
        provider = LegacyLearningProvider(LegacyModelPorts(
            key=lambda: 'synthetic-key', model=lambda default: 'synthetic-model',
            default_model=lambda: 'synthetic-model', open=self.transport,
            validate=lambda *args: {}))

        def grade(item, answer):
            self.engine_inputs.append((copy.deepcopy(item), copy.deepcopy(answer)))
            result = practice_engine.grade_answer(
                item, answer, recall_grader=provider.grade_recall_deepseek)
            self.engine_outputs.append(copy.deepcopy(result))
            return result

        self.store.grade = grade

    def source_hash(self):
        return hashlib.sha256(json.dumps(self.h.item, ensure_ascii=False,
                                        sort_keys=True).encode('utf-8')).hexdigest()

    def transport(self, request, timeout):
        self.sent.append(json.loads(request.data))
        if self.transport_error:
            raise self.transport_error
        return io.BytesIO(json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
            'content': json.dumps(self.reply)}}]}).encode('utf-8'))

    def save_answer(self, answer, attempt_id='attempt-a'):
        capture = self.store.capture(self.h.query)
        self.assertEqual(capture['status'], 'confirmed' if self.h.available else 'pending')
        submission = self.h.submission(capture, answer=answer, attemptId=attempt_id)
        saved = self.store.submit(submission)
        self.assertTrue(saved['durable'])
        self.assertEqual(self.store.read_attempt(attempt_id)['submission'], submission)
        return capture, submission

    def assert_original_binding(self, result, capture, submission):
        original = submission['answer']
        expected_hash = hashlib.sha256(json.dumps(
            original, ensure_ascii=False, sort_keys=True, separators=(',', ':')
        ).encode('utf-8')).hexdigest()
        self.assertEqual(result['answerHash'], expected_hash)
        self.assertEqual(result['answerRevision'], submission['answerRevision'])
        self.assertEqual(result['binding'], submission['binding'])
        self.assertEqual(result['sourceBinding'], capture.get('sourceBinding'))
        self.assertEqual(result['sourceCaptureId'], capture['captureId'])
        self.assertEqual(self.store.read_attempt(submission['attemptId'])['submission'], submission)
        if capture['status'] == 'confirmed':
            self.assertEqual(result['sourceBinding'], {
                **submission['binding'], 'itemKey': self.h.descriptor['sourceKey'],
                'contentHash': self.h.descriptor['sourceHash']})
            self.assertNotEqual(result['binding']['contentHash'],
                                result['sourceBinding']['contentHash'])

    def assert_pending_without_claim(self, result, attempt_id='attempt-a'):
        self.assertEqual(result['status'], 'pending')
        self.assertTrue(result['durable'])
        self.assertNotIn('correct', result)
        self.assertNotIn('rating', result)
        self.assertNotIn('outcome', result)
        with self.assertRaisesRegex(ValueError, 'evaluation-required'):
            self.store.claim({'attemptId': attempt_id, 'eventId': 'cannot-promote'})
        self.assertIsNone(self.store.read_claim_by_event('cannot-promote'))
        with closing(sqlite3.connect(self.h.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM nonword_source_claims').fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT count(*) FROM sqlite_master WHERE name='study_events_v3'"
            ).fetchone()[0], 0)

    def test_saved_long_original_and_full_source_reach_adapter_with_distinct_suffixes(self):
        prefix = 'Learner reasoning with an incomplete common prefix. ' * 80
        for index, (verdict, outcome, tail) in enumerate((
                ('wrong', 'incorrect', 'FIRST_DIFFERENT_RESULT'),
                ('partial', 'partial', 'SECOND_DIFFERENT_RESULT'))):
            with self.subTest(verdict=verdict):
                self.reply['verdict'] = verdict
                original = '  \t' + prefix + '\n' + tail + '  \n'
                capture, submitted = self.save_answer(original, f'long-{index}')
                result = self.store.evaluate({'attemptId': submitted['attemptId'],
                                              'requestId': f'long-request-{index}'})
                self.assertEqual(result['status'], 'resolved')
                self.assertFalse(result['correct'])
                self.assertEqual(result['outcome'], outcome)
                self.assert_original_binding(result, capture, submitted)
                self.assertEqual(self.engine_inputs[index], (self.h.item, original))
                content = self.sent[index]['messages'][1]['content']
                for complete_input in (self.prompt, self.reference, self.points, original):
                    self.assertIn(complete_input, content)
                self.assertEqual(self.store.evaluate({
                    'attemptId': submitted['attemptId'],
                    'requestId': f'long-request-{index}'}), result)
                self.assertEqual(len(self.sent), index + 1)
        self.assertNotEqual(self.sent[0]['messages'][1]['content'],
                            self.sent[1]['messages'][1]['content'])

    def test_oversize_complete_request_keeps_saved_original_pending_before_transport(self):
        self.reference = 'Trusted source detail. ' * 2300 + 'REFERENCE_TAIL'
        self.h.item.update(explanation=self.reference, answer=self.reference)
        self.h.descriptor['sourceHash'] = self.source_hash()
        original = '  ' + 'a' * 20000 + '\nOVERSIZE_ORIGINAL_TAIL  '
        capture, submitted = self.save_answer(original)
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'oversize'})
        self.assert_original_binding(result, capture, submitted)
        self.assertEqual(self.engine_inputs, [(self.h.item, original)])
        self.assertEqual(self.engine_outputs[0]['verdict'], 'self-assess')
        self.assertIsNone(self.engine_outputs[0]['correct'])
        self.assertTrue(self.engine_outputs[0]['aiFallback'])
        self.assertEqual(self.sent, [])
        self.assert_pending_without_claim(result)

    def test_provider_failure_keeps_original_pending_without_turning_unknown_into_grade(self):
        original = '  ' + 'Saved learner reasoning. ' * 100 + '\nFAILURE_TAIL  '
        capture, submitted = self.save_answer(original)
        self.transport_error = TimeoutError('Synthetic provider timeout')
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'provider-failure'})
        self.assert_original_binding(result, capture, submitted)
        self.assertIn(original, self.sent[0]['messages'][1]['content'])
        self.assertIsNone(self.engine_outputs[0]['correct'])
        self.assertTrue(self.engine_outputs[0]['aiFallback'])
        self.assert_pending_without_claim(result)

    def test_unknown_provider_verdict_stays_pending_without_formal_claim(self):
        original = '  ' + 'Saved learner reasoning. ' * 100 + '\nUNKNOWN_TAIL  '
        capture, submitted = self.save_answer(original)
        self.reply['verdict'] = 'unknown'
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'unknown'})
        self.assert_original_binding(result, capture, submitted)
        self.assertIn(original, self.sent[0]['messages'][1]['content'])
        self.assertIsNone(self.engine_outputs[0]['correct'])
        self.assert_pending_without_claim(result)

    def test_unverified_source_never_calls_engine_or_provider(self):
        self.h.available = False
        capture, submitted = self.save_answer('  Saved pending original.  ')
        result = self.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'unverified'})
        self.assert_original_binding(result, capture, submitted)
        self.assertEqual(self.engine_inputs, [])
        self.assertEqual(self.sent, [])
        self.assert_pending_without_claim(result)


if __name__ == '__main__':
    unittest.main()
