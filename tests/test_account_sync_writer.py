"""Real file acceptance tests: no installed Companion or actual Vault access."""
import copy
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_schema as schema
import task_events
import account_sync_export as exporter
from account_sync_inbox import Inbox
import test_index_gateway as fixtures
if importlib.util.find_spec('account_sync_writer'):
    from account_sync_writer import VerifiedVaultWriter
else:
    VerifiedVaultWriter = None

V = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
PV = json.loads((Path(__file__).parent / 'fixtures/account-planning-v1.json').read_text(encoding='utf-8'))


class AccountSyncWriterTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(VerifiedVaultWriter, 'Verified recoverable file writer must exist')
        self.fixture = fixtures.IndexGatewayTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.vault = self.fixture.vault; self.owner = 'a' * 64
        self.inbox = Inbox(Path(self.temp.name) / 'inbox.sqlite3')
        self.ledger = Path(self.temp.name) / 'writeback.sqlite3'
        self.root = self.fixture.subject('words', 'three-stage')
        index = self.vault / self.fixture.entry / 'subjects/words.md'
        index.write_text(index.read_text(encoding='utf-8').replace('enabled: true', 'language: en\nenabled: true'), encoding='utf-8')
        self.source = self.fixture.write(self.root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning | example |\n|---|---|---|\n| Tree | 树 | A tree grows here. |\n')
        self.writer = VerifiedVaultWriter(self.vault, self.owner, self.inbox, self.ledger)
        self.capture()

    def capture(self, snapshot_id='snapshot-a', revision=1):
        catalog, identities = exporter.capture_catalog(self.vault)
        self.bundle, self.bindings = exporter.export_catalog(catalog, identities, 'library-a', snapshot_id, revision, '2026-09-01T00:00:00.000Z')
        self.inbox.save_export(self.owner, self.bundle, self.bindings)
        self.writer.prepare_snapshot(self.bundle, self.bindings)

    def records(self):
        result = copy.deepcopy(V['records']); item = self.bundle['items'][0]
        for record in result:
            record['snapshotId'] = self.bundle['snapshot']['snapshotId']
            record['contentHash'] = item['contentHash']; record['event']['item']['key'] = item['itemKey']
            record['event']['coreHash'] = schema.study_hash({k: v for k, v in record['event'].items() if k != 'coreHash'})
            record['envelopeHash'] = schema.study_hash({k: v for k, v in record.items() if k != 'envelopeHash'})
        return result

    def receive(self, records, after=0):
        self.inbox.receive_page(self.owner, 'library-a', {'records': [{'sequence': after + i + 1, 'record': r} for i, r in enumerate(records)], 'through': after + len(records), 'nextCursor': None}, after=after)

    def apply(self):
        rows = self.inbox.records_through(self.owner, 'library-a')
        results = self.writer.process(rows, [row for row in rows if row['status'] != 'applied'])
        for result in results:
            self.inbox.set_result(self.owner, 'library-a', result['eventId'], result['status'], reason=result.get('reason'), proof=result.get('proof'))
        return results

    def test_actual_journal_state_readback_preserves_source_and_legacy_feed(self):
        before = self.source.read_bytes(); records = self.records(); self.receive(records)
        results = self.apply()
        self.assertEqual([result['status'] for result in results], ['applied'] * 3)
        journals = list((self.vault / self.root / 'records/account-study').rglob('*.json'))
        self.assertEqual(len(journals), 3)
        self.assertEqual({json.loads(p.read_text(encoding='utf-8'))['record']['envelopeHash'] for p in journals}, {r['envelopeHash'] for r in records})
        text = (self.vault / self.root / 'state.md').read_text(encoding='utf-8')
        self.assertIn('event-three', text); self.assertNotIn('event-one', text); self.assertNotIn('mastered', text)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(fixtures.gateway.progress_events(self.vault, fixtures.gateway.load_gateway(self.vault), self.owner), [])
        self.assertTrue(all(result['proof']['targetCount'] >= 1 for result in results))

    def test_source_change_blocks_without_altering_source_or_state(self):
        self.receive(self.records()); self.source.write_text(self.source.read_text(encoding='utf-8').replace('树', 'Changed meaning'), encoding='utf-8')
        before = {p: p.read_bytes() for p in self.vault.rglob('*.md')}
        results = self.apply()
        self.assertTrue(all(result['status'] == 'blocked' for result in results))
        self.assertEqual(results[0]['reason'], 'source-changed')
        self.assertEqual({p: p.read_bytes() for p in self.vault.rglob('*.md')}, before)

    def test_unchanged_vocabulary_survives_unrelated_source_additions(self):
        self.receive(self.records())
        self.source.write_text(self.source.read_text(encoding='utf-8') + '| River | 河流 | A river flows. |\n', encoding='utf-8')
        before = self.source.read_bytes()
        first = self.apply()
        self.assertEqual([row['status'] for row in first], ['applied'] * 3)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.apply(), [])
        self.assertEqual(len(list((self.vault / self.root / 'records/account-study').rglob('*.json'))), 3)

    def test_word_provenance_edit_keeps_frozen_word_evidence_and_current_original(self):
        reference = self.fixture.write(self.root + '/paper.md', '# Original paper notes\n')
        self.source.write_text(f'---\ntype: vocabulary-database\n---\n| word | meaning | example | source |\n|---|---|---|---|\n| Tree | 树 | A tree grows here. | [[{self.root}/paper]] |\n', encoding='utf-8')
        self.capture('snapshot-reference', 2); self.receive(self.records())
        reference.write_text('# Original paper notes\n\nNew reading notes.\n', encoding='utf-8')
        before = reference.read_bytes()
        self.assertEqual([row['status'] for row in self.apply()], ['applied'] * 3)
        self.assertEqual(reference.read_bytes(), before)

    def test_vocabulary_edit_during_revalidation_still_blocks(self):
        self.receive(self.records())
        self.source.write_text(self.source.read_text(encoding='utf-8') + '\nNew unrelated note.\n', encoding='utf-8')
        original = self.writer.catalog_loader; calls = 0
        def racing_loader(vault, refresh=False):
            nonlocal calls
            result = original(vault, refresh=refresh); calls += 1
            if calls == 2:
                self.source.write_text(self.source.read_text(encoding='utf-8').replace('树', 'different meaning'), encoding='utf-8')
            return result
        self.writer.catalog_loader = racing_loader
        self.assertTrue(all(row['status'] == 'blocked' for row in self.apply()))
        self.assertFalse((self.vault / self.root / 'records/account-study').exists())

    def test_missing_source_never_retargets_a_different_note(self):
        self.receive(self.records()); renamed = self.source.with_name('renamed.md'); self.source.rename(renamed)
        results = self.apply()
        self.assertTrue(all(result['status'] == 'blocked' for result in results))
        self.assertIn(results[0]['reason'], ('source-missing', 'source-changed'))
        self.assertFalse((self.vault / self.root / 'records/account-study').exists())

    def test_restart_after_journal_write_finishes_required_state_before_ack(self):
        self.receive(self.records())
        calls = 0
        def crash_after_write(path):
            nonlocal calls
            calls += 1
            if calls == 3: raise RuntimeError('simulated process crash')
        crashing = VerifiedVaultWriter(self.vault, self.owner, self.inbox, self.ledger, after_write=crash_after_write)
        with self.assertRaisesRegex(RuntimeError, 'simulated'):
            crashing.process(self.inbox.records_through(self.owner, 'library-a'), self.inbox.pending_records(self.owner, 'library-a'))
        self.assertEqual(len(self.inbox.pending_records(self.owner, 'library-a')), 3)
        self.writer = VerifiedVaultWriter(self.vault, self.owner, self.inbox, self.ledger)
        results = self.apply()
        self.assertEqual([r['status'] for r in results], ['applied'] * 3)
        self.assertIn('event-three', (self.vault / self.root / 'state.md').read_text(encoding='utf-8'))
        self.assertEqual(len(list((self.vault / self.root / 'records/account-study').rglob('*.json'))), 3)

    def test_lost_result_after_verified_files_is_idempotent(self):
        self.receive(self.records()); rows = self.inbox.records_through(self.owner, 'library-a')
        first = self.writer.process(rows, rows)
        files = {p: p.read_bytes() for p in self.vault.rglob('*') if p.is_file()}
        second = VerifiedVaultWriter(self.vault, self.owner, self.inbox, self.ledger).process(rows, rows)
        self.assertEqual(second, first)
        self.assertEqual({p: p.read_bytes() for p in self.vault.rglob('*') if p.is_file()}, files)

    def test_incomplete_chain_and_fork_are_retained_without_promotion(self):
        records = self.records(); self.receive([records[2]])
        results = self.apply(); self.assertEqual(results[0]['status'], 'blocked'); self.assertEqual(results[0]['reason'], 'dependency-pending')
        self.assertNotIn('ACCOUNT-LEARNING-EVIDENCE', (self.vault / self.root / 'state.md').read_text(encoding='utf-8'))

    def add_card(self):
        root = self.fixture.subject('reading', 'recall')
        self.fixture.write(root + '/source.md', '# Original reading material\n')
        self.card = self.fixture.write(root + '/result.md', f'''---
type: learning-result
item_id: reading-one
ability_id: reading-main
domain: course
source_note: "[[{root}/source]]"
state_ref: "[[{root}/state]]"
review_enabled: true
review_date: 2026-09-01
plugin_hint: recall
---
# Reading reference
Keep this original paragraph.
## 复习要点
- Stated reference fact
''')
        self.capture('snapshot-b', 2)
        return root

    def card_record(self, event_id, when, correct=True):
        item = next(item for item in self.bundle['items'] if item['kind'] == 'practice')
        record = copy.deepcopy(V['records'][2])
        record.update(snapshotId=self.bundle['snapshot']['snapshotId'], contentHash=item['contentHash'], practiceMode='recall',
                      parentEventId=None, roundId=event_id, attemptId=event_id)
        event = record['event']; event.update(eventId=event_id, occurredAt=when, domain='differential-review')
        event['item'] = {'key': item['itemKey'], 'kind': 'due'}
        event['attempt'] = {'stageBefore': 0, 'stageAfter': 3 if correct else 0, 'correct': correct, 'rating': 'good' if correct else 'again'}
        event['scheduling']['reviewedAt'] = when
        event['coreHash'] = schema.study_hash({k: v for k, v in event.items() if k != 'coreHash'})
        record['envelopeHash'] = schema.study_hash({k: v for k, v in record.items() if k != 'envelopeHash'})
        return record

    def test_late_old_successes_cannot_clear_a_newer_failed_review(self):
        self.add_card()
        latest = self.card_record('review-latest', '2026-09-09T01:00:00.000Z', False)
        self.receive([latest]); self.assertEqual(self.apply()[0]['status'], 'applied')
        earlier = [self.card_record('review-first', '2026-09-01T01:00:00.000Z'), self.card_record('review-second', '2026-09-08T01:00:00.000Z')]
        self.receive(earlier, after=1); self.assertEqual([r['status'] for r in self.apply()], ['applied', 'applied'])
        import review_queue
        queue = review_queue.read_queue(self.vault, self.card.relative_to(self.vault).as_posix())
        self.assertEqual(len(queue), 1); self.assertEqual(queue[0]['chain'], 0); self.assertEqual(queue[0]['due'], '2026-09-10')
        self.assertIn('Keep this original paragraph.', self.card.read_text(encoding='utf-8'))

    def test_user_text_outside_owned_block_survives_but_manual_queue_conflicts(self):
        root = self.add_card(); self.receive([self.card_record('review-one', '2026-09-01T01:00:00.000Z')]); self.apply()
        state = self.vault / root / 'state.md'
        state.write_text(state.read_text(encoding='utf-8') + '\nMy new learning note\n', encoding='utf-8')
        self.receive([self.card_record('review-two', '2026-09-02T01:00:00.000Z', False)], after=1)
        self.assertEqual(self.apply()[0]['status'], 'applied')
        self.assertIn('My new learning note', state.read_text(encoding='utf-8'))
        self.card.write_text(self.card.read_text(encoding='utf-8').replace('chain: 0', 'chain: 7'), encoding='utf-8')
        before = self.card.read_bytes()
        self.receive([self.card_record('review-three', '2026-09-03T01:00:00.000Z')], after=2)
        result = self.apply()[0]; self.assertEqual((result['status'], result['reason']), ('blocked', 'write-conflict'))
        self.assertEqual(self.card.read_bytes(), before)

    def test_source_edit_during_batch_is_revalidated_before_later_projection(self):
        self.receive(self.records()); edited = False
        def edit_after_first(path):
            nonlocal edited
            if not edited:
                edited = True
                self.source.write_text(self.source.read_text(encoding='utf-8').replace('树', 'Changed during batch'), encoding='utf-8')
        self.writer = VerifiedVaultWriter(self.vault, self.owner, self.inbox, self.ledger, after_write=edit_after_first)
        results = self.apply()
        self.assertEqual([r['status'] for r in results[1:]], ['blocked', 'blocked'])
        self.assertNotIn('ACCOUNT-LEARNING-EVIDENCE', (self.vault / self.root / 'state.md').read_text(encoding='utf-8'))

    def test_completed_job_cannot_return_an_unverified_changed_proof(self):
        self.receive(self.records()); rows = self.inbox.records_through(self.owner, 'library-a')
        self.writer.process(rows, rows)
        with closing(sqlite3.connect(self.ledger)) as db, db:
            proof = json.loads(db.execute("SELECT proof_json FROM account_vault_jobs WHERE event_id='event-three'").fetchone()[0])
            proof['proofHash'] = 'f' * 64
            db.execute("UPDATE account_vault_jobs SET proof_json=? WHERE event_id='event-three'", (json.dumps(proof),))
        result = self.writer.process(rows, rows)
        self.assertTrue(all(row['status'] != 'applied' for row in result))

    def test_independent_original_source_change_blocks_stale_reference(self):
        root = self.add_card(); event = self.card_record('source-change', '2026-09-01T01:00:00.000Z')
        original = self.vault / root / 'source.md'
        original.write_text('# Changed reading material\nA different result.\n', encoding='utf-8')
        self.receive([event]); result = self.apply()[0]
        self.assertEqual((result['status'], result['reason']), ('blocked', 'source-changed'))
        self.assertNotIn('ACCOUNT-LEARNING-EVIDENCE', (self.vault / root / 'state.md').read_text(encoding='utf-8'))

    def test_source_as_state_ignores_own_evidence_but_not_user_material_changes(self):
        root = self.add_card()
        self.card.write_text(self.card.read_text(encoding='utf-8').replace(f'[[{root}/source]]', f'[[{root}/state]]'), encoding='utf-8')
        self.capture('snapshot-c', 3)
        self.receive([self.card_record('shared-source-one', '2026-09-01T01:00:00.000Z')]); self.assertEqual(self.apply()[0]['status'], 'applied')
        self.receive([self.card_record('shared-source-two', '2026-09-02T01:00:00.000Z', False)], after=1)
        self.assertEqual(self.apply()[0]['status'], 'applied')

    def test_self_report_task_writes_subject_owned_account_task_journal(self):
        course=self.fixture.subject('course','quiz');gateway=fixtures.gateway.load_gateway(self.vault);routes={definition['id']:{key:definition[key] for key in ('id','contentRoot','recordsRoot','progressRef')} for definition in gateway['planningDefinitions']}
        # Planning vector also contains vocab; bind it to the already registered word route.
        routes['vocab']={**routes.pop('words'),'id':'vocab'}
        self.inbox.queue_planning(self.owner,'library-a','snapshot-a',PV['catalog'],PV['materials'],PV['facts'],routes)
        operation={'sequence':1,'operationId':'task-approve','day':PV['cloudPlan']['day'],'action':'approve','plan':PV['cloudPlan'],'predecessorOperationId':None,'stateRevision':2,'receivedAt':'2026-09-01T00:00:00.000Z'}
        self.inbox.receive_plan_page(self.owner,'library-a',{'operations':[operation],'through':1,'nextCursor':None})
        self.inbox.set_plan_result(self.owner,'library-a',{'operationId':'task-approve','cloudPlanHash':PV['cloudPlan']['cloudPlanHash'],'status':'applied','proof':{'cloudPlanHash':PV['cloudPlan']['cloudPlanHash'],'nativePlanHash':'e'*64,'localRevision':1,'proofHash':'f'*64,'targetCount':1}})
        task=PV['cloudPlan']['tasks'][0];body={'schemaVersion':1,'eventType':'task-completed','eventId':'task-event-writer','taskId':task['taskId'],'subjectId':task['subjectId'],'day':'2026-09-01','occurredAt':'2026-09-01T01:00:00.000Z','unitIds':task['unitIds'],'source':'self-report','evidenceRefs':[]}
        event={**body,'coreHash':task_events.hash_task_event(body)};record={'schemaVersion':1,'libraryId':'library-a','snapshotId':'snapshot-a','originDeviceId':'device-a','provenanceMode':'task','planHash':PV['cloudPlan']['cloudPlanHash'],'assignmentId':task['taskId'],'completionKey':'completion:'+schema.study_hash([PV['cloudPlan']['cloudPlanHash'],task['taskId'],task['unitIds'],body['day']]),'event':event}
        record['envelopeHash']=schema.study_hash(record);self.inbox.receive_page(self.owner,'library-a',{'records':[{'sequence':1,'record':record}],'through':1,'nextCursor':None})
        results=self.apply();self.assertEqual(results[0]['status'],'applied')
        journals=list((self.vault/course/'records/account-study-tasks').rglob('*.json'));self.assertEqual(len(journals),1);self.assertEqual(json.loads(journals[0].read_text(encoding='utf-8'))['record']['event']['eventId'],'task-event-writer')
        self.assertEqual(self.writer.task_events('library-a')[0]['eventId'],'task-event-writer')

    def test_inconsistent_correctness_cannot_remove_a_required_review(self):
        self.add_card(); records = [self.card_record('contradiction-one', '2026-09-01T01:00:00.000Z', False), self.card_record('contradiction-two', '2026-09-02T01:00:00.000Z', False)]
        for record in records:
            record['event']['attempt']['rating'] = 'good'
            record['event']['coreHash'] = schema.study_hash({k: v for k, v in record['event'].items() if k != 'coreHash'})
            record['envelopeHash'] = schema.study_hash({k: v for k, v in record.items() if k != 'envelopeHash'})
        before = self.card.read_bytes(); self.receive(records)
        self.assertTrue(all(row['status'] == 'blocked' for row in self.apply()))
        self.assertEqual(self.card.read_bytes(), before)

    def test_sql_failure_returns_recoverable_storage_block(self):
        self.receive(self.records())
        with closing(sqlite3.connect(self.ledger)) as db, db:
            db.execute("CREATE TRIGGER fail_intent BEFORE INSERT ON account_vault_jobs BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
        results = self.apply()
        self.assertEqual(results[0]['reason'], 'storage-unavailable')
        self.assertEqual(len(self.inbox.pending_records(self.owner, 'library-a')), 3)
        self.assertFalse((self.vault / self.root / 'records/account-study').exists())


if __name__ == '__main__': unittest.main()
