"""Read-only native capture uses registered temporary sources; no model calls."""
import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import index_gateway as gateway
from assistance_binding import binding_hash
from account_sync_schema import study_hash
from course_study_domain import course_task_hash, resolve_course_task
from infrastructure.course_source_capture import NativeCourseSources
from vault_identity import local_vault_library_id

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/course-task-support-v2.json')
                     .read_text(encoding='utf-8'))
OWNER = '1' * 64


class NativeCourseSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.vault = self.data / 'vault'
        self.vault.mkdir()
        self.entry = '_System/Integrations/Study Loop/gateway'
        self.write(self.entry + '/index.md', '---\ntype: zhixue-gateway\nschema_version: 1\n---\n')
        self.write('courses/state.md', '---\ntype: zhixue-practice-state\n---\n')
        self.write(self.entry + '/subjects/course.md', '''---
type: zhixue-subject-index
schema_version: 1
subject_id: course
name: Course
domain: course
plugin: recall
content_root: courses
progress_ref: "[[courses/state]]"
records_root: courses/records
identity: scoped
enabled: true
auto: true
---
''')
        self.support = copy.deepcopy(FIXTURE['cases'][0]['support'])
        self.source()
        self.db = self.data / 'native-course.db'
        self.calls = []
        self.service = NativeCourseSources(self.vault, OWNER, self.loader, self.db)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, ref, text):
        path = self.vault / ref
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def source(self, *, answer='', explanation='', filename='lesson.md', doc='lesson', mode='recall'):
        config = json.dumps(self.support, ensure_ascii=False, separators=(',', ':'))
        return self.write('courses/' + filename, f'''---
type: zhixue-content
zhixue: true
zhixue_id: {doc}
zhixue_format: {mode}
status: ready
---
| ID | 题干 | 参考答案 | 解析 | 学习配置 |
|---|---|---|---|---|
| q1 | {self.support['task']['prompt']} | {answer} | {explanation} | {config} |
''')

    def loader(self, vault, *, owner, refresh=False):
        self.assertEqual(owner, OWNER)
        self.assertFalse(refresh)
        self.calls.append(str(vault))
        return gateway.load_gateway(vault, refresh=False)

    def identity(self):
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(catalog['diagnostics'], [])
        item = catalog['subjects'][0]['items'][0]
        key = 'practice:' + item['itemId']
        return {'schemaVersion': 1, 'libraryId': local_vault_library_id(self.vault),
                'itemKey': key, 'contentHash': item['contentHash'],
                'localBindingHash': binding_hash(self.vault, gateway.lookup_binding(catalog, key))}

    def rows(self):
        if not self.db.exists():
            return 0
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute('SELECT count(*) FROM native_course_sources').fetchone()[0]

    def test_native_hash_and_full_authored_snapshot_are_preserved(self):
        identity = self.identity()
        originals = {path: path.read_bytes() for path in self.vault.rglob('*.md')}
        value = self.service.capture(identity)
        self.assertEqual(set(value), {'schemaVersion', 'captureId', 'identity', 'item', 'taskHash'})
        self.assertEqual(value['item']['contentHash'], identity['contentHash'])
        self.assertEqual(value['item']['itemKey'], identity['itemKey'])
        self.assertEqual(set(value['item']['practice']), {'questionType', 'prompt', 'domain'})
        self.assertEqual(value['item']['learningSupport'], self.support)
        self.assertEqual(value['taskHash'], course_task_hash(resolve_course_task(value['item'])))
        self.assertEqual(value['captureId'], study_hash({key: child for key, child in value.items() if key != 'captureId'}))
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertNotIn('courses/lesson.md', json.dumps(value))
        private = self.service.read_binding(identity, value['captureId'])
        self.assertEqual(private['binding']['documentPath'], 'courses/lesson.md')

    def test_replay_and_returned_mutation_do_not_change_durable_capture(self):
        identity = self.identity()
        first = self.service.capture(identity)
        expected = copy.deepcopy(first)
        first['item']['learningSupport']['task']['sources'][0]['excerpt'] = 'Untrusted mutation'
        self.assertEqual(self.service.capture(identity), expected)
        self.assertEqual(self.service.read(identity, expected['captureId']), expected)
        self.assertEqual(self.rows(), 1)

    def test_same_native_version_replay_preserves_original_managed_state_bytes(self):
        identity = self.identity()
        expected = self.service.capture(identity)
        original = self.service.read_binding(identity, expected['captureId'])
        self.write('courses/state.md', '---\ntype: zhixue-practice-state\n---\nNew review state\n')
        lesson = self.vault / 'courses/lesson.md'
        lesson.write_text(lesson.read_text(encoding='utf-8') + '''
%% ZHIXUE:REVIEW-QUEUE:BEGIN %%
Machine-owned queue changed.
%% ZHIXUE:REVIEW-QUEUE:END %%
''', encoding='utf-8')
        self.assertEqual(self.identity(), identity)
        self.assertEqual(self.service.capture(identity), expected)
        self.assertEqual(self.service.read_binding(identity, expected['captureId']), original)

    def test_removed_current_source_and_bom_do_not_break_historical_read(self):
        source = self.vault / 'courses/lesson.md'
        source.write_bytes(b'\xef\xbb\xbf' + source.read_bytes())
        identity = self.identity()
        expected = self.service.capture(identity)
        source.unlink()
        self.assertEqual(self.service.read(identity, expected['captureId']), expected)

    def test_lost_receipt_reopens_original_capture_and_commit_failure_adds_no_row(self):
        identity = self.identity()
        expected = self.service.capture(identity)
        reopened = NativeCourseSources(self.vault, OWNER, self.loader, self.db)
        self.assertEqual(reopened.capture(identity), expected)
        self.support['task']['sources'][0]['excerpt'] += ' Revised.'
        self.source()
        new_identity = self.identity()
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('simulated commit failure')
        def failing(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailedCommit)
        with mock.patch('infrastructure.course_source_capture.sqlite3.connect', side_effect=failing):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'commit failure'):
                self.service.capture(new_identity)
        self.assertEqual(self.rows(), 1)
        self.assertEqual(reopened.read(identity, expected['captureId']), expected)

    def test_actual_registered_quiz_support_preserves_option_references(self):
        self.support = copy.deepcopy(next(row['support'] for row in FIXTURE['cases']
                                          if row['mode'] == 'quiz' and row['valid']))
        self.source(mode='quiz')
        identity = self.identity()
        captured = self.service.capture(identity)
        self.assertEqual(captured['item']['practice']['questionType'], 'quiz')
        self.assertEqual(captured['item']['learningSupport']['options'], self.support['options'])
        self.assertEqual(captured['item']['contentHash'], identity['contentHash'])

    def test_adapter_empty_placeholders_only_and_nonempty_options_are_rejected(self):
        identity = self.identity()
        def placeholders(vault, *, owner, refresh=False):
            catalog = self.loader(vault, owner=owner, refresh=refresh)
            catalog['subjects'][0]['items'][0].update(reviewPoint='', options=[])
            return catalog
        self.service.catalog_loader = placeholders
        self.assertEqual(set(self.service.capture(identity)['item']['practice']), {'questionType', 'prompt', 'domain'})
        def duplicate(vault, *, owner, refresh=False):
            catalog = placeholders(vault, owner=owner, refresh=refresh)
            catalog['subjects'][0]['items'][0]['options'] = ['Second reference']
            return catalog
        self.service.catalog_loader = duplicate
        with self.assertRaisesRegex(ValueError, 'duplicate-course-reference'):
            self.service.capture(identity)

    def test_historical_read_never_loads_current_or_new_references(self):
        old_identity = self.identity()
        old = self.service.capture(old_identity)
        self.support['task']['sources'][0]['excerpt'] += ' New version.'
        self.support['task']['sources'][0]['version'] = 'b' * 64
        self.source()
        new_identity = self.identity()
        new = self.service.capture(new_identity)
        self.assertNotEqual(new['captureId'], old['captureId'])
        self.service.catalog_loader = lambda *args, **kwargs: self.fail('Historical read resolved current source')
        self.assertEqual(self.service.read(old_identity, old['captureId']), old)
        with self.assertRaisesRegex(ValueError, 'capture-not-found'):
            self.service.read(new_identity, old['captureId'])

    def test_stale_native_and_binding_identity_have_no_receipt(self):
        identity = self.identity()
        for key in ('contentHash', 'localBindingHash'):
            changed = {**identity, key: 'f' * 64}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'source-changed'):
                self.service.capture(changed)
        self.assertFalse(self.db.exists())
        self.write('courses/lesson.md', (self.vault / 'courses/lesson.md').read_text(encoding='utf-8') + '\nSource addition\n')
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.service.capture(identity)

    def test_owner_library_and_root_isolation(self):
        identity = self.identity()
        captured = self.service.capture(identity)
        other = NativeCourseSources(self.vault, '2' * 64, self.loader, self.db)
        with self.assertRaisesRegex(ValueError, 'capture-not-found'):
            other.read(identity, captured['captureId'])
        for key, value in (('libraryId', 'local-vault:' + 'f' * 64), ('owner', OWNER), ('schemaVersion', True)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.capture({**identity, key: value})
        alternate = self.data / 'another-vault'
        alternate.mkdir()
        other_root = NativeCourseSources(alternate, OWNER, self.loader, self.db)
        with self.assertRaisesRegex(ValueError, 'library-mismatch'):
            other_root.read(identity, captured['captureId'])

    def test_nonempty_duplicate_references_and_registration_collision_are_rejected(self):
        for key in ('answer', 'explanation'):
            self.source(**{key: 'A second reference'})
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'duplicate-course-reference'):
                self.service.capture(self.identity())
        self.source()
        self.source(filename='collision.md', answer='conflicting')
        with self.assertRaisesRegex(ValueError, 'catalog-incomplete'):
            self.service.capture({'schemaVersion': 1, 'libraryId': local_vault_library_id(self.vault),
                                  'itemKey': 'practice:course:lesson:q1', 'contentHash': 'a' * 64,
                                  'localBindingHash': 'b' * 64})
        self.assertFalse(self.db.exists())

    def test_torn_catalog_and_file_reads_have_no_durable_receipt(self):
        identity = self.identity()
        for during_catalog in (True, False):
            calls = 0
            def torn(vault, *, owner, refresh=False):
                nonlocal calls
                calls += 1
                catalog = self.loader(vault, owner=owner, refresh=refresh)
                if calls == 2:
                    path = self.vault / 'courses/lesson.md'
                    path.write_text(path.read_text(encoding='utf-8') + '\nChanged mid-read\n', encoding='utf-8')
                    if during_catalog:
                        catalog['subjects'][0]['name'] = 'Changed'
                return catalog
            self.service.catalog_loader = torn
            with self.subTest(catalog=during_catalog), self.assertRaisesRegex(ValueError, 'capture-conflict'):
                self.service.capture(identity)
            self.source()
        self.assertFalse(self.db.exists())

    def test_tampered_stored_capture_is_rejected(self):
        identity = self.identity()
        captured = self.service.capture(identity)
        with closing(sqlite3.connect(self.db)) as db, db:
            row = db.execute('SELECT payload FROM native_course_sources').fetchone()
            payload = json.loads(row[0])
            payload['public']['item']['learningSupport']['task']['sources'][0]['excerpt'] = 'Tampered'
            db.execute('UPDATE native_course_sources SET payload=?', (json.dumps(payload),))
        with self.assertRaisesRegex(ValueError, 'capture-integrity'):
            self.service.read(identity, captured['captureId'])
        with self.assertRaisesRegex(ValueError, 'capture-integrity'):
            self.service.capture(identity)

    def test_private_route_tampering_cannot_be_resigned_with_payload_hash(self):
        identity = self.identity()
        captured = self.service.capture(identity)
        with closing(sqlite3.connect(self.db)) as db, db:
            payload = json.loads(db.execute('SELECT payload FROM native_course_sources').fetchone()[0])
            payload['private']['binding']['stateRef'] = 'courses/another-state.md'
            db.execute('UPDATE native_course_sources SET payload=?, payload_hash=?',
                       (json.dumps(payload), study_hash(payload)))
        with self.assertRaisesRegex(ValueError, 'capture-integrity'):
            self.service.read_binding(identity, captured['captureId'])

    def test_unready_and_wrong_library_sources_have_no_receipt(self):
        self.support['task']['reviewStatus'] = 'candidate'
        self.source()
        with self.assertRaisesRegex(ValueError, 'course-task-unreviewed'):
            self.service.capture(self.identity())
        self.assertFalse(self.db.exists())


if __name__ == '__main__':
    unittest.main()
