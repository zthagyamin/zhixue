import copy
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import assistance_schema as schema
if importlib.util.find_spec('assistance_inbox'):
    from assistance_inbox import AssistanceInbox
else:
    AssistanceInbox = None
V = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
S = json.loads((Path(__file__).parent / 'fixtures/assistance-summary-v1.json').read_text(encoding='utf-8'))


class AssistanceInboxTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(AssistanceInbox)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'aux.db'; self.box = AssistanceInbox(self.path)
        self.record = schema.seal_account_assistance(V['records'][0], S)

    def page(self, through=1, next_cursor=None):
        return dict(summaries=[dict(sequence=1, record=copy.deepcopy(self.record), receivedAt='2026-09-01T00:00:00.000Z')], through=through, nextCursor=next_cursor)

    def test_partial_fence_is_not_processed_and_restart_keeps_complete_evidence(self):
        self.box.receive_page('owner', 'library-a', self.page(3, 1), after=0)
        self.assertEqual(self.box.pending('owner', 'library-a'), [])
        self.assertEqual(self.box.receive_page('owner', 'library-a', self.page(3, 1), after=0), 'duplicate')
        parent = V['records'][1]; body = {key: value for key, value in S.items() if key not in ('summaryId', 'summaryHash')}
        body.update(attemptEventId=parent['event']['eventId'], attemptCoreHash=parent['event']['coreHash'])
        second = schema.seal_account_assistance(parent, schema.seal_summary(body))
        self.box.receive_page('owner', 'library-a', dict(summaries=[dict(sequence=3, record=second, receivedAt='2026-09-01T00:00:00.000Z')], through=3, nextCursor=None), after=1)
        fresh = AssistanceInbox(self.path); self.assertEqual(len(fresh.pending('owner', 'library-a')), 2)
        self.assertEqual(fresh.pending('different', 'library-a'), []); self.assertEqual(fresh.cursor('owner', 'library-a')['completeThrough'], 3)

    def test_invalid_or_failed_page_does_not_advance_cursor(self):
        bad = self.page(); bad['summaries'][0]['record']['summary']['preSubmitAssistance'] = []
        with self.assertRaises(ValueError): self.box.receive_page('owner', 'library-a', bad, after=0)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TRIGGER fail_aux_cursor BEFORE INSERT ON assistance_cursors BEGIN SELECT RAISE(ABORT,'fixture'); END"); db.commit()
        with self.assertRaises(sqlite3.Error): self.box.receive_page('owner', 'library-a', self.page(), after=0)
        self.assertEqual(self.box.cursor('owner', 'library-a')['after'], 0); self.assertEqual(self.box.pending('owner', 'library-a'), [])
        for page in (self.page(2), self.page(1, 1), dict(summaries=[], through=1, nextCursor=None)):
            with self.assertRaises(ValueError): self.box.receive_page('owner', 'library-a', page, after=0)

    def test_receipts_are_separate_immutable_and_acknowledged_independently(self):
        self.box.receive_page('owner', 'library-a', self.page(), after=0)
        received = self.box.set_result('owner', 'library-a', S['summaryId'], 'received')
        proof = dict(attemptCoreHash=S['attemptCoreHash'], proofHash='a'*64, targetCount=2)
        applied = self.box.set_result('owner', 'library-a', S['summaryId'], 'applied', proof=proof)
        self.assertEqual(self.box.set_result('owner', 'library-a', S['summaryId'], 'applied', proof=proof), applied)
        self.assertNotEqual(received['receiptId'], applied['receiptId'])
        self.assertEqual(self.box.pending('owner', 'library-a'), [])
        self.box.ack_receipt('owner', 'library-a', received['receiptId'], 4)
        self.assertEqual(self.box.pending_receipts('owner', 'library-a'), [applied])
        with self.assertRaisesRegex(ValueError, 'terminal'): self.box.set_result('owner', 'library-a', S['summaryId'], 'blocked', reason='source-changed')
        with self.assertRaises(ValueError): self.box.ack_receipt('owner', 'library-a', received['receiptId'], 5)

    def test_native_receipt_uses_frozen_parent_and_cannot_acquire_another_mode_or_owner(self):
        binding = dict(schemaVersion=1, eventId=S['attemptEventId'], coreHash=S['attemptCoreHash'], contentHash='a'*64, localBindingHash='b'*64, practiceMode='three-stage')
        native = schema.seal_native_assistance(binding, S)
        route = dict(binding={'subjectId':'words'}, assistanceBinding=binding, assistanceSources={})
        self.assertEqual(self.box.receive_native('owner', native, V['records'][0]['event'], route), 'accepted')
        self.assertEqual(self.box.receive_native('owner', native, V['records'][0]['event'], route), 'duplicate')
        rows = self.box.pending('owner', 'native', channel='local'); self.assertEqual(rows[0]['parent'], V['records'][0]['event'])
        self.assertEqual(self.box.pending('other', 'native', channel='local'), [])
        with self.assertRaises(ValueError): self.box.receive_native('owner', native, V['records'][1]['event'], route)
        changed = dict(route, binding={'subjectId':'different'})
        with self.assertRaisesRegex(ValueError, 'conflict'): self.box.receive_native('owner', native, V['records'][0]['event'], changed)

    def test_a_corrupted_applied_status_cannot_hide_pending_evidence(self):
        self.box.receive_page('owner', 'library-a', self.page(), after=0)
        receipt = self.box.set_result('owner', 'library-a', S['summaryId'], 'received')
        changed = dict(receipt, status='applied', proof=dict(attemptCoreHash=S['attemptCoreHash'], proofHash='a'*64, targetCount=2))
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('UPDATE assistance_receipts SET receipt_json=?', (json.dumps(changed),)); db.commit()
        with self.assertRaisesRegex(ValueError, 'integrity'): self.box.pending('owner', 'library-a')

    def test_a_blocked_summary_cannot_starve_later_pending_records(self):
        self.box.receive_page('owner', 'library-a', self.page(), after=0)
        parent=V['records'][1]; body={key:value for key,value in S.items() if key not in ('summaryId','summaryHash')}
        body.update(attemptEventId=parent['event']['eventId'],attemptCoreHash=parent['event']['coreHash'])
        second=schema.seal_account_assistance(parent,schema.seal_summary(body))
        self.box.receive_page('owner','library-a',dict(summaries=[dict(sequence=2,record=second,receivedAt='2026-09-01T00:00:00.000Z')],through=2,nextCursor=None),after=1)
        first=self.box.pending('owner','library-a',limit=1)[0];self.box.set_result('owner','library-a',first['record']['summary']['summaryId'],'blocked',reason='source-changed')
        next_row=self.box.pending('owner','library-a',limit=1)[0];self.assertEqual(next_row['record']['summary']['summaryId'],second['summary']['summaryId'])
        self.box.set_result('owner','library-a',second['summary']['summaryId'],'blocked',reason='source-changed')
        self.assertEqual(self.box.pending('owner','library-a',limit=1)[0]['record']['summary']['summaryId'],S['summaryId'])

    def test_concurrent_initial_receive_does_not_regress_a_completed_or_blocked_receipt(self):
        self.box.receive_page('owner','library-a',self.page(),after=0)
        blocked=self.box.set_result('owner','library-a',S['summaryId'],'blocked',reason='source-changed')
        self.assertEqual(self.box.set_result('owner','library-a',S['summaryId'],'received',initial_only=True),blocked)
        applied=self.box.set_result('owner','library-a',S['summaryId'],'applied',proof=dict(attemptCoreHash=S['attemptCoreHash'],proofHash='a'*64,targetCount=2))
        self.assertEqual(self.box.set_result('owner','library-a',S['summaryId'],'received',initial_only=True),applied)
        self.assertEqual(len(self.box.pending_receipts('owner','library-a')),2)
