import copy
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from infrastructure.code_review_ledger import CodeReviewLedger
from infrastructure.shared_ai_budget import reservation_totals


class CodeReviewLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'local.db'; self.now=1000
        self.ledger = CodeReviewLedger(self.path,'owner','library',self.temp.name,clock=lambda:self.now,lease_seconds=10)
        binding={'ownerId':'owner','libraryId':'library','contentHash':'a'*64,'itemKey':'item','captureId':'source-capture:'+'b'*64}
        self.data={'attemptId':'first','binding':binding,'sourceBinding':copy.deepcopy(binding),'answerRevision':0,'answer':'return x'}
        self.settings={'provider':'deepseek','model':'configured-model','baseUrl':'https://api.deepseek.com',
                       'revision':1,'enabled':True,'configured':True,'dailyRequestLimit':10,'dailyTokenLimit':100000,'concurrentLimit':1,'maxOutputTokens':100}
        self.pending={'status':'pending','reason':'code-review-insufficient'}
        self.resolved={'status':'resolved','correct':True,'outcome':'correct','explanation':'Source-based code review.'}

    def start(self, request='request', data=None):
        ticket=self.ledger.begin(request,data or self.data,self.settings)
        self.assertEqual(ticket['kind'],'start'); return ticket

    def dispatched(self):
        ticket=self.start(); self.ledger.reserve(ticket); self.ledger.dispatch(ticket); return ticket

    def test_dispatched_orphan_stays_pending_across_request_ids_and_lease_expiry(self):
        ticket=self.dispatched()
        self.assertEqual(self.ledger.begin('second',self.data,self.settings)['kind'],'wait')
        self.now+=11
        self.assertEqual(self.ledger.begin('request',self.data,self.settings)['kind'],'unknown')
        self.assertEqual(self.ledger.begin('third',self.data,self.settings)['kind'],'unknown')
        self.ledger.uncertain(ticket)
        self.assertEqual(self.ledger.begin('fourth',self.data,self.settings)['kind'],'unknown')

    def test_prepared_response_restores_without_reserving_or_dispatching_again(self):
        ticket=self.dispatched(); receipt=self.ledger.prepare(ticket,self.resolved,12,{'requestId':'request'})
        again=self.ledger.begin('recovery',self.data,self.settings)
        self.assertEqual(again['kind'],'prepared'); self.assertEqual(again['receipt'],receipt)
        self.assertEqual(self.ledger.finish(again['jobId']),receipt)
        self.assertEqual(self.ledger.begin('other',self.data,self.settings)['kind'],'done')

    def test_exact_known_pending_result_replays_but_new_explicit_request_can_retry(self):
        ticket=self.dispatched(); self.ledger.prepare(ticket,self.pending,None,None); self.ledger.finish(ticket['jobId'])
        self.assertEqual(self.ledger.begin('request',self.data,self.settings)['kind'],'done')
        self.assertEqual(self.ledger.begin('explicit-retry',self.data,self.settings)['kind'],'start')
        self.assertEqual(self.ledger.begin('request',self.data,self.settings)['kind'],'done')

    def test_late_known_response_can_resolve_uncertain_job_without_a_second_call(self):
        ticket=self.dispatched(); self.ledger.uncertain(ticket); self.now+=100
        saved=self.ledger.prepare(ticket,self.resolved,1,{})
        self.assertEqual(self.ledger.begin('recovered',self.data,self.settings)['receipt'],saved)

    def test_stale_preflight_is_fenced_and_its_unspent_reservation_released(self):
        ticket=self.start(); self.ledger.reserve(ticket); self.now+=11
        next_ticket=self.start('new'); self.ledger.reserve(next_ticket)
        with self.assertRaisesRegex(ValueError,'execution-conflict'): self.ledger.dispatch(ticket)
        self.ledger.dispatch(next_ticket)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT sum(reserved>0) FROM nonword_code_budget').fetchone()[0],1)

    def test_request_reuse_with_different_answer_or_settings_is_conflict(self):
        self.start()
        for field,value in (('answer','changed'),('answerRevision',1)):
            data={**self.data,field:value}
            with self.assertRaisesRegex(ValueError,'request-conflict'): self.ledger.begin('request',data,self.settings)
        with self.assertRaisesRegex(ValueError,'request-conflict'):
            self.ledger.begin('request',self.data,{**self.settings,'revision':2})

    def test_scope_mismatch_is_refused_before_database_write(self):
        for field in ('ownerId','libraryId'):
            data=copy.deepcopy(self.data);data['binding'][field]='other'
            with self.assertRaisesRegex(ValueError,'binding'): self.ledger.begin('request',data,self.settings)
        self.assertFalse(self.path.exists())

    def test_shared_budget_counts_code_across_libraries_but_not_other_owners(self):
        ticket=self.dispatched()
        with closing(sqlite3.connect(self.path)) as db, db:
            count,tokens,active=reservation_totals(db,self.ledger.scope[0],'1970-01-01',990)
            self.assertEqual((count,active),(1,1));self.assertGreater(tokens,100)
            self.assertEqual(reservation_totals(db,'other','1970-01-01',990),(0,0,0))
        other=CodeReviewLedger(self.path,'owner','other-library',self.temp.name,clock=lambda:self.now,lease_seconds=10)
        data=copy.deepcopy(self.data)
        for key in ('binding','sourceBinding'):data[key]['libraryId']='other-library'
        next_ticket=other.begin('other',data,self.settings)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'):other.reserve(next_ticket)
        self.ledger.prepare(ticket,self.pending,1,None);self.ledger.finish(ticket['jobId'])
        other.reserve(next_ticket)

    def test_budget_is_atomic_and_cannot_be_reserved_twice(self):
        ticket=self.start();self.ledger.reserve(ticket)
        with self.assertRaisesRegex(ValueError,'budget-conflict'):self.ledger.reserve(ticket)
        other=CodeReviewLedger(self.path,'owner','library',self.temp.name,clock=lambda:self.now,lease_seconds=10)
        ticket2=other.begin('second',{**self.data,'attemptId':'second'},self.settings)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'):other.reserve(ticket2)

    def test_private_settings_snapshot_never_persists_credentials(self):
        ticket=self.ledger.begin('request',self.data,{**self.settings,'providerKey':'synthetic-do-not-store'})
        with closing(sqlite3.connect(self.path)) as db, db:
            raw=db.execute('SELECT input_json FROM nonword_code_jobs').fetchone()[0]
        self.assertNotIn('synthetic-do-not-store',raw);self.assertNotIn('providerKey',raw)
        self.ledger.abort_preflight(ticket)

    def test_corrupted_prepared_receipt_is_refused(self):
        ticket=self.dispatched();self.ledger.prepare(ticket,self.resolved,1,None)
        with closing(sqlite3.connect(self.path)) as db, db:db.execute("UPDATE nonword_code_jobs SET receipt='{}'")
        with self.assertRaisesRegex(ValueError,'integrity'):self.ledger.begin('retry',self.data,self.settings)
