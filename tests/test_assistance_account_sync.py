import copy
import unittest
from pathlib import Path
import test_account_sync_writer as fixtures
import test_account_sync_worker as worker_fixtures
import assistance_schema as schema
import assistance_sync as sync
from assistance_inbox import AssistanceInbox
from assistance_writer import AssistanceVaultWriter


class AssistanceAccountSyncTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(sync,'run_account'))
        self.f=fixtures.AccountSyncWriterTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        parent=self.f.records()[0];self.f.receive([parent]);self.f.apply()
        self.aux_path=Path(self.f.temp.name)/'aux.db';self.box=AssistanceInbox(self.aux_path);self.writer=AssistanceVaultWriter(self.f.vault,self.f.owner,self.aux_path)
        summary=schema.seal_summary(dict(schemaVersion=1,attemptEventId=parent['event']['eventId'],attemptCoreHash=parent['event']['coreHash'],practiceMode=parent['practiceMode'],observationScope='current-page-attempt',preSubmitAssistance=[],postSubmitFeedback=[]))
        self.record=schema.seal_account_assistance(parent,summary);self.calls=[];self.receipts={};self.fail_receipt=False;self.bad_receipt=False

    def call(self,method,action,*,params=None,payload=None):
        self.calls.append((method,action,copy.deepcopy(params),copy.deepcopy(payload)))
        if action=='bootstrap':return dict(apiVersion=1,enabled=True,profile={'libraryId':'library-a'},capabilities=[sync.CAPABILITY],assistanceFences={'summaries':1,'receipts':0})
        if action=='assistance':
            self.assertEqual(params['limit'],20)
            return dict(summaries=[dict(sequence=1,record=self.record,receivedAt='2026-09-01T00:00:00.000Z')] if params['after']==0 else [],through=1,nextCursor=None)
        if action=='assistance-receipt':
            if self.fail_receipt:raise OSError('offline')
            receipt=payload['receipt'];key=receipt['receiptId'];old=self.receipts.get(key)
            if old is None:self.receipts[key]=dict(sequence=len(self.receipts)+1,receipt=copy.deepcopy(receipt))
            result=copy.deepcopy(self.receipts[key])
            if self.bad_receipt:result['receipt']['summaryHash']='f'*64
            return dict(status='duplicate' if old else 'accepted',receipt=result)
        raise AssertionError(action)

    def run_sync(self):return sync.run_account(self.f.owner,'library-a',self.box,self.writer,self.f.writer,self.call)

    def test_complete_account_chain_and_noop_retry_do_not_duplicate_files_or_attempts(self):
        result=self.run_sync();self.assertEqual(result['status'],'synced');self.assertEqual(len(self.receipts),2)
        self.assertEqual(self.box.pending_receipts(self.f.owner,'library-a'),[])
        count=len(list((self.f.vault/self.f.root/'records/assistance').rglob('*.json')));self.assertEqual(count,1)
        self.run_sync();self.assertEqual(len(self.receipts),2);self.assertEqual(len(self.f.inbox.records_through(self.f.owner,'library-a')),1)

    def test_written_summary_retries_its_own_receipt_after_restart(self):
        self.fail_receipt=True
        with self.assertRaises(OSError):self.run_sync()
        self.assertEqual(len(self.box.pending_receipts(self.f.owner,'library-a')),2)
        self.box=AssistanceInbox(self.aux_path);self.writer=AssistanceVaultWriter(self.f.vault,self.f.owner,self.aux_path);self.fail_receipt=False
        self.assertEqual(self.run_sync()['status'],'synced');self.assertEqual(self.box.pending_receipts(self.f.owner,'library-a'),[])

    def test_wrong_cloud_acknowledgement_does_not_clear_auxiliary_outbox(self):
        self.bad_receipt=True
        with self.assertRaises(ValueError):self.run_sync()
        self.assertEqual(len(self.box.pending_receipts(self.f.owner,'library-a')),2)

    def test_old_cloud_without_capability_does_not_receive_new_actions(self):
        calls=[]
        def old(method,action,**_):calls.append(action);return dict(apiVersion=1,enabled=True,profile={'libraryId':'library-a'})
        self.assertEqual(sync.run_account(self.f.owner,'library-a',self.box,self.writer,self.f.writer,old),{'status':'unsupported'})
        self.assertEqual(calls,['bootstrap']);self.assertEqual(self.box.cursor(self.f.owner,'library-a')['after'],0)


class AssistanceWorkerIsolationTests(unittest.TestCase):
    def test_auxiliary_failure_does_not_skip_existing_plan_or_content_sync(self):
        f=worker_fixtures.AccountSyncWorkerTests();f.setUp();self.addCleanup(f.doCleanups)
        called=[]
        def broken(call,max_pages):called.append(max_pages);raise OSError('auxiliary offline')
        f.sync.assistance_sync=broken;f.sync.activate();result=f.sync.run_once()
        self.assertEqual(called,[3]);self.assertEqual(result['status'],'synced');self.assertEqual(result['assistance']['status'],'retry')
        actions=[call[2] for call in f.cloud.calls];self.assertIn('plan-operations',actions);self.assertIn('content-decisions',actions)
