"""V2 rendering and one authority/log revision boundary for all writers."""
import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import plan_area
import plan_authority
import capture_store
from test_plan_area import make_candidate
from test_capture_flow import make_capture

SAMPLE = json.loads((Path(__file__).parent / 'fixtures/task-plan-v2.json').read_text(encoding='utf-8'))


def sealed(plan):
    plan = copy.deepcopy(plan)
    plan.pop('planHash', None)
    plan['planHash'] = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return plan


class FailingCaptureDb:
    def __init__(self, connection, fragment):
        self.connection, self.fragment, self.sql = connection, fragment, ''
        self.armed = True

    def __getattr__(self, key):
        return getattr(self.connection, key)

    def execute(self, sql, *args):
        self.sql = sql
        return self.connection.execute(sql, *args)

    def commit(self):
        if self.armed and self.sql.startswith('UPDATE codex_captures') and self.fragment in self.sql:
            self.armed = False
            raise sqlite3.OperationalError('fixture metadata failure')
        self.connection.commit()


class TaskPlanAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.area = plan_area.plan_area_root(self.vault)
        self.path = self.vault / plan_authority.PLAN_RELATIVE_PATH
        self.v2 = sealed(SAMPLE)

    def test_v2_roundtrip_renders_real_tasks_and_preserves_outside_crlf(self):
        self.path.parent.mkdir(parents=True)
        prefix = b'# User plan\r\nManual introduction\r\n'
        suffix = b'\r\nHuman tail\r\n'
        self.path.write_bytes(prefix + plan_authority.PLAN_BEGIN.encode() + b'\r\nold\r\n' + plan_authority.PLAN_END.encode() + suffix)
        plan_authority.apply_current_plan(self.vault, self.v2, revision=3)
        self.assertEqual(plan_authority.read_current_plan(self.vault)['candidate'], self.v2)
        self.assertTrue(self.path.read_bytes().startswith(prefix));self.assertTrue(self.path.read_bytes().endswith(suffix))
        rendered = self.path.read_text(encoding='utf-8')
        self.assertIn('每日必做', rendered);self.assertIn('学科任务', rendered)
        self.assertIn('复习一道题', rendered);self.assertIn('阅读一个小节', rendered)
        self.assertNotIn('今日暂无学习项', rendered)

    def test_v2_titles_do_not_inject_table_columns_or_source_links(self):
        self.v2['tasks'][1]['title'] = 'Read | [[not-a-source]] <tag>'
        plan_authority.apply_current_plan(self.vault, sealed(self.v2), 1)
        rendered = self.path.read_text(encoding='utf-8')
        self.assertIn('Read \\|', rendered)
        self.assertNotIn('[[not-a-source]]', rendered)
        self.assertNotIn('<tag>', rendered)

    def test_invalid_v2_hash_or_shape_cannot_replace_an_authoritative_plan(self):
        plan_authority.apply_current_plan(self.vault, self.v2, 1)
        before = self.path.read_bytes()
        changed = copy.deepcopy(self.v2);changed['tasks'][1]['title'] = 'Changed without rehash'
        for plan in (changed, {**self.v2, 'invented': True}):
            with self.assertRaises(ValueError):
                plan_authority.apply_current_plan(self.vault, plan, 2)
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_revision_values_cannot_be_written_to_the_authority(self):
        for revision in (True, 0, -1, 1.5):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                plan_authority.apply_current_plan(self.vault, self.v2, revision)
        self.assertFalse(self.path.exists())

    def test_browser_generated_word_snapshot_has_the_same_signed_hash_in_companion(self):
        from task_plan_schema import validate_task_plan_integrity
        browser = json.loads((Path(__file__).parent / 'fixtures/task-plan-v2-signed.json').read_text(encoding='utf-8'))
        self.assertEqual(validate_task_plan_integrity(browser), browser)
        plan_authority.apply_current_plan(self.vault, browser, 1)
        self.assertEqual(plan_authority.read_current_plan(self.vault)['candidate'], browser)

    def test_authority_ahead_of_log_is_a_conflict_not_the_old_logged_revision(self):
        plan_area.apply_plan_revision(self.area, self.v2, 'fixture', 'test', 0)
        newer = sealed({**self.v2, 'draftVersion': 2})
        plan_authority.apply_current_plan(self.vault, newer, 2)
        with self.assertRaisesRegex(ValueError, 'stale-plan-revision|drift'):
            plan_area.current_revision(self.area)
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            plan_area.apply_plan_revision(self.area, self.v2, 'fixture', 'test', 1)
        self.assertEqual(self.path.read_bytes(), before)

    def test_capture_addition_is_logged_and_makes_an_old_website_apply_stale(self):
        plan_area.apply_plan_revision(self.area, make_candidate(), 'fixture', 'test', 0)
        item = {'itemId': 'review-item', 'abilityId': 'review-ability', 'stateRef': 'state.md', 'reason': 'fixture'}
        result = plan_authority.add_review_item(self.vault, item, expected_revision=1)
        self.assertEqual(result['revision'], 2)
        self.assertEqual(plan_area.current_revision(self.area), 2)
        self.assertEqual(len(plan_area.read_revisions(self.area)), 2)
        with self.assertRaisesRegex(ValueError, 'stale-plan-revision'):
            plan_area.apply_plan_revision(self.area, make_candidate(), 'fixture', 'test', 1)
        self.assertEqual(len(plan_authority.parse_review_items(self.vault)), 1)

    def test_compatibility_write_today_helper_also_records_its_revision(self):
        plan_area.write_today_plan(self.area, make_candidate())
        self.assertEqual(len(plan_area.read_revisions(self.area)), 1)

    def test_capture_metadata_failure_retries_the_same_plan_revision(self):
        for fragment in ('processed_at', 'route_status'):
            with self.subTest(fragment=fragment):
                # Independent vault state for each distinct failure point.
                vault = self.vault / fragment
                area = plan_area.plan_area_root(vault)
                plan_area.apply_plan_revision(area, make_candidate(), 'fixture', 'test', 0)
                db = sqlite3.connect(':memory:')
                try:
                    proxy = FailingCaptureDb(db, fragment)
                    capture = {**make_capture('capture-retry-' + fragment), 'planRevision': 1}
                    with self.assertRaises(sqlite3.OperationalError):
                        capture_store.route_capture(vault, proxy, capture)
                    result = capture_store.route_capture(vault, proxy, capture)
                    self.assertEqual(result['revision'], 2)
                    self.assertEqual(plan_area.current_revision(area), 2)
                    self.assertEqual(len(plan_area.read_revisions(area)), 2)
                    self.assertEqual(capture_store.pending_captures(db), [])
                finally:
                    db.close()

    def test_failure_after_log_replacement_restores_both_authority_and_log(self):
        plan_area.apply_plan_revision(self.area, self.v2, 'fixture', 'test', 0)
        log = self.area / plan_area.REVISIONS_FILE
        before_plan, before_log = self.path.read_bytes(), log.read_bytes()
        append = plan_area._append_revision
        def failing(area, record):
            append(area, record)
            raise OSError('fixture post-replace failure')
        with mock.patch.object(plan_area, '_append_revision', side_effect=failing), self.assertRaises(OSError):
            plan_area.apply_plan_revision(self.area, sealed({**self.v2, 'draftVersion': 2}), 'fixture', 'test', 1)
        self.assertEqual(self.path.read_bytes(), before_plan);self.assertEqual(log.read_bytes(), before_log)

    def test_corrupt_log_is_not_silently_ignored(self):
        plan_area.apply_plan_revision(self.area, self.v2, 'fixture', 'test', 0)
        log = self.area / plan_area.REVISIONS_FILE
        log.write_bytes(log.read_bytes() + b'{broken\n')
        with self.assertRaises(ValueError):
            plan_area.current_payload(self.area)

    def test_v2_capture_adds_a_bound_required_review_without_losing_manual_intent(self):
        import test_planning_catalog as fixtures
        import index_gateway
        builder = fixtures.PlanningCatalogTests();builder.setUp();self.addCleanup(builder.doCleanups)
        builder.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: recall\nstatus: ready\n---\n| ID | 题干 | 答案 |\n|---|---|---|\n| q1 | Real question | Real answer |\n', encoding='utf-8')
        catalog = index_gateway.load_gateway(builder.vault)
        key, binding = next(iter(catalog['bindings'].items()))
        area = plan_area.plan_area_root(builder.vault)
        plan_area.apply_plan_revision(area, self.v2, 'fixture', 'test', 0)
        item = {field: binding[field] for field in ('itemId', 'abilityId', 'stateRef', 'sourceNote')}
        item.update(title='Capture review', pluginType='recall', due='2026-08-31', reason='Explicit gap')
        plan_authority.add_review_item(builder.vault, item, expected_revision=1, capture_id='capture-bound-one')
        current = plan_area.current_plan(area)
        self.assertEqual(current['tasks'][:len(self.v2['tasks'])], self.v2['tasks'])
        self.assertEqual(current['manual'], self.v2['manual'])
        added = current['tasks'][-1]
        self.assertEqual(added['category'], 'review');self.assertTrue(added['required'])
        self.assertEqual(added['subjectId'], 'astronomy');self.assertEqual(added['action']['itemKeys'], [key])
        self.assertIn(item['itemId'], [review['itemId'] for review in plan_authority.parse_review_items(builder.vault)])
        plan_authority.add_review_item(builder.vault, item, expected_revision=2, capture_id='capture-bound-two')
        self.assertEqual(len(plan_area.current_plan(area)['tasks']), len(self.v2['tasks']) + 1)

    def test_v2_restore_keeps_original_day_manual_data_and_independent_events(self):
        plan_area.apply_plan_revision(self.area, self.v2, 'fixture', 'test', 0)
        events = self.vault / 'subjects/reading/records/tasks.jsonl';events.parent.mkdir(parents=True)
        events.write_bytes(b'independent evidence\n')
        second = sealed({**self.v2, 'day': '2026-09-01', 'draftVersion': 2})
        plan_area.apply_plan_revision(self.area, second, 'fixture', 'test', 1)
        plan_area.restore_revision(self.area, 1, 'fixture', 2)
        self.assertEqual(plan_area.current_plan(self.area), self.v2)
        self.assertEqual(events.read_bytes(), b'independent evidence\n')

    def test_strengthening_a_locked_capture_retains_manual_fields_and_source_confirmation(self):
        import test_planning_catalog as fixtures
        import index_gateway
        builder = fixtures.PlanningCatalogTests();builder.setUp();self.addCleanup(builder.doCleanups)
        builder.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: recall\nstatus: ready\n---\n| ID | 题干 | 答案 |\n|---|---|---|\n| q1 | Old question | Answer |\n', encoding='utf-8')
        binding = next(iter(index_gateway.load_gateway(builder.vault)['bindings'].values()))
        area = plan_area.plan_area_root(builder.vault)
        plan_area.apply_plan_revision(area, self.v2, 'fixture', 'test', 0)
        item = {field: binding[field] for field in ('itemId', 'abilityId', 'stateRef', 'sourceNote')}
        item.update(title='Capture title')
        plan_authority.add_review_item(builder.vault, item, 1, capture_id='capture-lock-one')
        manual = plan_area.current_plan(area);old = manual['tasks'][-1]
        old.update(title='My review title', estimatedMinutes=12)
        manual['manual']['lockedTaskIds'].append(old['taskId'])
        manual['manual']['order'] = [old['taskId'], *[task['taskId'] for task in manual['tasks'][:-1]]]
        plan_area.apply_plan_revision(area, sealed(manual), 'fixture', 'test', 2)
        builder.note.write_text(builder.note.read_text(encoding='utf-8').replace('Old question', 'Updated question'), encoding='utf-8')
        plan_authority.add_review_item(builder.vault, {**item, 'title': 'New capture title'}, 3, capture_id='capture-lock-two')
        current = plan_area.current_plan(area);updated = current['tasks'][-1]
        self.assertEqual(updated['title'], 'My review title')
        self.assertEqual(updated['estimatedMinutes'], 12)
        self.assertEqual(updated['sourceHash'], old['sourceHash'])
        self.assertTrue(updated['blockedReason'])
        self.assertIn(updated['taskId'], current['manual']['lockedTaskIds'])
        self.assertEqual(current['manual']['order'][0], updated['taskId'])

    def test_capture_and_website_share_the_same_compare_and_swap_boundary(self):
        plan_area.apply_plan_revision(self.area, make_candidate(), 'fixture', 'test', 0)
        barrier = threading.Barrier(2)
        def write(kind):
            barrier.wait()
            try:
                if kind == 'capture':
                    plan_authority.add_review_item(self.vault, {'itemId': 'capture-item', 'abilityId': 'ability'}, 1)
                else:
                    plan_area.apply_plan_revision(self.area, make_candidate(plan_hash='b' * 64), 'fixture', 'test', 1)
                return 'applied'
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(write, ['capture', 'website']))
        self.assertEqual(sorted(results), ['applied', 'stale-plan-revision'])
        self.assertEqual(plan_area.current_revision(self.area), 2)
        self.assertEqual(len(plan_area.read_revisions(self.area)), 2)
