import copy
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError

sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'companion'),str(Path(__file__).resolve().parent)]
from test_code_review_provider import attempt,review,prepare_code_review
import test_code_review_ledger as ledger_fixture
from application.code_review import normalize_code_review
from application.code_review_application import CodeReviewApplication,CodeReviewRejected


class CodeReviewApplicationTests(unittest.TestCase):
    def setUp(self):
        self.h=ledger_fixture.CodeReviewLedgerTests();self.h.setUp();self.addCleanup(self.h.doCleanups)
        self.answer=attempt();self.calls=[];self.current=True;self.hook=None
        self.settings={**self.h.settings};self.key='synthetic-key'
        self.app=CodeReviewApplication(self.h.ledger,lambda:(copy.deepcopy(self.settings),self.key),self.provider,
                                       lambda a,r:self.current,prepare_code_review)

    def provider(self,settings,key,data,request_id,reservation,dispatch):
        dispatch()
        self.calls.append(request_id)
        if self.hook:return self.hook(settings,key,data,request_id,reservation)
        return normalize_code_review(review(data),data),20,{'requestId':request_id}

    def test_result_is_saved_once_and_recovered_after_page_request_identity_changes(self):
        first=self.app.evaluate(self.answer,'one');self.assertEqual(first['status'],'resolved')
        self.assertEqual(self.app.evaluate(self.answer,'two'),first);self.assertEqual(len(self.calls),1)

    def test_timeout_never_automatically_dispatches_another_call(self):
        def fail(*args):raise TimeoutError('synthetic unavailable reply')
        self.hook=fail
        self.assertEqual(self.app.evaluate(self.answer,'one')['status'],'pending')
        self.h.now+=121
        self.assertEqual(self.app.evaluate(self.answer,'two')['reason'],'code-review-receipt-unknown')
        self.assertEqual(len(self.calls),1)

    def test_unconfigured_provider_can_recover_later_without_an_initial_call(self):
        self.settings['configured']=False
        self.assertEqual(self.app.evaluate(self.answer,'one')['reason'],'code-review-unconfigured')
        self.assertFalse(self.calls);self.settings['configured']=True
        self.assertEqual(self.app.evaluate(self.answer,'two')['status'],'resolved');self.assertEqual(len(self.calls),1)

    def test_explicit_rejection_is_known_pending_and_allows_later_explicit_retry(self):
        def rejected(*args):raise CodeReviewRejected()
        self.hook=rejected;self.assertEqual(self.app.evaluate(self.answer,'one')['reason'],'code-review-provider-rejected')
        self.hook=None;self.assertEqual(self.app.evaluate(self.answer,'two')['status'],'resolved')
        self.assertEqual(len(self.calls),2)

    def test_environment_report_does_not_dispatch_or_grade_student(self):
        report=self.answer['codeReports'][0]['evidence']['report'];report.update(status='failed',phase='preparation',outcome='environment-error',assertionsPassed=0,assertionsExecuted=0)
        self.assertEqual(self.app.evaluate(self.answer,'one')['status'],'pending');self.assertFalse(self.calls)
        self.assertFalse(self.h.path.exists())

    def test_source_switch_before_or_during_provider_keeps_result_pending(self):
        self.current=False;self.assertEqual(self.app.evaluate(self.answer,'one')['reason'],'code-review-source-changed');self.assertFalse(self.calls)
        self.current=True
        def changed(settings,key,data,request_id,reservation):
            self.current=False;return normalize_code_review(review(data),data),20,{}
        self.hook=changed;self.assertEqual(self.app.evaluate(self.answer,'two')['reason'],'code-review-source-changed')

    def test_source_switch_while_finishing_a_known_recovery_keeps_result_pending(self):
        self.assertEqual(self.app.evaluate(self.answer,'one')['status'],'resolved')
        finish=self.h.ledger.finish
        def switched(job_id):
            result=finish(job_id);self.current=False;return result
        self.h.ledger.finish=switched
        self.assertEqual(self.app.evaluate(self.answer,'recovered')['reason'],'code-review-source-changed')
        self.assertEqual(len(self.calls),1)
