"""Unknown recall delivery must not authorize another model dispatch."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_legacy_recall_source_input as recall_fixture
from infrastructure.nonword_source_store import SourceAdmissionStore
from infrastructure.source_recall_review_adapter import create_source_recall_review
from infrastructure.nonword_code_reports import review_current
from types import SimpleNamespace


class SourceRecallCallRecoveryTests(unittest.TestCase):
    def test_unknown_delivery_survives_a_new_source_request_and_store_restart(self):
        fixture = recall_fixture.LegacyRecallSourceInputTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        settings={'enabled':True,'configured':True,'provider':'deepseek','model':'synthetic-model',
                  'baseUrl':'https://api.deepseek.com','revision':0,'maxOutputTokens':800,
                  'dailyRequestLimit':10,'dailyTokenLimit':100000,'concurrentLimit':1}
        services=SimpleNamespace(LOCAL_DATABASE_PATH=fixture.store.path.with_name('shared.db'),
            ai_store=lambda db:SimpleNamespace(snapshot=lambda owner,library:(settings,'synthetic-key')))
        def reviewer(store):
            return create_source_recall_review(services,store.owner,store.library,fixture.h.root,
                lambda attempt,request_id:review_current(store,attempt,request_id),transport=fixture.transport)
        fixture.store.recall_review=reviewer(fixture.store).evaluate
        capture, submission = fixture.save_answer('Original learner explanation.')
        fixture.transport_error = TimeoutError('Synthetic delivery receipt lost')
        first = fixture.store.evaluate({'attemptId': 'attempt-a', 'requestId': 'first-delivery'})
        self.assertEqual(len(fixture.sent),1,first.get('reason'))
        fixture.assert_pending_without_claim(first)
        restarted = SourceAdmissionStore(
            fixture.store.path, fixture.store.scope[0], fixture.store.scope[1],
            fixture.h.root, fixture.store.resolver, fixture.store.grade, fixture.store.now)
        restarted.recall_review=reviewer(restarted).evaluate
        second = restarted.evaluate({'attemptId': 'attempt-a', 'requestId': 'after-restart'})
        fixture.assert_pending_without_claim(second)
        fixture.assert_original_binding(second, capture, submission)
        self.assertEqual(len(fixture.sent), 1,
                         'Unknown prior delivery must not be redispatched under a new request ID')


if __name__ == '__main__':
    unittest.main()
