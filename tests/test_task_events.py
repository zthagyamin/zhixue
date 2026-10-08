"""Independent task journals never become V3 practice or formal mastery."""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock
import test_planning_catalog as fixtures
import index_gateway

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
try:
    import task_events
except ImportError:
    task_events = None
SAMPLE = json.loads((Path(__file__).parent / 'fixtures/task-event-v1.json').read_text(encoding='utf-8'))


def sealed(**changes):
    value = {**copy.deepcopy(SAMPLE), **changes}
    value.pop('coreHash', None)
    value['coreHash'] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return value


class TaskEventTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(task_events, 'Task event journal must exist')
        self.builder = fixtures.PlanningCatalogTests()
        self.builder.setUp()
        self.addCleanup(self.builder.doCleanups)
        self.vault = self.builder.vault
        self.catalog = index_gateway.load_gateway(self.vault)

    def append(self, event=None, account='a', **options):
        return task_events.append_task_event(self.vault, self.catalog, account, event or SAMPLE, **options)

    def read(self, account='a'):
        return task_events.read_task_events(self.vault, self.catalog, account)

    def test_shared_wire_fixture_hash_and_rejected_mastery_fields(self):
        self.assertEqual(task_events.validate_task_event(SAMPLE), SAMPLE)
        with self.assertRaises(ValueError):
            task_events.validate_task_event({**SAMPLE, 'mastery': 'mastered'})
        with self.assertRaises(ValueError):
            task_events.validate_task_event({**SAMPLE, 'taskId': 'changed'})
        with self.assertRaises(ValueError):
            task_events.validate_task_event(sealed(day='2026-08-30'))
        with self.assertRaises(ValueError):
            task_events.validate_task_event(sealed(source='evidence', evidenceRefs=['event-001'], unitIds=[]))

    def test_task_journal_is_subject_local_idempotent_and_account_isolated(self):
        self.assertEqual(self.append()['status'], 'accepted')
        self.assertEqual(self.append()['status'], 'duplicate')
        self.append(account='b')
        self.assertEqual(self.read(), [SAMPLE])
        self.assertEqual(self.read('b'), [SAMPLE])
        self.assertEqual(self.read('empty'), [])
        files = list(self.vault.rglob('*.jsonl'))
        self.assertTrue(all(path.is_relative_to(self.vault / 'subjects/astronomy/records') for path in files))
        rows = [json.loads(line) for path in files for line in path.read_text(encoding='utf-8').splitlines()]
        self.assertTrue(all(row['recordKind'] == 'task-event-v1' for row in rows))

    def test_task_completion_does_not_change_practice_projection_or_formal_files(self):
        before = {path.relative_to(self.vault): path.read_bytes() for path in self.vault.rglob('*.md')}
        self.append()
        self.assertEqual(index_gateway.progress_events(self.vault, self.catalog, 'a'), [])
        self.assertEqual(before, {path.relative_to(self.vault): path.read_bytes() for path in self.vault.rglob('*.md')})

    def test_conflict_is_rejected_and_original_evidence_survives(self):
        self.append()
        with self.assertRaisesRegex(ValueError, 'conflict'):
            self.append(sealed(taskId='different-task'))
        self.assertEqual(self.read(), [SAMPLE])

    def test_unknown_subject_unit_or_non_self_report_rule_is_rejected(self):
        for event in (sealed(subjectId='outside'), sealed(unitIds=['astronomy:missing'])):
            with self.assertRaises(ValueError):
                self.append(event)
        self.builder.write_goals(rule='formal-mastered', basis='formal-state')
        with self.assertRaises(ValueError):
            self.append()
        self.assertEqual(list(self.vault.rglob('*.jsonl')), [])

    def test_free_manual_todo_still_belongs_to_one_registered_subject(self):
        value = sealed(unitIds=[], taskId='manual-free-task')
        self.append(value)
        self.assertEqual(self.read(), [value])

    def test_source_evidence_cannot_be_invented_or_reuse_unrelated_reports(self):
        with self.assertRaises(ValueError):
            self.append(sealed(source='evidence', evidenceRefs=['missing-evidence']))

    def test_complete_pagination_is_account_scoped_and_detects_mid_read_changes(self):
        for i in range(103):
            self.append(sealed(eventId=f'task-event-{i:03d}', taskId=f'manual-{i}'))
        first = task_events.task_event_page(self.vault, self.catalog, 'a')
        self.assertEqual(len(first['events']), 100)
        second = task_events.task_event_page(self.vault, self.catalog, 'a', first['nextCursor'])
        self.assertEqual(len(second['events']), 3)
        self.assertIsNone(second['nextCursor'])
        self.assertEqual(task_events.task_event_page(self.vault, self.catalog, 'b')['events'], [])
        self.append(sealed(eventId='task-event-backdated', occurredAt='2026-08-31T01:00:00.000Z'))
        with self.assertRaisesRegex(ValueError, 'history-changed'):
            task_events.task_event_page(self.vault, self.catalog, 'a', first['nextCursor'])

    def test_practice_evidence_must_be_verified_complete_related_and_on_the_task_day(self):
        import test_companion as practice_fixture
        server = practice_fixture.server
        self.builder.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: recall\nstatus: ready\n---\n| ID | 题干 | 答案 |\n|---|---|---|\n| q1 | Question | Answer |\n', encoding='utf-8')
        self.builder.write_goals(rule='graded-practice', basis='practice-round')
        self.builder.goal_path.write_text(self.builder.goal_path.read_text(encoding='utf-8').replace('| open-note |', '| practice |'), encoding='utf-8')
        self.catalog = index_gateway.load_gateway(self.vault)
        key, binding = next(iter(self.catalog['bindings'].items()))
        attempt = practice_fixture.CompanionSyncTests().make_v3_activity('practice-event-001', item_key=key)['event']
        attempt['occurredAt'] = '2026-08-31T01:00:00.000Z'
        attempt['scheduling']['reviewedAt'] = attempt['occurredAt']
        attempt['coreHash'] = server.compute_study_event_core_hash(attempt)
        index_gateway.record_subject_event(self.vault, binding, 'a', attempt, {'abilityId': binding['abilityId']})
        task = sealed(source='evidence', evidenceRefs=[attempt['eventId']])
        with self.assertRaises(ValueError):
            self.append(task)
        self.assertEqual(self.append(task, validate_practice_event=server.validate_study_event_v3)['status'], 'accepted')
        self.assertEqual(self.read(), [task])
        with self.assertRaises(ValueError):
            self.append(sealed(eventId='task-event-next-day', source='evidence', evidenceRefs=[attempt['eventId']], day='2026-09-01', occurredAt='2026-09-01T02:00:00.000Z'), validate_practice_event=server.validate_study_event_v3)

    def test_failed_atomic_write_can_retry_without_duplicating_evidence(self):
        with mock.patch.object(task_events.os, 'replace', side_effect=OSError('fixture unavailable')):
            with self.assertRaises(OSError):
                self.append()
        self.assertEqual(self.read(), [])
        self.assertEqual(self.append()['status'], 'accepted')
        self.assertEqual(self.read(), [SAMPLE])

    def test_history_is_read_after_registered_record_root_moves(self):
        self.append()
        old = self.vault / 'subjects/astronomy/records'
        new = self.vault / 'subjects/astronomy/history'
        old.rename(new)
        self.builder.index.write_text(self.builder.index.read_text(encoding='utf-8').replace('subjects/astronomy/records', 'subjects/astronomy/history'), encoding='utf-8')
        self.catalog = index_gateway.load_gateway(self.vault)
        self.assertEqual(self.read(), [SAMPLE])

    def test_old_task_records_cannot_be_reassigned_to_a_different_registered_subject(self):
        self.append()
        self.catalog['planningDefinitions'][0]['id'] = 'new-owner'
        with self.assertRaisesRegex(ValueError, 'subject'):
            self.read()

    def test_corrupt_and_unknown_record_kinds_are_not_silently_dropped(self):
        self.append()
        path = next(self.vault.rglob('*.jsonl'))
        original = path.read_text(encoding='utf-8')
        row = json.loads(original)
        for mutate in (lambda row: row.update(recordKind='unknown'), lambda row: row['event'].update(taskId='tampered')):
            damaged = copy.deepcopy(row);mutate(damaged)
            path.write_text(json.dumps(damaged) + '\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                self.read()
            with self.assertRaises(ValueError):
                index_gateway.progress_events(self.vault, self.catalog, 'a')
        path.write_text(original, encoding='utf-8')
        self.assertEqual(self.read(), [SAMPLE])
