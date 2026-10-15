"""Controlled recall replies through real source admission and shared ledgers.

These are receipt/protocol tests, not model-semantic or website acceptance.
Fixture TestCases are imported as a module to avoid duplicate discovery.
"""
import copy
import io
import json
import sqlite3
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import timedelta
from pathlib import Path
from threading import Event
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_legacy_recall_source_input as recall_fixture
from infrastructure.code_review_ledger import CodeReviewLedger, ReviewJobLedger
from infrastructure.nonword_code_reports import review_current
from infrastructure.nonword_source_store import SourceAdmissionStore
from infrastructure.shared_ai_budget import reservation_totals
from infrastructure.source_recall_review_adapter import create_source_recall_review


class SourceRecallReviewTests(unittest.TestCase):
    def setUp(self):
        self.f = recall_fixture.LegacyRecallSourceInputTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.store = self.f.store
        self.path = self.store.path.with_name('shared.db')
        self.key = 'synthetic-key-private-only'
        self.settings = {
            'enabled': True, 'configured': True, 'provider': 'deepseek',
            'model': 'synthetic-model', 'baseUrl': 'https://api.deepseek.com',
            'revision': 0, 'maxOutputTokens': 800, 'dailyRequestLimit': 30,
            'dailyTokenLimit': 1000000, 'concurrentLimit': 1,
            'providerKey': self.key,
        }
        self.services = SimpleNamespace(LOCAL_DATABASE_PATH=self.path,
            ai_store=lambda db: SimpleNamespace(
                snapshot=lambda owner, library: (copy.deepcopy(self.settings), self.key)))
        self.sent = []
        self.reply = {'verdict': 'correct', 'feedback': 'Controlled fixture feedback.',
                      'matched_points': ['A source point.'], 'missed_points': []}
        self.envelope = None
        self.error = None
        self.during_transport = None
        self.attach(self.store)

    def attach(self, store):
        reviewer = create_source_recall_review(self.services, store.owner, store.library,
            self.f.h.root, lambda attempt, request: review_current(store, attempt, request),
            clock=lambda: self.f.h.now.timestamp(), transport=self.transport)
        store.recall_review = reviewer.evaluate
        return reviewer

    def restart(self):
        self.store = SourceAdmissionStore(self.store.path, self.store.owner, self.store.library,
            self.f.h.root, self.store.resolver, self.store.grade, self.store.now)
        self.attach(self.store)
        return self.store

    def transport(self, request, timeout):
        self.sent.append({'body': json.loads(request.data), 'headers': dict(request.header_items())})
        if self.during_transport:
            self.during_transport()
        if self.error:
            raise self.error
        envelope = self.envelope if self.envelope is not None else {
            'choices': [{'finish_reason': 'stop', 'message': {
                'role': 'assistant', 'content': json.dumps(self.reply)}}],
            'usage': {'total_tokens': 17},
        }
        raw = envelope if isinstance(envelope, bytes) else json.dumps(envelope).encode('utf8')
        return io.BytesIO(raw)

    def save(self, answer='Original learner explanation.', attempt='attempt-a'):
        return self.f.save_answer(answer, attempt)

    def evaluate(self, request, attempt='attempt-a'):
        return self.store.evaluate({'attemptId': attempt, 'requestId': request})

    def assert_pending(self, result, attempt='attempt-a'):
        self.f.assert_pending_without_claim(result, attempt)

    def rows(self, table):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute('SELECT * FROM ' + table).fetchall()

    def test_known_result_replays_after_restart_with_new_request_without_dispatch(self):
        capture, submission = self.save()
        first = self.evaluate('known-first')
        self.assertEqual(first['status'], 'resolved')
        self.assertEqual(self.evaluate('known-first'), first)
        self.restart()
        recovered = self.evaluate('known-recovered')
        self.assertEqual(recovered['status'], 'resolved')
        self.assertEqual(recovered['outcome'], first['outcome'])
        self.f.assert_original_binding(recovered, capture, submission)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.rows('nonword_recall_jobs')), 1)
        self.assertEqual(self.f.engine_inputs, [])

    def test_unconfigured_request_is_immutable_and_fresh_request_explicitly_recovers(self):
        self.save()
        self.settings.update(enabled=False, configured=False)
        first = self.evaluate('unconfigured')
        self.assert_pending(first)
        self.assertEqual(first['reason'], 'recall-review-unconfigured')
        self.assertEqual(self.sent, [])
        self.settings.update(enabled=True, configured=True, revision=1)
        self.restart()
        self.assertEqual(self.evaluate('unconfigured'), first)
        recovered = self.evaluate('enabled-explicitly')
        self.assertEqual(recovered['status'], 'resolved')
        self.assertEqual(len(self.sent), 1)

    def test_timeout_stays_unknown_across_lease_restart_and_all_fresh_ids(self):
        capture, submission = self.save()
        self.error = TimeoutError('Synthetic lost delivery receipt')
        first = self.evaluate('lost-receipt')
        self.assert_pending(first)
        self.error = None
        for index, advance in enumerate((0, 121, 86400)):
            self.f.h.now += timedelta(seconds=advance)
            self.restart()
            pending = self.evaluate('after-timeout-' + str(index))
            self.assert_pending(pending)
            self.f.assert_original_binding(pending, capture, submission)
            self.assertEqual(pending['reason'], 'recall-review-receipt-unknown')
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.rows('nonword_recall_jobs')[0][8], 'uncertain')

    def test_legacy_verdicts_map_to_public_outcomes_and_idempotent_admission_claims(self):
        for verdict, outcome, correct, rating in (
                ('correct', 'correct', True, 'good'),
                ('partial', 'partial', False, 'hard'),
                ('wrong', 'incorrect', False, 'again')):
            with self.subTest(verdict=verdict):
                attempt = 'verdict-' + verdict
                self.save(attempt=attempt)
                self.reply['verdict'] = verdict
                result = self.evaluate(attempt, attempt)
                self.assertEqual((result['status'], result['outcome'], result['correct']),
                                 ('resolved', outcome, correct))
                request = {'attemptId': attempt, 'eventId': 'claim-' + verdict}
                claim = self.store.claim(request)
                self.assertEqual(self.store.claim(request), claim)
                self.assertEqual((claim['claim']['correct'], claim['claim']['rating']), (correct, rating))
                with self.assertRaisesRegex(ValueError, 'claim-conflict'):
                    self.store.claim({**request, 'eventId': 'another-' + verdict})
        with closing(sqlite3.connect(self.store.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM nonword_source_claims').fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='study_events_v3'").fetchone()[0], 0)
        self.assertEqual(len(self.sent), 3)

    def test_delayed_response_checks_source_and_preserves_frozen_settings_provenance(self):
        for index, change in enumerate(('source', 'settings')):
            with self.subTest(change=change):
                attempt = 'delay-' + change
                self.save(attempt=attempt)
                frozen_revision = self.settings['revision']
                frozen_model = self.settings['model']
                started, release = Event(), Event()
                def delayed():
                    started.set()
                    self.assertTrue(release.wait(5))
                self.during_transport = delayed
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(self.evaluate, attempt, attempt)
                    self.assertTrue(started.wait(5))
                    try:
                        if change == 'source':
                            self.f.h.available = False
                        else:
                            self.settings['revision'] += 1
                    finally:
                        release.set()
                    result = future.result(timeout=5)
                if change == 'source':
                    self.assert_pending(result, attempt)
                else:
                    self.assertEqual(result['status'], 'resolved')
                    self.assertEqual(self.evaluate(attempt + '-replay', attempt)['status'], 'resolved')
                    with closing(sqlite3.connect(self.path)) as db:
                        raw_input, raw_receipt = db.execute(
                            'SELECT input_json,receipt FROM nonword_recall_jobs WHERE attempt_id=?',
                            (attempt,)).fetchone()
                    snapshot, receipt = json.loads(raw_input), json.loads(raw_receipt)
                    self.assertEqual(snapshot['settings']['revision'], frozen_revision)
                    self.assertEqual(snapshot['settings']['model'], frozen_model)
                    self.assertEqual(receipt['trace']['modelId'], frozen_model)
                    self.assertNotEqual(snapshot['settings']['revision'], self.settings['revision'])
                self.assertEqual(len(self.sent), index + 1)
                self.f.h.available = True
                self.during_transport = None
        self.assertEqual(len(self.sent), 2)

    def test_unknown_or_extra_reply_shapes_abstain_and_block_redispatch(self):
        variants = (
            {**self.reply, 'verdict': 'unknown'},
            {**self.reply, 'rating': 'easy'},
            {**self.reply, 'matched_points': 'untyped point'},
            {**self.reply, 'feedback': 1},
            ['correct'],
        )
        for index, reply in enumerate(variants):
            with self.subTest(reply=reply):
                self.f.h.now += timedelta(seconds=121)
                attempt = 'shape-' + str(index)
                self.save(attempt=attempt)
                self.reply = reply
                count = len(self.sent)
                self.assert_pending(self.evaluate(attempt, attempt), attempt)
                self.restart()
                self.assert_pending(self.evaluate(attempt + '-fresh', attempt), attempt)
                self.assertEqual(len(self.sent), count + 1)

    def test_malformed_duplicate_and_nonfinite_json_block_all_later_dispatches(self):
        invalid_contents = ('{broken',
            '{"verdict":"correct","verdict":"wrong","feedback":"x","matched_points":[],"missed_points":[]}',
            '{"verdict":"correct","feedback":"x","confidence":NaN,"matched_points":[],"missed_points":[]}',
            '{"verdict":"correct","feedback":"x","confidence":1e999,"matched_points":[],"missed_points":[]}')
        for index, content in enumerate(invalid_contents):
            with self.subTest(content=content):
                self.f.h.now += timedelta(seconds=121)
                attempt = 'invalid-json-' + str(index)
                self.save(attempt=attempt)
                self.envelope = {'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]}
                count = len(self.sent)
                self.assert_pending(self.evaluate(attempt, attempt), attempt)
                self.restart()
                self.assert_pending(self.evaluate(attempt + '-fresh', attempt), attempt)
                self.assertEqual(len(self.sent), count + 1)

    def test_truncation_tools_refusal_usage_overflow_and_secret_echo_stay_unknown(self):
        normal = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(self.reply)}}]}
        variants = []
        truncated = copy.deepcopy(normal); truncated['choices'][0]['finish_reason'] = 'length'; variants.append(truncated)
        for field, value in (('tool_calls', [{'id': 'tool'}]), ('refusal', 'refused'),
                             ('content', json.dumps({**self.reply, 'feedback': self.key}))):
            envelope = copy.deepcopy(normal); envelope['choices'][0]['message'][field] = value; variants.append(envelope)
        variants.append({**normal, 'usage': {'total_tokens': 1000000000}})
        for index, envelope in enumerate(variants):
            with self.subTest(envelope=index):
                self.f.h.now += timedelta(seconds=121)
                attempt = 'invalid-envelope-' + str(index)
                self.save(attempt=attempt)
                self.envelope = envelope
                count = len(self.sent)
                self.assert_pending(self.evaluate(attempt, attempt), attempt)
                self.restart()
                self.assert_pending(self.evaluate(attempt + '-fresh', attempt), attempt)
                self.assertEqual(len(self.sent), count + 1)

    def test_full_original_whitespace_tail_and_source_are_sent_and_saved_immutably(self):
        answer = '  \t' + 'Original learner detail. ' * 90 + '\nORIGINAL_DISTINCT_TAIL  \n'
        capture, submission = self.save(answer)
        result = self.evaluate('complete-input')
        self.assertEqual(result['status'], 'resolved')
        self.f.assert_original_binding(result, capture, submission)
        content = self.sent[0]['body']['messages'][1]['content']
        for original in (answer, self.f.prompt, self.f.reference, self.f.points):
            self.assertIn(original, content)
        with self.assertRaisesRegex(ValueError, 'submission-conflict'):
            self.store.submit({**submission, 'answer': answer.strip()})
        self.assertEqual(self.store.read_attempt('attempt-a')['submission'], submission)
        self.assertEqual(self.sent[0]['body']['max_tokens'], self.settings['maxOutputTokens'])
        self.assertTrue(self.sent[0]['headers']['Idempotency-key'].startswith('recall-review:'))

    def ledger_input(self, owner='owner-a', library='library-a', attempt='budget-attempt'):
        binding = {'ownerId': owner, 'libraryId': library, 'contentHash': 'a' * 64,
                   'itemKey': 'item', 'captureId': 'source-capture:' + 'b' * 64}
        return {'attemptId': attempt, 'binding': binding, 'sourceBinding': copy.deepcopy(binding),
                'answerRevision': 1, 'answer': 'Immutable synthetic answer.'}

    def ledger(self, family, owner='owner-a', library='library-a'):
        cls = CodeReviewLedger if family == 'code' else ReviewJobLedger
        kwargs = {} if family == 'code' else {'family': 'recall'}
        return cls(self.path, owner, library, self.f.h.root,
                   clock=lambda: self.f.h.now.timestamp(), **kwargs)

    def test_recall_and_code_share_owner_concurrency_and_daily_request_limits(self):
        recall = self.ledger('recall')
        first = recall.begin('recall-budget', self.ledger_input(), self.settings)
        amount = recall.reserve(first); recall.dispatch(first)
        code = self.ledger('code', library='another-library')
        second = code.begin('code-budget', self.ledger_input(library='another-library'), self.settings)
        with self.assertRaisesRegex(ValueError, 'concurrent-budget'):
            code.reserve(second)
        isolated = self.ledger('code', owner='another-owner', library='another-library')
        isolated_ticket = isolated.begin('isolated', self.ledger_input('another-owner', 'another-library'), self.settings)
        isolated.reserve(isolated_ticket)
        isolated.abort_preflight(isolated_ticket)
        recall.prepare(first, {'status': 'pending', 'reason': 'known-response'}, 17, None)
        recall.finish(first['jobId'])
        code.abort_preflight(second)
        limited = {**self.settings, 'dailyRequestLimit': 1}
        daily = code.begin('daily-limited', self.ledger_input(library='another-library'), limited)
        with self.assertRaisesRegex(ValueError, 'daily-budget'):
            code.reserve(daily)
        with closing(sqlite3.connect(self.path)) as db:
            day = self.f.h.now.date().isoformat()
            self.assertEqual(reservation_totals(db, 'owner-a', day, self.f.h.now.timestamp() - 120), (1, amount, 0))

    def test_code_reservation_consumes_recall_token_budget_across_libraries(self):
        code = self.ledger('code')
        ticket = code.begin('code-spent', self.ledger_input(), self.settings)
        amount = code.reserve(ticket); code.dispatch(ticket)
        code.prepare(ticket, {'status': 'pending', 'reason': 'known'}, 1, None); code.finish(ticket['jobId'])
        recall = self.ledger('recall', library='another-library')
        limited = {**self.settings, 'dailyTokenLimit': amount}
        next_ticket = recall.begin('recall-limited', self.ledger_input(library='another-library'), limited)
        with self.assertRaisesRegex(ValueError, 'daily-budget'):
            recall.reserve(next_ticket)

    def test_private_call_input_and_receipt_do_not_persist_credentials(self):
        self.save(); self.evaluate('private-snapshot')
        with closing(sqlite3.connect(self.path)) as db:
            snapshots = db.execute('SELECT input_json,receipt FROM nonword_recall_jobs').fetchall()
        self.assertEqual(len(snapshots), 1)
        for raw in snapshots[0]:
            self.assertNotIn(self.key, raw)
            self.assertNotIn('providerKey', raw)
        frozen = json.loads(snapshots[0][0])
        self.assertEqual(frozen['data']['answer'], 'Original learner explanation.')
        self.assertEqual(frozen['data']['item'], self.f.h.item)


if __name__ == '__main__':
    unittest.main()
