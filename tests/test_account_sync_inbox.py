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
import account_sync_schema as schema
import account_sync_planning as planning
if importlib.util.find_spec('account_sync_inbox'):
    from account_sync_inbox import Inbox
else:
    Inbox = None

V = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
PV = json.loads((Path(__file__).parent / 'fixtures/account-planning-v1.json').read_text(encoding='utf-8'))


class AccountSyncInboxTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Inbox, 'Durable isolated account inbox must exist')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'inbox.sqlite3'
        self.box = Inbox(self.path)

    def page(self, indexes=(0, 1, 2), through=3, next_cursor=None):
        return {'records': [{'sequence': i + 1, 'record': copy.deepcopy(V['records'][i])} for i in indexes],
                'through': through, 'nextCursor': next_cursor}

    def test_scope_and_restart_preserve_raw_evidence(self):
        self.assertEqual(self.box.receive_page('account-a', 'library-a', self.page()), 'accepted')
        self.assertEqual(Inbox(self.path).cursor('account-a', 'library-a'), {'after': 3, 'through': None, 'completeThrough': 3})
        rows = self.box.pending_records('account-a', 'library-a')
        self.assertEqual([r['record'] for r in rows], V['records'])
        self.assertEqual(self.box.pending_records('account-b', 'library-a'), [])
        self.assertEqual(self.box.pending_records('account-a', 'library-b'), [])

    def test_no_projection_before_fence_completes_and_stable_retry(self):
        first = self.page((0,), through=3, next_cursor=1)
        self.box.receive_page('account-a', 'library-a', first, after=0)
        self.assertEqual(self.box.pending_records('account-a', 'library-a'), [])
        self.assertEqual(self.box.cursor('account-a', 'library-a'), {'after': 1, 'through': 3, 'completeThrough': 0})
        self.assertEqual(self.box.receive_page('account-a', 'library-a', first, after=0), 'duplicate')
        self.box.receive_page('account-a', 'library-a', self.page((1, 2)), after=1)
        self.assertEqual(len(self.box.pending_records('account-a', 'library-a')), 3)

    def test_all_page_members_validate_before_cursor_advances(self):
        page = self.page(); page['records'][1]['record']['event']['coreHash'] = 'f' * 64
        with self.assertRaises(ValueError): self.box.receive_page('account-a', 'library-a', page)
        self.assertEqual(self.box.cursor('account-a', 'library-a')['after'], 0)
        self.assertEqual(self.box.pending_records('account-a', 'library-a'), [])

    def test_wrong_scope_order_early_end_and_changed_fence_reject(self):
        with self.assertRaises(ValueError): self.box.receive_page('account-a', 'other-library', self.page())
        for page in (self.page((1, 0, 2)), self.page((0,), through=3), self.page((0,), next_cursor=2), self.page((), through=3)):
            with self.assertRaises(ValueError): self.box.receive_page('account-a', 'library-a', page)
        self.box.receive_page('account-a', 'library-a', self.page((0,), next_cursor=1))
        with self.assertRaises(ValueError): self.box.receive_page('account-a', 'library-a', self.page((1,), through=2))
        self.assertEqual(self.box.cursor('account-a', 'library-a')['after'], 1)

    def test_same_event_changed_envelope_or_sequence_is_conflict(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        page = self.page((0,), through=4); page['records'][0]['sequence'] = 4
        with self.assertRaises(ValueError): self.box.receive_page('account-a', 'library-a', page, after=3)
        page['records'][0]['record']['roundId'] = 'another-round'
        record = page['records'][0]['record']; record['envelopeHash'] = schema.study_hash({k: v for k, v in record.items() if k != 'envelopeHash'})
        with self.assertRaises(ValueError): self.box.receive_page('account-a', 'library-a', page, after=3)
        self.assertEqual(len(self.box.pending_records('account-a', 'library-a')), 3)

    def test_sql_abort_rolls_back_rows_page_and_cursor(self):
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("CREATE TRIGGER fail_second BEFORE INSERT ON account_inbox_records WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.box.receive_page('account-a', 'library-a', self.page())
        self.assertEqual(self.box.cursor('account-a', 'library-a')['after'], 0)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM account_inbox_records').fetchone()[0], 0)

    def test_concurrent_handles_cannot_move_cursor_backwards(self):
        other = Inbox(self.path)
        self.box.receive_page('account-a', 'library-a', self.page())
        self.assertEqual(other.receive_page('account-a', 'library-a', self.page(), after=0), 'duplicate')
        with self.assertRaises(ValueError): other.receive_page('account-a', 'library-a', self.page((0,), through=1), after=0)
        self.assertEqual(other.cursor('account-a', 'library-a')['after'], 3)

    def test_receipt_outbox_independent_from_download_and_applied_proof_required(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        with self.assertRaises(ValueError): self.box.set_result('account-a', 'library-a', 'event-three', 'applied')
        proof = {'coreHash': V['records'][2]['event']['coreHash'], 'proofHash': 'b' * 64, 'targetCount': 2}
        receipt = self.box.set_result('account-a', 'library-a', 'event-three', 'applied', proof=proof)
        self.assertEqual(self.box.set_result('account-a', 'library-a', 'event-three', 'applied', proof=proof), receipt)
        self.assertEqual(len(self.box.pending_records('account-a', 'library-a')), 2)
        self.assertEqual(Inbox(self.path).pending_receipts('account-a', 'library-a'), [receipt])
        with self.assertRaises(ValueError): self.box.set_result('account-a', 'library-a', 'event-three', 'received')
        with self.assertRaises(ValueError): self.box.ack_receipt('account-b', 'library-a', receipt['receiptId'], 1)
        self.box.ack_receipt('account-a', 'library-a', receipt['receiptId'], 1)
        self.assertEqual(self.box.pending_receipts('account-a', 'library-a'), [])
        self.assertEqual(self.box.cursor('account-a', 'library-a')['after'], 3)

    def test_received_and_blocked_do_not_drop_pending_evidence(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        self.box.set_result('account-a', 'library-a', 'event-one', 'received')
        self.box.set_result('account-a', 'library-a', 'event-one', 'blocked', reason='source-changed')
        self.assertEqual(len(self.box.pending_records('account-a', 'library-a')), 3)
        self.assertEqual(len(self.box.pending_receipts('account-a', 'library-a')), 2)

    def test_snapshot_and_private_bindings_are_immutable_and_scoped(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {'sourceNote': 'subjects/source.md'}} for i in V['bundle']['items']}
        self.assertEqual(self.box.save_export('account-a', V['bundle'], bindings), 'accepted')
        self.assertEqual(self.box.save_export('account-a', V['bundle'], bindings), 'duplicate')
        saved = Inbox(self.path).get_export('account-a', 'library-a', 'snapshot-a')
        self.assertEqual(saved, {'bundle': V['bundle'], 'bindings': bindings})
        self.assertIsNone(self.box.get_export('account-b', 'library-a', 'snapshot-a'))
        bindings['word:tree']['binding']['sourceNote'] = 'elsewhere.md'
        with self.assertRaises(ValueError): self.box.save_export('account-a', V['bundle'], bindings)

    def test_corrupt_storage_is_not_returned_as_valid(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("UPDATE account_inbox_records SET envelope_hash=? WHERE event_id=?", ('f' * 64, 'event-one'))
        with self.assertRaises(ValueError): self.box.pending_records('account-a', 'library-a')

    def test_stored_status_requires_matching_verified_receipt(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("UPDATE account_inbox_records SET status='applied' WHERE event_id='event-one'")
        with self.assertRaises(ValueError): self.box.pending_records('account-a', 'library-a')
        with self.assertRaises(ValueError): self.box.set_result('account-a', 'library-a', 'event-one', 'received')

    def test_repeated_block_after_another_block_gets_new_delivery(self):
        self.box.receive_page('account-a', 'library-a', self.page())
        first = self.box.set_result('account-a', 'library-a', 'event-one', 'blocked', reason='source-changed')
        self.box.ack_receipt('account-a', 'library-a', first['receiptId'], 1)
        second = self.box.set_result('account-a', 'library-a', 'event-one', 'blocked', reason='mapping-missing')
        self.box.ack_receipt('account-a', 'library-a', second['receiptId'], 2)
        third = self.box.set_result('account-a', 'library-a', 'event-one', 'blocked', reason='source-changed')
        self.assertNotEqual(first['receiptId'], third['receiptId'])
        self.assertEqual(self.box.pending_receipts('account-a', 'library-a'), [third])
        self.assertEqual(self.box.set_result('account-a', 'library-a', 'event-one', 'blocked', reason='source-changed'), third)

    def test_export_duplicate_cannot_hide_changed_metadata(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        self.box.save_export('account-a', V['bundle'], bindings)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute('UPDATE account_inbox_exports SET revision=999')
        with self.assertRaises(ValueError): self.box.save_export('account-a', V['bundle'], bindings)

    def test_staged_publication_resumes_without_reallocating_snapshot(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        self.box.start_publication('account-a', V['bundle'], bindings, 0)
        job = self.box.pending_publication('account-a', 'library-a')
        self.assertEqual((job['begun'], job['position'], job['expectedRevision']), (False, 0, 0))
        self.box.advance_publication('account-a', 'library-a', 'snapshot-a', job, begun=True, position=1)
        resumed = Inbox(self.path).pending_publication('account-a', 'library-a')
        self.assertEqual((resumed['begun'], resumed['position']), (True, 1))
        self.box.start_publication('account-a', V['bundle'], bindings, 0)
        self.assertEqual(self.box.pending_publication('account-a', 'library-a')['position'], 1)
        with self.assertRaises(ValueError): self.box.advance_publication('account-a', 'library-a', 'snapshot-a', job, begun=True, position=2)
        self.box.advance_publication('account-a', 'library-a', 'snapshot-a', resumed, begun=True, position=2, complete=True)
        self.assertIsNone(self.box.pending_publication('account-a', 'library-a'))
        self.assertEqual(self.box.get_export('account-a', 'library-a', 'snapshot-a')['bundle'], V['bundle'])

    def test_failed_publication_intent_does_not_leave_an_orphan_revision(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TRIGGER fail_publication BEFORE INSERT ON account_inbox_publications BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.box.start_publication('account-a', V['bundle'], bindings, 0)
        self.assertIsNone(self.box.get_export('account-a', 'library-a', 'snapshot-a'))

    def test_planning_export_waits_for_content_publication_and_retries_lost_ack(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        partial = {'schemaVersion': 1, 'libraryId': 'library-a', 'snapshotId': 'snapshot-a', 'subjects': [], 'practiceSources': [], 'diagnostics': [], 'contentRefs': {}}
        body = {**partial, 'sourceHash': schema.study_hash(partial)}; catalog = {**body, 'catalogHash': schema.study_hash(body)}
        planning.validate_planning_catalog(catalog)
        self.box.start_publication('account-a', V['bundle'], bindings, 0, planning=(catalog, {}))
        self.assertIsNone(self.box.pending_planning('account-a', 'library-a'))
        job = self.box.pending_publication('account-a', 'library-a')
        self.box.advance_publication('account-a', 'library-a', 'snapshot-a', job, begun=True, position=2, complete=True)
        pending = self.box.pending_planning('account-a', 'library-a'); self.assertEqual(pending, {'catalog': catalog, 'materials': {}, 'routes': {}, 'catalogPending': True})
        self.box.ack_planning('account-a', 'library-a', 'snapshot-a', catalog['catalogHash'])
        self.assertIsNone(Inbox(self.path).pending_planning('account-a', 'library-a'))

    def test_planning_facts_survive_material_normalization(self):
        bindings = {i['itemKey']: {'contentHash': i['contentHash'], 'binding': {}} for i in V['bundle']['items']}
        routes = {subject['subjectId']: {
            'id': subject['subjectId'],
            'contentRoot': f"Subjects/{subject['subjectId']}/Content",
            'recordsRoot': f"Subjects/{subject['subjectId']}/Records",
            'progressRef': f"Subjects/{subject['subjectId']}/Progress.md",
        } for subject in PV['catalog']['subjects']}
        self.box.start_publication(
            'account-a', V['bundle'], bindings, 0,
            planning=(PV['catalog'], PV['materials'], PV['facts'], routes),
        )
        job = self.box.pending_publication('account-a', 'library-a')
        self.box.advance_publication('account-a', 'library-a', 'snapshot-a', job, begun=True, position=2, complete=True)
        pending = self.box.pending_planning('account-a', 'library-a')
        self.assertEqual(pending['facts'], PV['facts'])

    def test_cancel_control_record_prevents_pending_approval_execution(self):
        plan=PV['cloudPlan']
        approve={'sequence':1,'operationId':'approve-cancelled','day':plan['day'],'action':'approve','plan':plan,'predecessorOperationId':None,'stateRevision':1,'receivedAt':'2026-09-01T00:00:00.000Z'}
        cancel={'sequence':2,'operationId':'cancel-control','day':plan['day'],'action':'cancel','plan':plan,'predecessorOperationId':'approve-cancelled','stateRevision':2,'receivedAt':'2026-09-01T00:01:00.000Z'}
        self.box.receive_plan_page('account-a','library-a',{'operations':[approve,cancel],'through':2,'nextCursor':None},after=0)
        self.assertEqual(self.box.pending_plan_operations('account-a','library-a'),[])
        with closing(sqlite3.connect(self.path)) as db:
            status=db.execute("SELECT status FROM account_inbox_plan_operations WHERE operation_id='approve-cancelled'").fetchone()[0]
        self.assertEqual(status,'cancelled')


if __name__ == '__main__': unittest.main()
