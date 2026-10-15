"""Actual registered source, saved code, independent ledger and controlled model port."""
import copy
import io
import json
import sqlite3
import sys
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'companion'),str(Path(__file__).resolve().parent)]
import test_nonword_code_reports as source_fixture
import test_native_course_service as course_fixture
import test_native_math_service as math_fixture
from test_code_review_provider import review,prepare_code_review
from application.code_review import normalize_code_review
from application.code_review_application import CodeReviewApplication
from infrastructure.code_review_ledger import CodeReviewLedger
from infrastructure.code_review_adapter import create_code_review
from infrastructure.nonword_code_reports import review_current
from infrastructure.nonword_source_store import SourceAdmissionStore


class CodeReviewSourceTests(unittest.TestCase):
    def setUp(self):
        self.h=source_fixture.CodeReportStoreTests();self.h.setUp();self.addCleanup(self.h.doCleanups)
        self.store=self.h.h.store;self.calls=[];self.settings={'enabled':True,'configured':True,'provider':'deepseek',
            'model':'synthetic','baseUrl':'https://api.deepseek.com','revision':0,'maxOutputTokens':2000,
            'dailyTokenLimit':20000,'dailyRequestLimit':10,'concurrentLimit':1}
        self.ledger=CodeReviewLedger(self.store.path.with_name('shared.db'),self.store.owner,self.store.library,self.store.root)
        self.app=CodeReviewApplication(self.ledger,lambda:(self.settings,'synthetic-key'),self.provider,
            lambda attempt,request_id:review_current(self.store,attempt,request_id),prepare_code_review)
        self.store.code_review=self.app.evaluate
        self.store.record_code_report(self.h.request())

    def provider(self,settings,key,data,request_id,reservation,dispatch):
        dispatch();self.calls.append((copy.deepcopy(data),request_id))
        return normalize_code_review(review(data,'incorrect'),data),20,{'requestId':request_id}

    def test_actual_saved_wrong_original_gets_one_controlled_result_and_formal_admission(self):
        result=self.store.evaluate({'attemptId':'code-original','requestId':'first'})
        self.assertEqual(result['outcome'],'incorrect');self.assertFalse(result['correct'])
        self.assertEqual(self.calls[0][0]['answer'],self.h.submission['answer'])
        fresh=SourceAdmissionStore(self.store.path,self.store.owner,self.store.library,self.store.root_reference,
            self.store.resolver,self.store.grade,self.store.now,code_review=self.app.evaluate)
        again=fresh.evaluate({'attemptId':'code-original','requestId':'after-refresh'})
        self.assertEqual(again['outcome'],'incorrect');self.assertEqual(len(self.calls),1)
        claim=fresh.claim({'attemptId':'code-original','eventId':'original-event','rating':'again'})
        self.assertFalse(claim['claim']['correct']);self.assertEqual(claim['claim']['rating'],'again')
        self.assertEqual(fresh.claim({'attemptId':'code-original','eventId':'original-event','rating':'again'}),claim)
        with self.assertRaises(ValueError):fresh.claim({'attemptId':'code-original','eventId':'another-event','rating':'good'})
        self.assertEqual(len(self.calls),1)

    def test_actual_timeout_does_not_repeat_model_when_recovering_source_evaluation(self):
        def lost(*args):
            args[-1]();self.calls.append('lost');raise TimeoutError()
        self.app.provider=lost
        first=self.store.evaluate({'attemptId':'code-original','requestId':'first'})
        again=self.store.evaluate({'attemptId':'code-original','requestId':'explicit-retry'})
        self.assertEqual(first['status'],'pending');self.assertEqual(again['status'],'pending');self.assertEqual(self.calls,['lost'])
        with self.assertRaises(ValueError):self.store.claim({'attemptId':'code-original','eventId':'event'})

    def test_report_change_fences_outer_result_but_known_reply_allows_explicit_new_review(self):
        first=True
        def changed(settings,key,data,request_id,reservation,dispatch):
            nonlocal first
            dispatch();self.calls.append(request_id)
            if first:
                first=False;self.store.record_code_report(self.h.request(self.h.report(run=2)))
            return normalize_code_review(review(data,'incorrect'),data),20,{}
        self.app.provider=changed
        with self.assertRaisesRegex(ValueError,'evaluation-conflict'):
            self.store.evaluate({'attemptId':'code-original','requestId':'first'})
        self.assertIsNone(self.store.read_attempt('code-original')['evaluation'])
        result=self.store.evaluate({'attemptId':'code-original','requestId':'explicit-new-evidence'})
        self.assertEqual(result['outcome'],'incorrect');self.assertEqual(len(self.calls),2)
        self.assertEqual(len(self.store.read_attempt('code-original')['codeReports']),2)

    def test_configured_adapter_builds_and_records_dispatch_with_mock_transport_only(self):
        snapshots=[]
        settings=copy.deepcopy(self.settings)
        services=SimpleNamespace(LOCAL_DATABASE_PATH=self.ledger.path,ai_store=lambda db:
            SimpleNamespace(snapshot=lambda owner,library:(snapshots.append((owner,library)) or (settings,'synthetic-key'))))
        def transport(request,timeout):
            data=json.loads(request.data)['messages'][1]['content'];data=json.loads(data)
            with closing(sqlite3.connect(self.ledger.path)) as db:
                self.assertEqual(db.execute('SELECT state FROM nonword_code_jobs').fetchone()[0],'dispatched')
            self.calls.append('transport')
            return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(review(data,'incorrect'))}}],
                                         'usage':{'total_tokens':20}}).encode())
        configured=create_code_review(services,self.store.owner,self.store.library,self.store.root,
            lambda attempt,request_id:review_current(self.store,attempt,request_id),transport=transport)
        self.store.code_review=configured.evaluate
        result=self.store.evaluate({'attemptId':'code-original','requestId':'configured'})
        self.assertEqual(result['outcome'],'incorrect');self.assertEqual(self.calls,['transport'])
        self.assertTrue(all(value==(self.store.owner,self.store.library) for value in snapshots))


