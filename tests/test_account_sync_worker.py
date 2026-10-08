import copy
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from account_sync_credentials import LinkStore
from account_sync_inbox import Inbox
from test_account_sync_credentials import FakeKeyring
if importlib.util.find_spec('account_sync_worker'):
    import account_sync_worker as worker
else:
    worker = None

V = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
PV = json.loads((Path(__file__).parent / 'fixtures/account-planning-v1.json').read_text(encoding='utf-8'))
ORIGIN = 'https://study.example.test'


class FakeCloud:
    def __init__(self):
        self.info = {'kind': 'device', 'userId': 'cloud-user-a', 'libraryId': 'library-a', 'grantId': 'grant-one',
                     'state': 'pending', 'expiresAt': '2026-10-01T00:00:00.000Z'}
        self.calls = []; self.pages = []; self.receipts = {}; self.snapshot = None; self.staged = {}; self.fail_action = None;self.plan_pages=[];self.plan_receipts={};self.content_pages=[];self.content_receipts={}

    def request(self, method, origin, secret, action, *, params=None, payload=None):
        self.calls.append((method, origin, action, copy.deepcopy(params), copy.deepcopy(payload)))
        if self.fail_action == action: raise OSError('simulated offline')
        if action == 'grant-info': return copy.deepcopy(self.info)
        if action == 'activate-grant': self.info['state'] = 'active'; return copy.deepcopy(self.info)
        if action == 'bootstrap': return {'apiVersion': 1, 'enabled': True, 'profile': {'libraryId': self.info['libraryId'], 'revision': 1}, 'snapshot': copy.deepcopy(self.snapshot)}
        if action == 'records': return copy.deepcopy(self.pages.pop(0) if self.pages else {'records': [], 'through': params['after'], 'nextCursor': None})
        if action == 'plan-operations': return copy.deepcopy(self.plan_pages.pop(0) if self.plan_pages else {'operations': [], 'through': params['after'], 'nextCursor': None})
        if action == 'content-decisions': return copy.deepcopy(self.content_pages.pop(0) if self.content_pages else {'operations': [], 'through': params['after'], 'nextCursor': None})
        if action == 'writeback-receipt':
            receipt = payload['receipt']; receipt_id = receipt['receiptId']
            old = self.receipts.get(receipt_id)
            if not old: self.receipts[receipt_id] = {'sequence': len(self.receipts) + 1, 'receipt': copy.deepcopy(receipt)}
            return {'status': 'duplicate' if old else 'accepted', 'receipt': copy.deepcopy(self.receipts[receipt_id])}
        if action == 'begin-snapshot': self.staged['snapshot'] = copy.deepcopy(payload['snapshot']); return {'accepted': True}
        if action == 'stage-items': self.staged.setdefault('items', {}).update({e['position']: e['item'] for e in payload['entries']}); return {'accepted': True}
        if action == 'complete-snapshot': self.snapshot = copy.deepcopy(self.staged['snapshot']); return {'status': 'accepted', 'revision': self.snapshot['revision']}
        if action == 'publish-planning-catalog': self.planning = copy.deepcopy(payload['catalog']); return {'status': 'accepted'}
        if action == 'publish-planning-facts': self.planning_facts = copy.deepcopy(payload['facts']); return {'status': 'accepted'}
        if action == 'claim-plan-operation': return {'status':'accepted','operationId':payload['operationId'],'leaseUntil':'2026-09-01T00:05:00.000Z'}
        if action == 'plan-execution-receipt':
            receipt=payload['receipt'];old=self.plan_receipts.get(receipt['receiptId'])
            if not old:self.plan_receipts[receipt['receiptId']]={'sequence':len(self.plan_receipts)+1,'receipt':copy.deepcopy(receipt)}
            return {'status':'duplicate' if old else 'accepted','execution':copy.deepcopy(self.plan_receipts[receipt['receiptId']])}
        if action == 'content-decision-receipt':
            receipt=payload['receipt'];old=self.content_receipts.get(receipt['receiptId'])
            if not old:self.content_receipts[receipt['receiptId']]={'sequence':len(self.content_receipts)+1,'receipt':copy.deepcopy(receipt)}
            return {'status':'duplicate' if old else 'accepted','execution':copy.deepcopy(self.content_receipts[receipt['receiptId']])}
        if action == 'manifest': return copy.deepcopy(self.snapshot)
        raise AssertionError(action)


class AccountSyncWorkerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(worker, 'Independent background sync must exist')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name); self.owner = 'a' * 64
        self.links = LinkStore(path / 'links.sqlite3', FakeKeyring(), allowed_origins=[ORIGIN])
        self.links.prepare(self.owner, 'library-a', ORIGIN, 'Computer', grant_id='grant-one')
        self.inbox = Inbox(path / 'inbox.sqlite3'); self.cloud = FakeCloud(); self.processed = []; self.stop = threading.Event()
        self.sync = worker.BackgroundSync(self.owner, 'grant-one', self.links, self.inbox, self.cloud,
            verify_owner=lambda user_id: user_id == 'cloud-user-a', processor=self.process,
            clock=lambda: datetime(2026, 9, 1, tzinfo=timezone.utc), stop_event=self.stop)

    def process(self, records, pending):
        self.processed.append(copy.deepcopy(records))
        return [{'eventId': row['record']['event']['eventId'], 'status': 'blocked', 'reason': 'mapping-missing'} for row in pending]

    def test_http_transport_identifies_companion_to_avoid_edge_browser_signature_block(self):
        class Response:
            status = 200
            def __init__(self, url):
                self.url = url; self.headers = Message(); self.headers['Content-Type'] = 'application/json'
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def geturl(self): return self.url
            def read(self, _limit): return b'{}'
        class Opener:
            request = None
            def open(self, request, timeout):
                self.request = request; return Response(request.full_url)
        opener = Opener()
        transport = worker.HttpTransport([ORIGIN], opener=opener)
        self.assertEqual(transport.request('GET', ORIGIN, 's' * 43, 'grant-info'), {})
        self.assertEqual(opener.request.get_header('User-agent'), 'ZhixueCompanion/1')

    def page(self, indexes, through=3, next_cursor=None):
        return {'records': [{'sequence': i + 1, 'record': copy.deepcopy(V['records'][i])} for i in indexes], 'through': through, 'nextCursor': next_cursor}

    def test_prepare_is_inert_and_only_verified_activation_enables_worker(self):
        self.assertEqual(self.sync.run_once()['status'], 'not-started')
        self.assertEqual(self.cloud.calls, [])
        self.sync.activate()
        self.assertEqual(self.links.list_links(self.owner)[0]['state'], 'active')
        self.assertEqual([c[2] for c in self.cloud.calls], ['grant-info', 'activate-grant'])

    def test_wrong_owner_library_grant_or_expiry_never_activates(self):
        for field, value in (('userId', 'another-account'), ('libraryId', 'another-library'), ('grantId', 'another-grant'), ('expiresAt', '2026-08-31T00:00:00.000Z')):
            original = self.cloud.info[field]; self.cloud.info[field] = value
            with self.assertRaises(ValueError): self.sync.activate()
            self.cloud.info[field] = original
        self.assertNotIn('activate-grant', [c[2] for c in self.cloud.calls])
        self.assertEqual(self.links.list_links(self.owner)[0]['state'], 'prepared')

    def test_incomplete_fence_never_reaches_processor_and_resumes_on_next_tick(self):
        self.sync.activate(); self.cloud.pages = [self.page((0,), next_cursor=1), self.page((1, 2))]
        self.assertEqual(self.sync.run_once(max_pages=1)['status'], 'downloading')
        self.assertEqual(self.processed, [])
        self.assertEqual(self.sync.run_once(max_pages=1)['status'], 'synced')
        self.assertEqual(len(self.processed[0]), 3)
        requests = [c[3] for c in self.cloud.calls if c[2] == 'records']
        self.assertNotIn('through', requests[0]); self.assertEqual(requests[1]['through'], 3)
        self.assertEqual(len(self.cloud.receipts), 3)

    def test_failed_receipt_transport_keeps_raw_records_and_outbox_for_retry(self):
        self.sync.activate(); self.cloud.pages = [self.page((0, 1, 2))]; self.cloud.fail_action = 'writeback-receipt'
        self.assertEqual(self.sync.run_once()['status'], 'retry')
        self.assertEqual(len(self.inbox.pending_records(self.owner, 'library-a')), 3)
        self.assertEqual(len(self.inbox.pending_receipts(self.owner, 'library-a')), 3)
        self.cloud.fail_action = None
        self.assertEqual(self.sync.run_once()['status'], 'synced')
        self.assertEqual(len(self.cloud.receipts), 3)
        self.assertEqual(self.inbox.pending_receipts(self.owner, 'library-a'), [])

    def test_lost_ack_retries_same_receipt_without_second_cloud_write(self):
        self.sync.activate(); self.cloud.pages = [self.page((0,), through=1)]
        original = self.cloud.request
        def lose_ack(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[3] == 'writeback-receipt': self.cloud.request = original; raise OSError('lost ack')
            return result
        self.cloud.request = lose_ack
        self.assertEqual(self.sync.run_once()['status'], 'retry')
        self.assertEqual(len(self.cloud.receipts), 1)
        self.sync.run_once(); self.assertEqual(len(self.cloud.receipts), 1)
        self.assertEqual(self.inbox.pending_receipts(self.owner, 'library-a'), [])

    def test_revocation_pauses_without_clearing_evidence(self):
        self.sync.activate(); self.inbox.receive_page(self.owner, 'library-a', self.page((0,), through=1))
        def revoked(*args, **kwargs): raise worker.CloudFailure(401, 'authentication-required')
        self.cloud.request = revoked
        self.assertEqual(self.sync.run_once()['status'], 'paused')
        self.assertEqual(len(self.inbox.pending_records(self.owner, 'library-a')), 1)
        self.assertEqual(self.links.list_links(self.owner)[0]['state'], 'paused')

    def test_stop_before_start_or_during_download_prevents_any_projection(self):
        self.sync.activate(); self.stop.set()
        self.assertEqual(self.sync.run_once()['status'], 'stopped')
        self.stop.clear(); original = self.cloud.request
        def stopping(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[3] == 'records': self.stop.set()
            return result
        self.cloud.request = stopping; self.cloud.pages = [self.page((0,), through=1)]
        self.assertEqual(self.sync.run_once()['status'], 'stopped')
        self.assertEqual(self.processed, [])

    def test_publication_is_persisted_then_staged_and_resumable(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        self.inbox.start_publication(self.owner, V['bundle'], bindings, 0); self.sync.activate()
        self.cloud.fail_action = 'stage-items'
        self.assertEqual(self.sync.run_once()['status'], 'retry')
        self.assertTrue(self.inbox.pending_publication(self.owner, 'library-a')['begun'])
        self.cloud.fail_action = None
        self.sync.run_once()
        self.assertEqual(self.cloud.snapshot, V['bundle']['snapshot'])
        self.assertIsNone(self.inbox.pending_publication(self.owner, 'library-a'))
        self.assertEqual(sum(c[2] == 'begin-snapshot' for c in self.cloud.calls), 1)

    def test_malformed_nested_response_is_reported_without_killing_worker(self):
        self.sync.activate(); self.sync.publisher = lambda snapshot: None
        original = self.cloud.request
        def malformed(*args, **kwargs):
            if args[3] == 'bootstrap': return {'apiVersion': 1, 'enabled': True, 'profile': []}
            return original(*args, **kwargs)
        self.cloud.request = malformed
        self.assertIn(self.sync.run_once()['status'], ('partial', 'blocked', 'paused'))
        self.sync.publisher = None; self.links.mark_state(self.owner, 'grant-one', 'active')
        def bad_receipt(*args, **kwargs):
            if args[3] == 'writeback-receipt': return {'status': 'accepted', 'receipt': []}
            return original(*args, **kwargs)
        self.cloud.request = bad_receipt; self.cloud.pages = [self.page((0,), through=1)]
        self.assertEqual(self.sync.run_once()['status'], 'blocked')
        self.assertEqual(len(self.inbox.pending_receipts(self.owner, 'library-a')), 1)

    def test_permanent_publication_conflict_does_not_starve_existing_receipts(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        self.inbox.start_publication(self.owner, V['bundle'], bindings, 0)
        self.inbox.receive_page(self.owner, 'library-a', self.page((0,), through=1))
        self.inbox.set_result(self.owner, 'library-a', 'event-one', 'blocked', reason='mapping-missing')
        self.sync.activate(); original = self.cloud.request
        def conflict(*args, **kwargs):
            if args[3] == 'begin-snapshot': raise worker.CloudFailure(409, 'study-snapshot-conflict')
            return original(*args, **kwargs)
        self.cloud.request = conflict
        self.assertEqual(self.sync.run_once()['status'], 'partial')
        self.assertEqual(self.inbox.pending_receipts(self.owner, 'library-a'), [])
        self.assertEqual(len(self.cloud.receipts), 1)

    def test_published_history_retry_accepts_matching_manifest_with_newer_head(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        self.inbox.start_publication(self.owner, V['bundle'], bindings, 0)
        self.sync.activate(); original = self.cloud.request
        def history(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[3] == 'complete-snapshot': return {'status': 'duplicate', 'revision': 2}
            return result
        self.cloud.request = history
        self.assertEqual(self.sync.run_once()['status'], 'synced')
        self.assertIsNone(self.inbox.pending_publication(self.owner, 'library-a'))

    def test_approved_plan_operation_executes_and_receipt_survives_cloud_ack_retry(self):
        self.sync.activate();plan=PV['cloudPlan'];operation={'sequence':1,'operationId':'approve-one','day':plan['day'],'action':'approve','plan':plan,
            'predecessorOperationId':None,'stateRevision':2,'receivedAt':'2026-09-01T00:00:00.000Z'}
        self.cloud.plan_pages=[{'operations':[operation],'through':1,'nextCursor':None}]
        self.sync.plan_processor=lambda operations:[{'operationId':'approve-one','cloudPlanHash':plan['cloudPlanHash'],'status':'applied',
            'proof':{'cloudPlanHash':plan['cloudPlanHash'],'nativePlanHash':'e'*64,'localRevision':1,'proofHash':'f'*64,'targetCount':1}}]
        self.assertEqual(self.sync.run_once()['status'],'synced');self.assertEqual(len(self.cloud.plan_receipts),1)
        self.assertEqual(self.inbox.pending_plan_receipts(self.owner,'library-a'),[])

    def test_content_decision_executes_without_cloud_path_and_returns_receipt(self):
        self.sync.activate();operation={'sequence':1,'operationId':'content-one','factsHash':'a'*64,'candidateId':'candidate-one','contentHash':'b'*64,'decision':'approved','status':'pending','receivedAt':'2026-09-01T00:00:00.000Z'}
        self.cloud.content_pages=[{'operations':[operation],'through':1,'nextCursor':None}]
        self.sync.content_processor=lambda operations:[{'schemaVersion':1,'receiptId':'content-receipt-one','operationId':'content-one','candidateId':'candidate-one','contentHash':'b'*64,'decision':'approved','status':'applied','proofHash':'c'*64}]
        self.assertEqual(self.sync.run_once()['status'],'synced');self.assertEqual(len(self.cloud.content_receipts),1);self.assertNotIn('path',self.cloud.content_receipts['content-receipt-one']['receipt'])

    def test_facts_only_planning_outbox_drains_without_a_content_publication_job(self):
        self.sync.activate();calls=[];catalog={'snapshotId':'snapshot-a','catalogHash':'a'*64};facts={'factsHash':'b'*64}
        self.inbox.pending_publication=lambda *_:None;self.inbox.pending_planning=lambda *_:{'catalog':catalog,'facts':facts,'catalogPending':False}
        self.inbox.ack_planning=lambda *args:calls.append(args)
        self.assertEqual(self.sync.run_once()['status'],'synced');self.assertEqual(self.cloud.planning_facts,facts);self.assertEqual(len(calls),1)


if __name__ == '__main__': unittest.main()
