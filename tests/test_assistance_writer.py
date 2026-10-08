import importlib.util
import json
import unittest
from pathlib import Path
import test_account_sync_writer as fixtures
import assistance_schema as schema
if importlib.util.find_spec('assistance_writer'):
    from assistance_writer import AssistanceVaultWriter
else:
    AssistanceVaultWriter = None


class AssistanceWriterTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(AssistanceVaultWriter)
        self.f = fixtures.AccountSyncWriterTests(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.records = self.f.records(); self.f.receive(self.records); self.f.apply()
        self.path = Path(self.f.temp.name)/'assistance-ledger.db'
        self.writer = AssistanceVaultWriter(self.f.vault, self.f.owner, self.path)
        self.record = self.assistance(self.records[0])

    def assistance(self, parent):
        summary = schema.seal_summary(dict(schemaVersion=1, attemptEventId=parent['event']['eventId'], attemptCoreHash=parent['event']['coreHash'], practiceMode=parent['practiceMode'],
                                            observationScope='current-page-attempt', preSubmitAssistance=[dict(action='meaning-check', count=1)], postSubmitFeedback=[]))
        return schema.seal_account_assistance(parent, summary)

    def apply(self, record=None, writer=None):
        return (writer or self.writer).apply_account(record or self.record, self.f.writer)

    def files(self):
        return self.f.vault/self.f.root/'records/assistance'

    def test_writes_only_behavior_json_and_rebuildable_monthly_markdown(self):
        before = {p: p.read_bytes() for p in self.f.vault.rglob('*') if p.is_file()}
        proof = self.apply(); self.assertEqual(proof['targetCount'], 2); self.assertEqual(proof['attemptCoreHash'], self.record['summary']['attemptCoreHash'])
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        docs = list(self.files().rglob('*.json')); reports = list(self.files().rglob('*.md'))
        self.assertEqual(len(docs), 1); self.assertEqual(len(reports), 1)
        text = reports[0].read_text(encoding='utf-8'); self.assertIn('释义核对', text); self.assertIn('2026-09', text); self.assertNotIn('独立完成', text)
        raw = json.loads(docs[0].read_text(encoding='utf-8')); self.assertEqual(raw['record']['summary'], self.record['summary'])
        for field in ('sourceNote', 'stateRef', 'localPath', 'prompt', 'answer', 'meaning'):
            self.assertNotIn('"'+field+'":', docs[0].read_text(encoding='utf-8'))
        self.assertEqual(self.apply(), proof); self.assertEqual(len(list(self.files().rglob('*.json'))), 1)
        catalog = fixtures.fixtures.gateway.load_gateway(self.f.vault)
        self.assertEqual(len(catalog['subjects'][0]['items']), 1)

    def test_restart_after_first_file_replace_finishes_the_same_job(self):
        calls = []
        def crash(path):
            calls.append(path)
            if len(calls) == 1: raise RuntimeError('simulated shutdown')
        crashed = AssistanceVaultWriter(self.f.vault, self.f.owner, self.path, after_write=crash)
        with self.assertRaisesRegex(RuntimeError, 'shutdown'): self.apply(writer=crashed)
        self.assertEqual(len(list(self.files().rglob('*.json'))), 1); self.assertEqual(len(list(self.files().rglob('*.md'))), 0)
        restored = AssistanceVaultWriter(self.f.vault, self.f.owner, self.path)
        self.assertEqual(self.apply(writer=restored)['targetCount'], 2)
        self.assertEqual(len(list(self.files().rglob('*.json'))), 1); self.assertEqual(len(list(self.files().rglob('*.md'))), 1)

    def test_monthly_growth_keeps_prior_receipts_valid_and_manual_edits_are_not_overwritten(self):
        first = self.apply(); second = self.assistance(self.records[1]); self.apply(second)
        self.assertEqual(self.apply(), first); self.assertEqual(len(list(self.files().rglob('*.json'))), 2)
        report = next(self.files().rglob('*.md')); report.write_text(report.read_text(encoding='utf-8')+'\nHuman comment\n', encoding='utf-8'); before = report.read_bytes()
        with self.assertRaisesRegex(ValueError, 'write-conflict'): self.apply(self.assistance(self.records[2]))
        self.assertEqual(report.read_bytes(), before); self.assertEqual(len(list(self.files().rglob('*.json'))), 2)

    def test_wrong_parent_source_or_scope_never_gets_an_auxiliary_write_target(self):
        bad = dict(self.record, libraryId='other')
        with self.assertRaises(ValueError): self.apply(bad)
        other = AssistanceVaultWriter(self.f.vault, 'b'*64, self.path)
        with self.assertRaises(ValueError): self.apply(writer=other)
        self.f.source.write_text(self.f.source.read_text(encoding='utf-8').replace('树', 'Changed'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'source-changed'): self.apply()
        self.assertFalse(self.files().exists())

    def test_auxiliary_failure_never_changes_original_core_or_mastery(self):
        state = self.f.vault/self.f.root/'state.md'; before = state.read_bytes()
        self.path.parent.mkdir(exist_ok=True)
        self.writer = AssistanceVaultWriter(self.f.vault, self.f.owner, self.path, after_write=lambda _: (_ for _ in ()).throw(OSError('disk')))
        with self.assertRaises(OSError): self.apply()
        self.assertEqual(state.read_bytes(), before); self.assertEqual(len(self.f.inbox.records_through(self.f.owner,'library-a')), 3)

    def test_completed_files_can_recover_a_lost_receipt_after_later_source_changes(self):
        calls = []
        def crash(path):
            calls.append(path)
            if len(calls)==2: raise RuntimeError('shutdown before receipt')
        writer = AssistanceVaultWriter(self.f.vault,self.f.owner,self.path,after_write=crash)
        with self.assertRaises(RuntimeError): self.apply(writer=writer)
        self.f.source.write_text(self.f.source.read_text(encoding='utf-8').replace('树','Changed later'),encoding='utf-8')
        before = {p:p.read_bytes() for p in self.files().rglob('*') if p.is_file()}
        proof = self.apply(); self.assertEqual(proof['targetCount'],2)
        self.assertEqual(self.apply(),proof); self.assertEqual({p:p.read_bytes() for p in before},before)

    def test_month_directory_comes_from_original_attempt_in_shanghai_time(self):
        import copy
        from account_sync_schema import study_hash
        parent=copy.deepcopy(self.records[0]);parent['event']['eventId']='timezone-event';parent['event']['occurredAt']='2026-09-30T16:30:00.000Z'
        parent['event']['coreHash']=study_hash({key:value for key,value in parent['event'].items() if key!='coreHash'})
        parent.update(roundId='timezone-round',attemptId='timezone-attempt');parent['envelopeHash']=study_hash({key:value for key,value in parent.items() if key!='envelopeHash'})
        self.f.receive([parent],after=3);self.assertEqual(self.f.apply()[0]['status'],'applied')
        self.apply(self.assistance(parent));folder=self.files()/'2026/10';self.assertEqual(len(list(folder.glob('*.json'))),1)
        self.assertIn('10-01 00:30',next(folder.glob('*.md')).read_text(encoding='utf-8'))
