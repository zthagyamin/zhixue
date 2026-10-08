import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import vault_topology as topology
import index_gateway as gateway
import account_sync_export as exporter


class MappedRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name) / 'vault'; self.vault.mkdir()
        self.db = Path(self.temp.name) / 'mapping.db'; self.owner = 'a' * 64
        self.source = self.vault / 'lesson.md'
        self.source.write_bytes('## C# / F# | recall\r\nA multiline reference.\r\nKeep literal \\n and | intact.\r\n'.encode())
        self.rules = [dict(pathGlob='**/*.md', subjectId='mapped:course', subjectLabel='Course', contentKind='quiz', splitMode='heading')]

    def catalog(self):
        import mapped_source_registry as registry
        return registry.load_catalog(self.vault, self.db, self.owner)

    def confirm(self):
        topology.save(self.db, self.vault, self.owner, self.rules, 0)
        return self.catalog()

    def test_registered_binding_exact_content_isolated_and_original_unchanged(self):
        before = self.source.read_bytes(); expected = topology.extract(self.vault, self.rules)[0]
        catalog = self.confirm()
        self.assertEqual(catalog['diagnostics'], [])
        item = catalog['subjects'][0]['items'][0]
        self.assertEqual(item['itemId'], expected['itemId'])
        self.assertEqual(item['prompt'], expected['prompt']); self.assertEqual(item['answer'], expected['answer'])
        state = self.vault / item['stateRef']
        self.assertEqual(gateway._meta(state.read_text())['type'], 'zhixue-practice-state')
        self.assertNotIn('mastered', state.read_text())
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(gateway.load_gateway(self.vault)['subjects'], [])
        import mapped_source_registry as registry
        self.assertEqual(registry.load_catalog(self.vault, self.db, 'b' * 64)['subjects'], [])
        captured, identities = exporter.capture_catalog(self.vault, catalog_loader=lambda v, refresh=False: self.catalog())
        bundle, _ = exporter.export_catalog(captured, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        self.assertEqual(bundle['items'][0]['practice']['answer'], expected['answer'])

    def test_refresh_retains_state_and_removed_source_evidence(self):
        first = self.confirm(); old = first['subjects'][0]['items'][0]
        state = self.vault / old['stateRef']; state.write_text(state.read_text() + '\nEvidence retained.\n')
        self.source.write_text(self.source.read_text().replace('A multiline', 'Changed multiline'))
        new = self.catalog()['subjects'][0]['items'][0]
        self.assertEqual(old['itemId'], new['itemId']); self.assertNotEqual(old['contentHash'], new['contentHash'])
        self.assertIn('Evidence retained.', state.read_text())
        self.source.unlink()
        self.assertEqual(self.catalog()['bindings'], {})
        self.assertIn('Evidence retained.', state.read_text())
        self.assertEqual(list(topology.files(self.vault)), [])

    def test_manual_derived_edit_is_conflict_and_capture_fails_closed(self):
        catalog = self.confirm(); binding = next(iter(catalog['bindings'].values()))
        carrier = self.vault / binding['documentPath']; carrier.write_text(carrier.read_text() + '\nmanual edit\n')
        broken = self.catalog(); self.assertTrue(broken['mappingDiagnostics'])
        self.assertIn('manual edit', carrier.read_text())
        with self.assertRaises(ValueError):
            exporter.capture_catalog(self.vault, catalog_loader=lambda v, refresh=False: self.catalog())

    def test_actual_account_roundtrip_preserves_original_bytes(self):
        from test_account_sync_writer import AccountSyncWriterTests
        from account_sync_writer import VerifiedVaultWriter
        from account_sync_inbox import Inbox
        self.source.write_bytes(b'| word | meaning | context |\r\n|---|---|---|\r\n| Tree | A plant | A tree grows here. |\r\n')
        self.rules[0].update(contentKind='vocabulary', splitMode='table')
        self.confirm()
        loader = lambda vault, refresh=False: self.catalog()
        catalog, identities = exporter.capture_catalog(self.vault, catalog_loader=loader)
        harness = AccountSyncWriterTests()
        harness.owner = self.owner
        harness.bundle, harness.bindings = exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        from account_sync_planning import export_planning
        cloud, _, _, _ = export_planning(self.vault, catalog, harness.bundle, catalog_loader=loader)
        self.assertIn('mapped:course', [s['subjectId'] for s in cloud['subjects']])
        harness.inbox = Inbox(Path(self.temp.name) / 'inbox.db')
        harness.writer = VerifiedVaultWriter(self.vault, self.owner, harness.inbox, Path(self.temp.name)/'ledger.db', catalog_loader=loader)
        harness.inbox.save_export(self.owner, harness.bundle, harness.bindings)
        harness.writer.prepare_snapshot(harness.bundle, harness.bindings)
        before = {p:p.read_bytes() for p in self.vault.rglob('*') if p.is_file()}
        harness.receive(harness.records())
        result = harness.apply()
        self.assertEqual([row['status'] for row in result], ['applied'] * 3)
        self.assertTrue(all(row['proof']['targetCount'] for row in result))
        state = self.vault / next(iter(catalog['bindings'].values()))['stateRef']
        self.assertIn('event-three', state.read_text(encoding='utf-8'))
        for path, raw in before.items():
            if path != state: self.assertEqual(path.read_bytes(), raw, str(path))
        self.assertEqual(len(list(state.parent.glob('records/account-study/**/*.json'))), 3)
        # Repeated refresh must preserve accepted evidence and receipt identity.
        self.catalog(); self.assertIn('event-three', state.read_text(encoding='utf-8'))
        self.assertEqual(harness.writer.process(harness.inbox.records_through(self.owner, 'library-a'), harness.inbox.records_through(self.owner, 'library-a')), result)

    def test_failed_source_keeps_primary_and_disabled_entry_is_not_reenabled(self):
        from test_index_gateway import IndexGatewayTests
        fixture = IndexGatewayTests(); fixture.vault = self.vault; fixture.entry = gateway.GATEWAY_ROOT.as_posix()
        fixture.write(fixture.entry + '/index.md', '---\ntype: zhixue-gateway\nschema_version: 1\n---\n')
        root = fixture.subject('primary'); fixture.quiz(root)
        self.rules[0]['pathGlob'] = 'lesson.md'
        self.confirm(); self.source.write_bytes(b'\xff')
        broken = self.catalog()
        self.assertEqual(broken['subjects'][0]['id'], 'primary')
        self.assertTrue(broken['subjects'][0]['items']); self.assertTrue(broken['mappingDiagnostics'])
        entry = self.vault / gateway.GATEWAY_ROOT / 'index.md'
        entry.write_text('---\ntype: zhixue-gateway\nschema_version: 1\nenabled: false\n---\n')
        before = entry.read_bytes(); self.assertEqual(self.catalog()['subjects'], [])
        self.assertEqual(entry.read_bytes(), before)

    def test_internal_and_external_reparse_paths_refused(self):
        import os
        import subprocess
        import mapped_source_registry as registry
        target = self.vault / 'original'; target.mkdir()
        for target in (target, Path(self.temp.name)):
            link = self.vault / 'linked'
            if os.name == 'nt':
                made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
                if made.returncode: self.skipTest('Junction creation unavailable')
            else: link.symlink_to(target, target_is_directory=True)
            try:
                with self.assertRaisesRegex(ValueError, 'reparse'):
                    registry._safe(self.vault, link / 'new.md')
            finally:
                if os.name == 'nt': link.rmdir()
                else: link.unlink()

    def test_python_json_cells_keep_literal_escapes_pipes_and_newlines(self):
        initial = 'def label():\n    return "C# | F# literal \\n"\n'
        tests = 'assert label() == "C# | F# literal \\n"\n'
        cell = lambda value: json.dumps(value).replace('|', '\\u007c')
        self.source.write_text('| prompt | initialCode | testCode | solutionCode |\n|---|---|---|---|\n| C# / F# | ' + cell(initial) + ' | ' + cell(tests) + ' | ' + cell(initial) + ' |\n')
        self.rules[0].update(contentKind='code', splitMode='table')
        original = self.source.read_bytes()
        catalog = self.confirm(); self.assertEqual(catalog['diagnostics'], [])
        item = catalog['subjects'][0]['items'][0]
        self.assertEqual(item['initialCode'], initial); self.assertEqual(item['testCode'], tests)
        captured, identities = exporter.capture_catalog(self.vault, catalog_loader=lambda v, refresh=False:self.catalog())
        bundle, _ = exporter.export_catalog(captured, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        self.assertEqual(bundle['items'][0]['practice']['initialCode'], initial)
        self.assertEqual(bundle['items'][0]['practice']['testCode'], tests)
        self.assertEqual(self.source.read_bytes(), original)

    def test_actual_native_event_and_study_readback(self):
        from unittest import mock
        from test_gateway_server import GatewayServerTests, server
        harness = GatewayServerTests(); harness.setUp(); self.addCleanup(harness.tearDown)
        original = harness.builder.write('course.md', '## Recall C#\nPreserve F# | reference and literal \\n.')
        raw = original.read_bytes()
        owner = 'a' * 64
        with mock.patch.object(server, 'installation_owner_hash', return_value=owner):
            server.vault_mapping_request(owner, {'action':'confirm','revision':0,'rules':[{**self.rules[0], 'pathGlob':'course.md'}]})
            catalog = server.effective_gateway(harness.vault)
            subject = next(s for s in catalog['subjects'] if s['id']=='mapped:course')
            item = subject['items'][0]; key = 'practice:' + item['itemId']
            event = harness.fixture.make_v3_activity('mapped-native-event', item_key=key, state_ref=item['stateRef'], ability_id=item['abilityId'])
            with server.local_database() as db:
                result = server.accept_study_event_v3(db, harness.vault, owner, event)
            self.assertEqual(result['mappingStatus'], 'mapped'); self.assertTrue(result['companionReceipt']['durable'])
            snapshot = server.indexed_study_payload(harness.vault, owner)
            self.assertTrue(any(e['eventId']=='mapped-native-event' for e in snapshot['gateway']['progressEvents']))
            self.assertEqual(original.read_bytes(), raw)
            records = gateway.read_subject_events(harness.vault, catalog['bindings'][key], owner)
            self.assertEqual(records[0]['event']['eventId'], 'mapped-native-event')
            context = server.planning_evidence.build_context(harness.vault, catalog, owner, server.validate_study_event_v3, catalog_loader=server.effective_gateway)
            self.assertIn('mapped:course', [s['subjectId'] for s in context['catalog']['subjects']])
            server.planning_evidence.verify_catalog_snapshot(harness.vault, catalog, context['catalog'], catalog_loader=server.effective_gateway)
            page = server.planning_evidence.evidence_page(harness.vault, catalog, owner, server.validate_study_event_v3,
                source_hash=context['catalog']['sourceHash'], plan_revision=context['planRevision'])
            self.assertEqual(page['records'][0]['planningEvidence']['itemSource']['itemKey'], key)

    def test_foreign_file_state_collision_and_failed_publish_roll_back(self):
        from unittest import mock
        import mapped_source_registry as registry
        scope = registry.ROOT / topology._digest({'owner':self.owner, 'vault':str(self.vault)})[:24]
        folder = self.vault / scope / topology._digest('mapped:course')[:24]
        folder.mkdir(parents=True)
        foreign = folder / 'content.md'; foreign.write_bytes(b'Human-owned content')
        broken = self.confirm(); self.assertTrue(broken['mappingDiagnostics'])
        self.assertEqual(foreign.read_bytes(), b'Human-owned content'); foreign.unlink()
        state = folder/'state.md'; state.write_text('---\ntype: learning-state\n---\n')
        self.assertTrue(self.catalog()['mappingDiagnostics']); state.unlink()
        atomic = registry._atomic; calls = []
        def fail(vault,path,raw,expected):
            calls.append(path)
            if len(calls)==2: raise OSError('fixture publish failure')
            return atomic(vault,path,raw,expected)
        with mock.patch.object(registry, '_atomic', side_effect=fail):
            self.assertTrue(self.catalog()['mappingDiagnostics'])
        self.assertFalse(any(path.is_file() for path in (self.vault/registry.ROOT).rglob('*')))
        self.assertFalse((self.vault/gateway.GATEWAY_ROOT/'index.md').exists())
        self.assertEqual(self.catalog()['diagnostics'], [])

    def test_registered_quiz_preserves_options_and_portable_quiz_mode(self):
        self.source.write_text('| prompt | options | answer |\n|---|---|---|\n| Choose the prime | 4;5;6 | 5 |\n')
        self.rules[0].update(splitMode='table')
        expected = topology.extract(self.vault, self.rules)[0]
        catalog = self.confirm(); item = catalog['subjects'][0]['items'][0]
        self.assertEqual(item['options'], expected['options'])
        self.assertEqual(item['answer'], '5'); self.assertEqual(item['pluginType'], 'quiz')
        captured, identities = exporter.capture_catalog(self.vault, catalog_loader=lambda v, refresh=False:self.catalog())
        bundle, _ = exporter.export_catalog(captured, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        self.assertEqual(bundle['items'][0]['practice']['questionType'], 'quiz')
        self.assertEqual(bundle['items'][0]['practice']['options'], ['4','5','6'])
        self.assertEqual(bundle['items'][0]['practice']['answer'], 1)
        self.source.write_text(self.source.read_text().replace('| 5 |', '| absent |'))
        invalid = self.catalog()
        self.assertTrue(invalid['diagnostics'])
        self.assertTrue(invalid['mappingDiagnostics'])
        with self.assertRaises(ValueError):
            exporter.capture_catalog(self.vault, catalog_loader=lambda v, refresh=False:self.catalog())

    def test_legacy_sources_coexist_before_during_and_after_mapping(self):
        from unittest import mock
        from test_companion import CompanionSyncTests, server
        fixture = CompanionSyncTests(); fixture.setUp(); self.addCleanup(fixture.tearDown)
        source = fixture.write('_System/Integrations/Study Loop/sources/words.md',
            '---\ntype: study-loop-source\nstatus: active\n---\n| word | meaning | context |\n|---|---|---|\n| original | preserved | Original material. |\n')
        mapped = fixture.write('mapped-course.md', '## New recall\nAn independent reference.\n')
        legacy_state = fixture.write('legacy-state.md','---\ntype: learning-state\n---\n# Legacy state\n')
        fixture.write('card-state.md','---\ntype: learning-state\n---\n# Card state\n')
        card = fixture.write('01 学习/学习结果/legacy-result.md',
            '---\ntype: learning-result\nitem_id: legacy-result\nability_id: legacy-card-ability\nreview_enabled: true\nreview_date: 2026-01-01\nsource_note: "[[mapped-course]]"\nstate_ref: "[[card-state]]"\n---\n# Legacy result\n复习要点：\n- Legacy reference\n')
        original_bytes = {source:source.read_bytes(), mapped:mapped.read_bytes(), card:card.read_bytes()}
        owner = 'a'*64
        baseline = {'subjects':[{'id':'legacy-existing','name':'Existing','pluginType':'recall','domain':'paper','items':[{'id':'old','prompt':'Old prompt'}]}]}
        with mock.patch.object(server, 'installation_owner_hash', return_value=owner), mock.patch.object(server, 'deepseek_key', return_value=''):
            def visible():
                return server.with_connections(server.merge_source_area(copy.deepcopy(baseline), fixture.vault))
            before = visible()
            legacy_cards = server.learning_result.parse_result_cards(fixture.vault)
            self.assertEqual(legacy_cards[0]['itemId'], 'legacy-result')
            self.assertIsNone(server.indexed_study_payload(fixture.vault, owner))
            self.assertEqual(server.learning_result.parse_result_cards(fixture.vault), legacy_cards)
            self.assertFalse(any('Study Loop/mapped/' in p.as_posix() for p in server.supported_note_files(fixture.vault)))
            self.assertIn('ielts-vocabulary', [s['id'] for s in before['subjects']])
            server.vault_mapping_request(owner, {'action':'confirm','revision':0,'rules':[{**self.rules[0], 'pathGlob':'mapped-course.md'}]})
            self.assertFalse((fixture.vault/gateway.GATEWAY_ROOT).exists(), 'Mapping must not migrate global legacy mode')
            during = visible(); ids = {s['id'] for s in during['subjects']}
            self.assertTrue({'legacy-existing','ielts-vocabulary','mapped:course'} <= ids)
            self.assertIsNone(server.indexed_study_payload(fixture.vault, owner))
            item = next(s for s in during['subjects'] if s['id']=='mapped:course')['items'][0]
            catalog = server.effective_gateway(fixture.vault); key = 'practice:' + item['itemId']
            event = fixture.make_v3_activity('coexisting-mapped-event', item_key=key, state_ref=item['stateRef'], ability_id=item['abilityId'])
            with server.local_database() as db:
                result = server.accept_study_event_v3(db, fixture.vault, owner, event)
                legacy_event = fixture.make_v3_activity('coexisting-legacy-event', item_key='practice:legacy-question', state_ref='legacy-state.md', ability_id='legacy-ability')
                legacy_result = server.accept_study_event_v3(db, fixture.vault, owner, legacy_event)
            self.assertEqual(legacy_result['mappingStatus'], 'mapped')
            self.assertIn('legacy-ability', legacy_state.read_text(encoding='utf-8'))
            self.assertTrue(result['companionReceipt']['durable'])
            binding = catalog['bindings'][key]
            self.assertEqual(gateway.read_subject_events(fixture.vault,binding,owner)[0]['planningEvidence']['itemSource']['itemKey'],key)
            state = fixture.vault/item['stateRef']; recorded = state.read_bytes()
            with mock.patch.object(server,'STATE',copy.deepcopy(baseline)):
                server.safe_refresh()
                refreshed = visible()
                self.assertIn('ielts-vocabulary', [s['id'] for s in refreshed['subjects']])
            server.vault_mapping_request(owner, {'action':'confirm','revision':1,'rules':[]})
            after = visible()
            self.assertEqual({s['id'] for s in after['subjects']}, {s['id'] for s in before['subjects']})
            self.assertIsNone(server.indexed_study_payload(fixture.vault, owner))
            self.assertEqual(server.learning_result.parse_result_cards(fixture.vault), legacy_cards)
            self.assertEqual(state.read_bytes(), recorded)
            self.assertEqual(gateway.read_subject_events(fixture.vault,binding,owner)[0]['event']['eventId'],'coexisting-mapped-event')
            for path, raw in original_bytes.items(): self.assertEqual(path.read_bytes(),raw)


if __name__ == '__main__': unittest.main()
