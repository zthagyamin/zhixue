import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
import gateway_cli
import index_gateway
import planning_catalog

if importlib.util.find_spec('planning_migration'):
    import planning_migration as migration
else:
    migration = None

CONTENT = '''| goal_id | title | target_kind | target_count | unit_ids | start_on | due_on | priority | required | completion_basis |
|---|---|---|---|---|---|---|---|---|---|
| daily | Read one lesson | daily | 1 | lesson | 2026-08-31 | | 3 | true | self-report |

| unit_id | title | content_ref | state_ref | ability_id | order | prerequisites | action | completion_rule |
|---|---|---|---|---|---|---|---|---|
| lesson | Lesson | [[subjects/course/lesson]] | | | 1 | | open-note | self-report |
'''


class PlanningMigrationTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(migration, 'Explicit planning migration preview must exist')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        gateway_cli.add_subject(self.vault, 'course', 'Course', 'course', 'recall', 'subjects/course', 20)
        gateway_cli.add_subject(self.vault, 'words', 'Words', 'ielts', 'three-stage', 'subjects/words', 20)
        (self.vault / 'subjects/course/lesson.md').write_bytes(b'# Source lesson\r\n\r\nOriginal material.\r\n')
        (self.vault / 'subjects/words/words.md').write_text('---\ntype: vocabulary-database\n---\n| word | meaning |\n|---|---|\n| tree | A tree |\n', encoding='utf-8')
        self.index = self.vault / index_gateway.GATEWAY_ROOT / 'subjects/course.md'
        self.proposals = [{'subjectId': 'course', 'planningPath': 'subjects/course/goals.md', 'planningContent': CONTENT}]

    def snapshot(self):
        return {p.relative_to(self.vault).as_posix(): p.read_bytes() for p in self.vault.rglob('*') if p.is_file()}

    def test_preview_is_read_only_and_apply_adds_only_declared_targets(self):
        before = self.snapshot()
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual({t['relativePath'] for t in manifest['targets']}, {self.index.relative_to(self.vault).as_posix(), 'subjects/course/goals.md'})
        receipt = migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(receipt['status'], 'applied')
        self.assertEqual((self.vault / 'subjects/course/lesson.md').read_bytes(), before['subjects/course/lesson.md'])
        catalog = planning_catalog.load_planning_catalog(self.vault, index_gateway.load_gateway(self.vault))
        course = next(s for s in catalog['subjects'] if s['subjectId'] == 'course')
        self.assertEqual(course['planningStatus'], 'ready')
        self.assertEqual(course['goals'][0]['targetCount'], 1)
        self.assertEqual(migration.preview_planning_migration(self.vault, self.proposals)['targets'], [])

    def test_source_change_aborts_before_any_target_write(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        self.index.write_text(self.index.read_text(encoding='utf-8') + '\nUser addition\n', encoding='utf-8')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'stale-migration-source'):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(self.snapshot(), before)

    def test_referenced_lesson_change_invalidates_the_preview_even_when_targets_are_unchanged(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        (self.vault / 'subjects/course/lesson.md').write_text('# Changed lesson\n', encoding='utf-8')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'stale-migration-source'):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(self.snapshot(), before)

    def test_existing_planning_original_bytes_and_backup_are_preserved(self):
        path = self.vault / 'subjects/course/goals.md'
        original = '\ufeff---\r\nplanning_schema_version: 1\r\n---\r\n# Existing\r\n\r\nKeep my narrative.\r\n'.encode('utf-8')
        path.write_bytes(original)
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        receipt = migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertIn(b'# Existing\r\n\r\nKeep my narrative.\r\n', path.read_bytes())
        self.assertEqual((Path(receipt['backupRoot']) / 'subjects/course/goals.md').read_bytes(), original)

    def test_paths_cannot_escape_subject_or_touch_progress_records_and_original_material(self):
        for target in ['../outside.md', 'subjects/words/goals.md', 'subjects/course/知学练习/学习状态.md',
                       'subjects/course/知学练习/记录/record.md', 'subjects/course/lesson.md']:
            with self.subTest(target=target), self.assertRaises(ValueError):
                migration.preview_planning_migration(self.vault, [{**self.proposals[0], 'planningPath': target}])

    def test_invalid_or_unresolved_goals_never_become_an_appliable_manifest(self):
        for content in ['Study harder every day.', CONTENT.replace('[[subjects/course/lesson]]', '[[subjects/course/missing]]'),
                        CONTENT.replace('| daily | Read one lesson | daily | 1 |', '| daily | Read one lesson | daily | many |')]:
            with self.subTest(content=content), self.assertRaises(ValueError):
                migration.preview_planning_migration(self.vault, [{**self.proposals[0], 'planningContent': content}])

    def test_language_is_explicit_and_does_not_create_a_goal(self):
        manifest = migration.preview_planning_migration(self.vault, [{'subjectId': 'words', 'language': 'en'}])
        self.assertEqual(len(manifest['targets']), 1)
        migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        catalog = planning_catalog.load_planning_catalog(self.vault, index_gateway.load_gateway(self.vault))
        words = next(s for s in catalog['subjects'] if s['subjectId'] == 'words')
        self.assertEqual(words['words'][0]['language'], 'en')
        self.assertEqual(words['goals'], [])

    def test_tampered_manifest_is_rejected(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        manifest['targets'][0]['content'] += '\nnot previewed'
        with self.assertRaisesRegex(ValueError, 'manifest-integrity'):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')

    def test_mid_write_failure_rolls_back_and_keeps_backups(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        before = self.snapshot()
        writer = migration._atomic_write
        count = 0
        def fail_second(path, data):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('fixture write failure')
            return writer(path, data)
        with mock.patch.object(migration, '_atomic_write', side_effect=fail_second), self.assertRaisesRegex(OSError, 'fixture write failure'):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(list((self.root / 'backups').rglob('receipt.json')))

    def test_failure_reported_after_replace_also_restores_that_target(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        before = self.snapshot()
        writer = migration._atomic_write
        count = 0
        def fail_after_second(path, data):
            nonlocal count
            count += 1
            writer(path, data)
            if count == 2:
                raise OSError('after replace')
        with mock.patch.object(migration, '_atomic_write', side_effect=fail_after_second), self.assertRaisesRegex(OSError, 'after replace'):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(self.snapshot(), before)

    def test_roll_back_successful_apply_restores_original_bytes_and_removes_only_new_targets(self):
        before = self.snapshot()
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        receipt = migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        restored = migration.rollback_planning_migration(self.vault, Path(receipt['backupRoot']))
        self.assertEqual(restored['status'], 'rolled-back')
        self.assertEqual(self.snapshot(), before)

    def test_rollback_refuses_later_user_edits_before_changing_any_target(self):
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        receipt = migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.index.write_text(self.index.read_text(encoding='utf-8') + '\nLater edit\n', encoding='utf-8')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'stale-migration-source'):
            migration.rollback_planning_migration(self.vault, Path(receipt['backupRoot']))
        self.assertEqual(self.snapshot(), before)

    def test_rollback_io_failure_returns_to_the_applied_state_and_can_be_retried(self):
        (self.vault / 'subjects/course/goals.md').write_text('---\nplanning_schema_version: 1\n---\n# Existing\n', encoding='utf-8')
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        receipt = migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        applied = self.snapshot()
        writer = migration._atomic_write
        count = 0
        def fail_second(path, data):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('rollback failure')
            writer(path, data)
        with mock.patch.object(migration, '_atomic_write', side_effect=fail_second), self.assertRaisesRegex(OSError, 'rollback failure'):
            migration.rollback_planning_migration(self.vault, Path(receipt['backupRoot']))
        self.assertEqual(self.snapshot(), applied)
        self.assertEqual(migration.rollback_planning_migration(self.vault, Path(receipt['backupRoot']))['status'], 'rolled-back')

    def test_cli_previews_without_writes_then_explicitly_applies_and_rolls_back(self):
        proposals = self.root / 'proposals.json'
        proposals.write_text(json.dumps(self.proposals), encoding='utf-8')
        manifest = self.root / 'preview.json'
        before = self.snapshot()
        def run(*args):
            return subprocess.run([sys.executable, '-X', 'utf8', '-B', str(ROOT / 'scripts/prepare-task-planning.py'),
                                   '--vault', str(self.vault), *map(str, args)], capture_output=True, text=True, encoding='utf-8')
        preview = run('--proposals', proposals, '--manifest', manifest)
        self.assertEqual(preview.returncode, 0, preview.stderr or preview.stdout)
        self.assertEqual(self.snapshot(), before)
        duplicate = run('--proposals', proposals, '--manifest', manifest)
        self.assertNotEqual(duplicate.returncode, 0, 'An earlier approved preview must not be silently overwritten')
        refused = run('--apply', '--manifest', manifest)
        self.assertNotEqual(refused.returncode, 0)
        applied = run('--apply', '--manifest', manifest, '--backup-root', self.root / 'backups')
        self.assertEqual(applied.returncode, 0, applied.stderr or applied.stdout)
        receipt = json.loads(applied.stdout)
        restored = run('--rollback', '--backup-root', receipt['backupRoot'])
        self.assertEqual(restored.returncode, 0, restored.stderr or restored.stdout)
        self.assertEqual(self.snapshot(), before)

    def test_gateway_cli_supports_explicit_subject_language_without_inference(self):
        result = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(ROOT / 'companion/gateway_cli.py'),
                                 '--vault', str(self.vault), 'add-subject', '--id', 'extra', '--name', 'Extra',
                                 '--plugin', 'three-stage', '--root', 'subjects/extra', '--language', 'en'],
                                capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        index = self.vault / index_gateway.GATEWAY_ROOT / 'subjects/extra.md'
        self.assertEqual(index_gateway._meta(index.read_text(encoding='utf-8'))['language'], 'en')
        self.assertNotIn('language', index_gateway._meta(self.index.read_text(encoding='utf-8')))

    def test_preview_rejects_breaking_another_subjects_existing_dependency(self):
        migration.apply_planning_migration(self.vault, migration.preview_planning_migration(self.vault, self.proposals), self.root / 'backups')
        dependent = CONTENT.replace('subjects/course/lesson', 'subjects/words/words').replace('| 1 | | open-note |', '| 1 | course:lesson | open-note |')
        proposal = [{'subjectId': 'words', 'planningPath': 'subjects/words/goals.md', 'planningContent': dependent}]
        migration.apply_planning_migration(self.vault, migration.preview_planning_migration(self.vault, proposal), self.root / 'backups')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'invalid-planning-proposal'):
            migration.preview_planning_migration(self.vault, [{**self.proposals[0], 'planningContent': CONTENT.replace('| lesson |', '| lesson2 |')}])
        self.assertEqual(self.snapshot(), before)

    def test_preview_accepts_the_catalogs_plain_and_markdown_reference_forms(self):
        for ref in ['subjects/course/lesson.md', '[Lesson](subjects/course/lesson.md)']:
            with self.subTest(ref=ref):
                proposal = [{**self.proposals[0], 'planningContent': CONTENT.replace('[[subjects/course/lesson]]', ref)}]
                self.assertTrue(migration.preview_planning_migration(self.vault, proposal)['targets'])

    def test_failed_compensation_remains_safely_recoverable_after_io_returns(self):
        path = self.vault / 'subjects/course/goals.md'
        path.write_bytes(b'---\nplanning_schema_version: 1\n---\n# Existing\n')
        before = self.snapshot()
        manifest = migration.preview_planning_migration(self.vault, self.proposals)
        writer, count = migration._atomic_write, 0
        def fail_after_first(path, data):
            nonlocal count
            count += 1
            if count >= 2:
                raise OSError('disk still unavailable')
            writer(path, data)
        with mock.patch.object(migration, '_atomic_write', side_effect=fail_after_first), self.assertRaises(OSError):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        backup = next((self.root / 'backups').glob('planning-*'))
        self.assertEqual(migration.rollback_planning_migration(self.vault, backup)['status'], 'rolled-back')
        self.assertEqual(self.snapshot(), before)

    def test_parent_subject_cannot_write_inside_a_nested_subject_or_its_records(self):
        gateway_cli.add_subject(self.vault, 'nested', 'Nested', 'nested', 'recall', 'subjects/course/subcourse', 20)
        for relative in ['subjects/course/subcourse/知学练习/记录/goals.md', 'subjects/course/subcourse/goals.md']:
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                migration.preview_planning_migration(self.vault, [{**self.proposals[0], 'planningPath': relative}])

    def test_cross_subject_goal_only_table_uses_the_readers_valid_dependency_contract(self):
        migration.apply_planning_migration(self.vault, migration.preview_planning_migration(self.vault, self.proposals), self.root / 'backups')
        content = CONTENT.split('\n\n', 1)[0].replace('| lesson |', '| course:lesson |') + '\n'
        proposal = [{'subjectId': 'words', 'planningPath': 'subjects/words/goals.md', 'planningContent': content}]
        self.assertTrue(migration.preview_planning_migration(self.vault, proposal)['targets'])

    def test_unreadable_partial_target_does_not_prevent_restoring_other_targets(self):
        proposals = self.proposals + [{'subjectId': 'words', 'planningPath': 'subjects/words/goals.md',
                                      'planningContent': CONTENT.replace('subjects/course/lesson', 'subjects/words/words')}]
        before = self.snapshot()
        manifest = migration.preview_planning_migration(self.vault, proposals)
        writer, reader, count, failed = migration._atomic_write, migration._read, 0, False
        def fail_fourth(path, data):
            nonlocal count, failed
            count += 1
            if count == 4:
                failed = True
                raise OSError('fourth write failed')
            writer(path, data)
        def deny_one(path):
            if failed and path == self.vault / 'subjects/words/goals.md':
                raise PermissionError('one target temporarily unreadable')
            return reader(path)
        with mock.patch.object(migration, '_atomic_write', side_effect=fail_fourth), mock.patch.object(migration, '_read', side_effect=deny_one), self.assertRaises(OSError):
            migration.apply_planning_migration(self.vault, manifest, self.root / 'backups')
        self.assertEqual(self.index.read_bytes(), before[self.index.relative_to(self.vault).as_posix()])
        self.assertFalse((self.vault / 'subjects/course/goals.md').exists())
        backup = next((self.root / 'backups').glob('planning-*'))
        self.assertEqual(json.loads((backup / 'receipt.json').read_text(encoding='utf-8'))['status'], 'rollback-conflict')
        migration.rollback_planning_migration(self.vault, backup)
        self.assertEqual(self.snapshot(), before)

    def test_preview_copies_canonical_practice_binding_sources_and_states(self):
        (self.vault / 'subjects/course/source.md').write_text('# Original source\n', encoding='utf-8')
        (self.vault / 'subjects/course/state.md').write_text('# Subject status\n', encoding='utf-8')
        (self.vault / 'subjects/course/lesson.md').write_text('---\nzhixue: true\nzhixue_id: lesson\nzhixue_format: recall\n---\n'
            '| ID | prompt | answer | sourceNote | state_ref |\n|---|---|---|---|---|\n| q1 | Question | Answer | source.md | state.md |\n', encoding='utf-8')
        body = CONTENT.replace('| true | self-report |', '| true | practice-round |').replace('| open-note | self-report |', '| practice | graded-practice |')
        manifest = migration.preview_planning_migration(self.vault, [{**self.proposals[0], 'planningContent': body}])
        self.assertIn('subjects/course/source.md', manifest['sourceHashes'])
        self.assertIn('subjects/course/state.md', manifest['sourceHashes'])


if __name__ == '__main__':
    unittest.main()