class SharedCodeBudgetTests(unittest.TestCase):
    def setUp(self):
        self.h=course_fixture.Harness();self.addCleanup(self.h.close)
        self.code=CodeReviewLedger(self.h.source.db,self.h.ledger.owner,self.h.ledger.library,self.h.source.vault,
            clock=lambda:self.h.now)
        binding={'ownerId':self.h.ledger.owner,'libraryId':self.h.ledger.library}
        self.data={'attemptId':'code-original','binding':binding,'sourceBinding':binding,'answer':'original code'}

    def test_code_reservation_blocks_actual_course_and_counts_toward_daily_budget(self):
        ticket=self.code.begin('code-request',self.data,self.h.settings);self.code.reserve(ticket);self.code.dispatch(ticket)
        request=self.h.request();self.h.ledger.begin(request)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'):self.h.ledger.reserve(request,self.h.task,self.h.settings)
        self.h.now+=121
        with self.assertRaisesRegex(ValueError,'daily-budget'):
            self.h.ledger.reserve(request,self.h.task,{**self.h.settings,'dailyRequestLimit':1})

    def test_actual_course_reservation_blocks_code_without_dispatch(self):
        request=self.h.request();self.h.ledger.begin(request);self.h.ledger.reserve(request,self.h.task,self.h.settings)
        ticket=self.code.begin('code-request',self.data,self.h.settings)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'):self.code.reserve(ticket)

    def test_code_reservation_blocks_actual_math_reservation(self):
        h=math_fixture.NativeMathServiceTests();h.setUp();self.addCleanup(h.tearDown);self.addCleanup(h.doCleanups)
        h.ledger.claim(h.claim);h.ledger.begin(h.request)
        binding={'ownerId':h.ledger.scope[0],'libraryId':h.ledger.scope[1]}
        code=CodeReviewLedger(h.db,h.ledger.scope[0],h.ledger.scope[1],h.vault)
        ticket=code.begin('code-request',{**self.data,'binding':binding,'sourceBinding':binding},self.h.settings)
        code.reserve(ticket);code.dispatch(ticket)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'):
            h.ledger.reserve(h.request['requestId'],{'text':'saved step'},self.h.settings)
