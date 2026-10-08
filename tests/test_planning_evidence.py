"""Local identity observations survive mutable sources without changing V3 cores."""
import copy
import json
import unittest
from unittest import mock
import test_gateway_server as fixtures
import index_gateway
import task_events
import test_task_events

try:
    import planning_evidence
except ImportError:
    planning_evidence = None
server = fixtures.server


class PlanningEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GatewayServerTests();self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.vault = self.fixture.vault

    def records(self):
        self.assertIsNotNone(planning_evidence, 'Planning evidence adapter must exist')
        return planning_evidence.read_records(self.vault, index_gateway.load_gateway(self.vault), 'account', server.validate_study_event_v3)

    def test_word_identity_is_local_only_and_survives_removed_source(self):
        root = self.fixture.builder.subject('words', 'three-stage', 'legacy')
        source = self.fixture.builder.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| 单词 | 释义 | 原文语境 |\n|---|---|---|\n| Tree | PRIVATE meaning | PRIVATE context |\n')
        payload = self.fixture.fixture.make_v3_activity('word-identity-event', item_key='word:tree', state_ref=root + '/state.md', ability_id='word:tree')
        payload['event']['attempt']['stageBefore'] = 0
        payload['event']['coreHash'] = server.compute_study_event_core_hash(payload['event'])
        original = copy.deepcopy(payload['event'])
        self.fixture.accept(payload)
        row = next(row for row in self.records() if row['event']['eventId'] == original['eventId'])
        self.assertEqual(row['event'], original)
        self.assertEqual(row['planningEvidence']['word']['word'], 'Tree')
        self.assertEqual(row['planningEvidence']['word']['language'], 'en')
        self.assertNotIn('PRIVATE', json.dumps(row['planningEvidence']))
        self.assertNotIn('sourceNote', json.dumps(row['planningEvidence']))
        source.unlink()
        self.assertEqual(self.records()[0]['planningEvidence'], row['planningEvidence'])

    def test_unknown_language_retains_physical_word_evidence_after_source_removal(self):
        root = self.fixture.builder.subject('unconfirmed-words', 'three-stage', 'scoped')
        source = self.fixture.builder.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning |\n|---|---|\n| Tree | A tree |\n')
        catalog = index_gateway.load_gateway(self.vault)
        key = next(key for key, value in catalog['bindings'].items() if value['subjectId'] == 'unconfirmed-words')
        payload = self.fixture.fixture.make_v3_activity('unknown-language-word', item_key=key, state_ref=root + '/state.md', ability_id=key)
        payload['event']['attempt']['stageBefore'] = 0
        payload['event']['coreHash'] = server.compute_study_event_core_hash(payload['event'])
        self.fixture.accept(payload)
        row = self.records()[0]
        self.assertEqual(row['planningEvidence']['word']['language'], '')
        self.assertEqual(row['planningEvidence']['word']['word'], 'Tree')
        source.unlink()
        self.assertEqual(self.records()[0]['planningEvidence'], row['planningEvidence'])

    def test_review_before_and_actual_machine_after_are_frozen_once(self):
        card = self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('source-review-observed', item_key='practice:stable-card',
            state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        self.fixture.accept(payload)
        row = self.records()[0];observation = row['planningEvidence']
        self.assertTrue(observation['beforeReview']['enabled'])
        self.assertTrue(observation['beforeReview']['dueAt'].startswith('2026-01-01'))
        actual = server.learning_result.parse_result_file(self.vault, card)
        self.assertEqual(observation['afterReview']['enabled'], actual['reviewEnabled'])
        self.assertTrue(observation['afterReview']['dueAt'].startswith(actual['reviewDate']))
        card.write_text(card.read_text(encoding='utf-8').replace('review_date: ' + actual['reviewDate'], 'review_date: 2026-08-31'), encoding='utf-8')
        self.assertEqual(self.fixture.accept(payload)['status'], 'duplicate')
        self.assertEqual(self.records()[0]['planningEvidence'], observation)

    def test_practice_source_version_is_captured_without_rewriting_event_or_later_source(self):
        card = self.fixture.result_card()
        catalog = index_gateway.load_gateway(self.vault)
        binding = catalog['bindings']['practice:stable-card']
        payload = self.fixture.fixture.make_v3_activity('practice-source-version', item_key='practice:stable-card',
            state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        original_hash = payload['event']['coreHash']
        self.fixture.accept(payload)
        row = self.records()[0]
        self.assertEqual(row['event']['coreHash'], original_hash)
        self.assertEqual(row['planningEvidence'].get('itemSource'), {
            'itemKey': 'practice:stable-card', 'subjectId': binding['subjectId'], 'sourceHash': binding['signature']})
        observed = copy.deepcopy(row['planningEvidence'])
        card.write_text(card.read_text(encoding='utf-8') + '\nNew source context.\n', encoding='utf-8')
        self.assertEqual(self.records()[0]['planningEvidence'], observed)

    def test_corrupt_identity_metadata_does_not_silently_change_new_word_counts(self):
        self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('source-evidence-tamper', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        self.fixture.accept(payload)
        rows = self.records();self.assertTrue(rows[0]['planningEvidence'])
        path = next((self.vault / self.fixture.root / 'records').rglob('*.jsonl'))
        row = json.loads(path.read_text(encoding='utf-8'))
        row['planningEvidence']['beforeReview']['dueAt'] = '2020-01-01T00:00:00+08:00'
        path.write_text(json.dumps(row) + '\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.records()

    def test_source_write_failure_keeps_before_without_inventing_an_after(self):
        self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('source-write-pending', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        with mock.patch.object(server.review_queue, 'apply_result', side_effect=ValueError('stale-vault-edit')):
            result = self.fixture.accept(payload)
        self.assertEqual(result['projectionStatus'], 'pending')
        observation = self.records()[0]['planningEvidence']
        self.assertIn('beforeReview', observation);self.assertNotIn('afterReview', observation)
        self.fixture.accept(payload)
        settled = self.records()[0]['planningEvidence']
        self.assertEqual(settled['beforeReview'], observation['beforeReview'])
        self.assertIn('afterReview', settled)

    def test_review_only_sources_are_registered_for_reviews_but_not_new_ai_units(self):
        self.fixture.result_card()
        catalog = server.planning_catalog.load_planning_catalog(self.vault, index_gateway.load_gateway(self.vault))
        self.assertIn('practice:stable-card', [item['itemKey'] for item in catalog.get('practiceSources', [])])
        self.assertFalse(any(unit['action']['kind'] == 'practice' and 'practice:stable-card' in unit['action']['itemKeys'] for subject in catalog['subjects'] for unit in subject['units']))

    def test_review_schedule_changes_do_not_look_like_source_content_replacements(self):
        card = self.fixture.result_card()
        def fingerprint():
            return index_gateway.load_gateway(self.vault)['bindings']['practice:stable-card']['signature']
        before = fingerprint()
        payload = self.fixture.fixture.make_v3_activity('stable-content-hash', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        self.fixture.accept(payload)
        self.assertEqual(fingerprint(), before)
        card.write_text(card.read_text(encoding='utf-8').replace('Stable review point', 'Changed learning content'), encoding='utf-8')
        self.assertNotEqual(fingerprint(), before)

    def test_machine_review_queue_never_becomes_part_of_the_answer(self):
        card = self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('review-answer-boundary', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        self.fixture.accept(payload)
        parsed = server.learning_result.parse_result_file(self.vault, card)
        self.assertEqual(parsed['reviewPoints'], ['Stable review point'])
        item = server.practice_engine.build_base_item(parsed, {})
        self.assertEqual(item['answer'], 'Stable review point')
        self.assertNotIn('attempts:', item['explanation'])

    def test_after_state_uses_all_remaining_queue_entries_not_only_the_practiced_one(self):
        card = self.fixture.result_card();relative = card.relative_to(self.vault).as_posix()
        server.review_queue.apply_result(self.vault, relative, {'name': 'Stable review point'}, 'good', event_id='fixture-prior-good')
        server.review_queue.apply_result(self.vault, relative, {'name': 'Another pending point'}, 'again', event_id='fixture-other-point')
        payload = self.fixture.fixture.make_v3_activity('queue-after-observation', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        self.fixture.accept(payload)
        self.assertTrue(self.records()[0]['planningEvidence']['afterReview']['enabled'])
        self.assertEqual([item['name'] for item in server.review_queue.read_queue(self.vault, relative)], ['Another pending point'])

    def test_one_word_library_is_not_reread_once_per_word_during_context_loading(self):
        root = self.fixture.builder.subject('many-words', 'three-stage', 'legacy')
        source = self.fixture.builder.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| 单词 | 释义 |\n|---|---|\n' + ''.join(f'| term{i} | meaning{i} |\n' for i in range(60)))
        gateway = index_gateway.load_gateway(self.vault)
        read = index_gateway._read
        with mock.patch.object(index_gateway, '_read', wraps=read) as observed:
            catalog = server.planning_catalog.load_planning_catalog(self.vault, gateway)
        self.assertEqual(len(next(s for s in catalog['subjects'] if s['subjectId'] == 'many-words')['words']), 60)
        self.assertLessEqual(sum(call.args[0] == source for call in observed.call_args_list), 1)

    def test_context_exposes_current_source_demands_and_verified_unit_progress(self):
        card = self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('context-practice-event', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        payload['event']['occurredAt'] = '2026-08-31T01:00:00.000Z';payload['event']['scheduling']['reviewedAt'] = payload['event']['occurredAt']
        payload['event']['coreHash'] = server.compute_study_event_core_hash(payload['event'])
        self.fixture.accept(payload)
        catalog = index_gateway.load_gateway(self.vault)
        unit = server.planning_catalog.load_planning_catalog(self.vault, catalog)['practiceSources'][0]
        event = test_task_events.sealed(subjectId=self.fixture.root.split('/')[-1], unitIds=[], taskId='manual-free-context')
        task_events.append_task_event(self.vault, catalog, 'account', event)
        context = planning_evidence.build_context(self.vault, catalog, 'account', server.validate_study_event_v3)
        self.assertEqual(context['planRevision'], 0)
        self.assertEqual(context['sourceReviews'][0]['itemKey'], unit['itemKey'])
        self.assertEqual(context['sourceReviews'][0]['state']['enabled'], server.learning_result.parse_result_file(self.vault, card)['reviewEnabled'])
        subject = context['catalog']['subjects'][0]
        self.assertEqual(subject['lastProgressAt'], event['occurredAt'])

    def test_capture_revision_becomes_a_timed_review_demand_without_fabricating_a_subject(self):
        import plan_area, plan_authority
        from test_plan_area import make_candidate
        card = self.fixture.result_card();parsed = server.learning_result.parse_result_file(self.vault, card)
        area = plan_area.plan_area_root(self.vault)
        plan_area.apply_plan_revision(area, make_candidate(), 'fixture', 'test', 0)
        plan_authority.add_review_item(self.vault, {'itemId': parsed['itemId'], 'abilityId': parsed['abilityId'], 'stateRef': parsed['stateRef'], 'due': '2026-08-31'}, 1, capture_id='context-capture')
        context = planning_evidence.build_context(self.vault, index_gateway.load_gateway(self.vault), 'account', server.validate_study_event_v3)
        demand = context['captureReviews'][0]
        self.assertEqual(demand['subjectId'], 'astronomy-fixture')
        self.assertEqual(demand['itemKey'], 'practice:stable-card')
        self.assertEqual(demand['dueAt'], '2026-08-31T00:00:00+08:00')
        self.assertFalse(demand.get('blockedReason'))
        self.assertEqual(context['planRevision'], 2)

    def test_old_self_report_cannot_complete_a_now_formal_unit_for_ai_selection(self):
        import test_planning_catalog as planning_fixtures
        import plan_suggestions
        builder = planning_fixtures.PlanningCatalogTests();builder.setUp();self.addCleanup(builder.doCleanups)
        task_events.append_task_event(builder.vault, index_gateway.load_gateway(builder.vault), 'account', test_task_events.SAMPLE)
        builder.write_goals(rule='formal-mastered', basis='formal-state')
        builder.goal_path.write_text('\n'.join(line for line in builder.goal_path.read_text(encoding='utf-8').splitlines() if not line.startswith('| study |')) + '\n', encoding='utf-8')
        context = planning_evidence.build_context(builder.vault, index_gateway.load_gateway(builder.vault), 'account', server.validate_study_event_v3)
        catalog = context['catalog'];unit = catalog['subjects'][0]['units'][0]
        self.assertFalse(unit['formalComplete']);self.assertFalse(unit['taskComplete'])
        request = {'day': '2026-08-31', 'sourceHash': catalog['sourceHash'], 'draftVersion': 1, 'excludedUnitIds': [], 'selectedUnitIds': [], 'intent': 'standard'}
        result = plan_suggestions.suggest_tasks(catalog, request, lambda _: None)
        self.assertEqual(result['selections'][0]['unitIds'], ['astronomy:orbit'])

    def test_unchanged_history_is_validated_once_and_returned_records_cannot_mutate_the_snapshot(self):
        self.fixture.accept(self.fixture.payload('cached-record-001'))
        gateway = index_gateway.load_gateway(self.vault)
        validator = mock.Mock(wraps=server.validate_study_event_v3)
        first = planning_evidence.read_records(self.vault, gateway, 'account', validator)
        first[0]['event']['attempt']['correct'] = False
        second = planning_evidence.read_records(self.vault, gateway, 'account', validator)
        self.assertTrue(second[0]['event']['attempt']['correct'])
        self.assertEqual(validator.call_count, 1)
        self.fixture.accept(self.fixture.payload('cached-record-002'))
        self.assertEqual(len(planning_evidence.read_records(self.vault, index_gateway.load_gateway(self.vault), 'account', validator)), 2)
        self.assertEqual(validator.call_count, 3)

    def test_evidence_pages_bind_source_and_plan_revision_and_preserve_all_rows(self):
        gateway = index_gateway.load_gateway(self.vault)
        binding = gateway['bindings'][self.fixture.key]
        for index in range(103):
            event = self.fixture.payload(f'page-evidence-{index:03d}')['event']
            index_gateway.record_subject_event(self.vault, binding, 'account', event, {})
        first = planning_evidence.evidence_page(self.vault, gateway, 'account', server.validate_study_event_v3, source_hash='a' * 64, plan_revision=1)
        second = planning_evidence.evidence_page(self.vault, gateway, 'account', server.validate_study_event_v3, source_hash='a' * 64, plan_revision=1, after=first['nextCursor'])
        self.assertEqual(len(first['records']), 100);self.assertEqual(len(second['records']), 3);self.assertIsNone(second['nextCursor'])
        with self.assertRaisesRegex(ValueError, 'history-changed'):
            planning_evidence.evidence_page(self.vault, gateway, 'account', server.validate_study_event_v3, source_hash='b' * 64, plan_revision=1, after=first['nextCursor'])
        with self.assertRaisesRegex(ValueError, 'history-changed'):
            planning_evidence.evidence_page(self.vault, gateway, 'account', server.validate_study_event_v3, source_hash='a' * 64, plan_revision=2, after=first['nextCursor'])

    def test_manual_edit_after_machine_write_is_not_sealed_as_the_machine_after_state(self):
        card = self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('after-state-race', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        write = server.review_queue.apply_result;actual = {}
        def write_then_edit(*args, **kwargs):
            result = write(*args, **kwargs)
            actual.update(server.learning_result.parse_result_file(self.vault, card))
            card.write_text(card.read_text(encoding='utf-8').replace('review_date: ' + actual['reviewDate'], 'review_date: 2026-08-01'), encoding='utf-8')
            return result
        with mock.patch.object(server.review_queue, 'apply_result', side_effect=write_then_edit):
            self.fixture.accept(payload)
        after = self.records()[0]['planningEvidence']['afterReview']
        self.assertEqual(after['dueAt'], actual['reviewDate'] + 'T00:00:00+08:00')
        self.assertEqual(server.learning_result.parse_result_file(self.vault, card)['reviewDate'], '2026-08-01')

    def test_context_does_not_combine_an_old_gateway_with_new_source_hash(self):
        card = self.fixture.result_card();old = index_gateway.load_gateway(self.vault)
        card.write_text(card.read_text(encoding='utf-8').replace('review_date: 2026-01-01', 'review_date: 2026-09-30'), encoding='utf-8')
        context = planning_evidence.build_context(self.vault, old, 'account', server.validate_study_event_v3)
        self.assertEqual(context['sourceReviews'][0]['state']['dueAt'], '2026-09-30T04:00:00+08:00')

    def test_removed_v2_capture_source_keeps_its_saved_identity(self):
        import plan_area, plan_authority
        from test_task_plan_authority import SAMPLE, sealed
        card = self.fixture.result_card();catalog = index_gateway.load_gateway(self.vault)
        binding = catalog['bindings']['practice:stable-card']
        area = plan_area.plan_area_root(self.vault)
        plan_area.apply_plan_revision(area, sealed(SAMPLE), 'fixture', 'test', 0)
        item = {key: binding[key] for key in ('itemId', 'abilityId', 'stateRef', 'sourceNote')};item['due'] = '2026-08-31'
        plan_authority.add_review_item(self.vault, item, 1, capture_id='removed-capture-source')
        before = planning_evidence.build_context(self.vault, catalog, 'account', server.validate_study_event_v3)['captureReviews'][0]
        card.unlink()
        after = planning_evidence.build_context(self.vault, index_gateway.load_gateway(self.vault), 'account', server.validate_study_event_v3)['captureReviews'][0]
        for key in ('roundId', 'subjectId', 'itemKey'):
            self.assertEqual(after[key], before[key])
        self.assertTrue(after['blockedReason'])

    def test_correct_practice_does_not_complete_a_formal_practice_unit(self):
        import test_planning_catalog as planning_fixtures
        import plan_suggestions
        builder = planning_fixtures.PlanningCatalogTests();builder.setUp();self.addCleanup(builder.doCleanups)
        builder.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: recall\nstatus: ready\n---\n| ID | 题干 | 答案 |\n|---|---|---|\n| q1 | Formal task | Answer |\n', encoding='utf-8')
        builder.write_goals(rule='formal-mastered', basis='formal-state')
        builder.goal_path.write_text('\n'.join(line.replace('| open-note |', '| practice |') for line in builder.goal_path.read_text(encoding='utf-8').splitlines() if not line.startswith('| study |')) + '\n', encoding='utf-8')
        gateway = index_gateway.load_gateway(builder.vault);key, binding = next(iter(gateway['bindings'].items()))
        event = self.fixture.fixture.make_v3_activity('formal-practice-success', item_key=key)['event']
        index_gateway.record_subject_event(builder.vault, binding, 'account', event, {})
        context = planning_evidence.build_context(builder.vault, gateway, 'account', server.validate_study_event_v3)
        catalog = context['catalog'];unit = catalog['subjects'][0]['units'][0]
        self.assertFalse(unit['formalComplete']);self.assertFalse(unit['taskComplete'])
        request = {'day': '2026-08-31', 'sourceHash': catalog['sourceHash'], 'draftVersion': 1, 'excludedUnitIds': [], 'selectedUnitIds': [], 'intent': 'standard'}
        self.assertEqual(plan_suggestions.suggest_tasks(catalog, request, lambda _: None)['selections'][0]['unitIds'], ['astronomy:orbit'])

    def test_source_change_during_catalog_read_is_rejected_instead_of_mixed(self):
        card = self.fixture.result_card();gateway = index_gateway.load_gateway(self.vault)
        load = server.planning_catalog.load_planning_catalog;changed = False
        def changing(vault, catalog):
            nonlocal changed
            if not changed:
                changed = True
                card.write_text(card.read_text(encoding='utf-8').replace('review_date: 2026-01-01', 'review_date: 2026-09-30'), encoding='utf-8')
            return load(vault, catalog)
        with mock.patch.object(server.planning_catalog, 'load_planning_catalog', side_effect=changing), self.assertRaisesRegex(ValueError, 'source-changed'):
            planning_evidence.build_context(self.vault, gateway, 'account', server.validate_study_event_v3)

    def test_later_failure_does_not_roll_back_a_manual_edit_after_queue_write(self):
        card = self.fixture.result_card()
        payload = self.fixture.fixture.make_v3_activity('after-edit-rollback', item_key='practice:stable-card', state_ref=self.fixture.root + '/state.md', ability_id='card-ability')
        write = server.review_queue.apply_result
        def write_then_edit(*args, **kwargs):
            result = write(*args, **kwargs)
            current = server.learning_result.parse_result_file(self.vault, card)
            card.write_text(card.read_text(encoding='utf-8').replace('review_date: ' + current['reviewDate'], 'review_date: 2026-08-01') + '\nManual tail\n', encoding='utf-8')
            return result
        with mock.patch.object(server.review_queue, 'apply_result', side_effect=write_then_edit), mock.patch.object(planning_evidence, 'update_record', side_effect=OSError('fixture write failure')):
            with self.assertRaises(OSError):
                self.fixture.accept(payload)
        self.assertEqual(server.learning_result.parse_result_file(self.vault, card)['reviewDate'], '2026-08-01')
        self.assertIn('Manual tail', card.read_text(encoding='utf-8'))
