import importlib.util
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import task_plan_schema
if importlib.util.find_spec('account_sync_plan_writer'):
    import account_sync_plan_writer as writer
else:
    writer = None

V = json.loads((Path(__file__).parent / 'fixtures/account-planning-v1.json').read_text(encoding='utf-8'))


class AccountSyncPlanWriterTests(unittest.TestCase):
    def test_plan_revalidation_ignores_unrelated_catalog_growth_but_checks_used_content_and_routes(self):
        old = copy.deepcopy(V['catalog']); current = copy.deepcopy(old)
        routes = {s['subjectId']: {'id': s['subjectId'], 'contentRoot': f"subjects/{s['subjectId']}", 'recordsRoot': f"subjects/{s['subjectId']}/records", 'progressRef': f"subjects/{s['subjectId']}/state.md"} for s in old['subjects']}
        plan = copy.deepcopy(V['cloudPlan'])
        word_subject = old['subjects'][0]
        used = 'word:test'
        old['contentRefs'][used] = 'e' * 64
        current['contentRefs'][used] = 'e' * 64
        plan['tasks'].append({'subjectId': word_subject['subjectId'], 'unitIds': [], 'action': {'kind': 'practice', 'itemKeys': [used]}})
        current['sourceHash'] = 'a' * 64
        current['contentRefs']['unrelated-new-item'] = 'b' * 64
        writer.validate_plan_source_bindings(plan, old, V['materials'], routes, current, V['materials'], routes)
        current['contentRefs'][used] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            writer.validate_plan_source_bindings(plan, old, V['materials'], routes, current, V['materials'], routes)
        current = copy.deepcopy(old); changed_routes = copy.deepcopy(routes)
        subject = V['cloudPlan']['tasks'][0]['subjectId']; changed_routes[subject]['recordsRoot'] += '-moved'
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            writer.validate_plan_source_bindings(plan, old, V['materials'], routes, current, V['materials'], changed_routes)

    def test_full_downloaded_operation_metadata_is_validated_and_applied(self):
        with tempfile.TemporaryDirectory() as temporary:
            operation = {'sequence': 1, 'operationId': 'full-wire-approval', 'action': 'approve', 'plan': V['cloudPlan'], 'predecessorOperationId': None,
                         'day': V['cloudPlan']['day'], 'stateRevision': 2, 'receivedAt': '2026-09-01 00:00:00'}
            result = writer.apply_operation(Path(temporary), 'a' * 64, operation, V['nativeCatalog'], V['materials'], None)
            self.assertEqual(result['status'], 'applied')
            self.assertEqual(writer.apply_operation(Path(temporary), 'a' * 64, {**operation, 'receivedAt': '2026-09-01T00:00:00.000Z'}, V['nativeCatalog'], V['materials'], None), result)
            with self.assertRaises(ValueError):
                writer.apply_operation(Path(temporary), 'a' * 64, {**operation, 'receivedAt': '2026-02-30 00:00:00'}, V['nativeCatalog'], V['materials'], None)
            with self.assertRaises(ValueError):
                writer.apply_operation(Path(temporary), 'a' * 64, {**operation, 'day': '2026-09-02'}, V['nativeCatalog'], V['materials'], None)

    def setUp(self):
        self.assertIsNotNone(writer, 'Approved cloud plan writer must exist')

    def test_typescript_cloud_plan_validates_and_materializes_native_sources(self):
        plan = writer.validate_cloud_plan(V['cloudPlan'])
        native = writer.materialize_cloud_plan(plan, V['nativeCatalog'], V['materials'])
        self.assertEqual(task_plan_schema.validate_task_plan_integrity(native), native)
        self.assertNotEqual(native['planHash'], plan['cloudPlanHash'])
        self.assertEqual(native['tasks'][0]['action']['kind'], 'open-note')
        self.assertIn('subjects/course/u0', native['tasks'][0]['action']['contentRef'])

    def test_wrong_material_or_changed_cloud_hash_is_rejected(self):
        changed = json.loads(json.dumps(V['cloudPlan'])); changed['tasks'][0]['title'] = 'Changed'
        with self.assertRaises(ValueError): writer.validate_cloud_plan(changed)
        materials = json.loads(json.dumps(V['materials'])); materials[next(iter(materials))]['unitId'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'material'): writer.materialize_cloud_plan(V['cloudPlan'], V['nativeCatalog'], materials)

    def test_apply_is_idempotent_after_lost_response_and_checks_predecessor_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            vault = Path(temporary); operation = {'sequence': 1, 'operationId': 'approve-one', 'action': 'approve', 'plan': V['cloudPlan'], 'predecessorOperationId': None}
            first = writer.apply_operation(vault, 'a' * 64, operation, V['nativeCatalog'], V['materials'], None)
            self.assertEqual(first['status'], 'applied'); self.assertEqual(first['proof']['localRevision'], 1)
            second = writer.apply_operation(vault, 'a' * 64, operation, V['nativeCatalog'], V['materials'], None)
            self.assertEqual(second, first)
            next_operation = {**operation, 'sequence': 2, 'operationId': 'approve-two', 'predecessorOperationId': 'approve-one'}
            blocked = writer.apply_operation(vault, 'a' * 64, next_operation, V['nativeCatalog'], V['materials'], None)
            self.assertEqual((blocked['status'], blocked['reason']), ('blocked', 'predecessor-pending'))
            applied = writer.apply_operation(vault, 'a' * 64, next_operation, V['nativeCatalog'], V['materials'], first)
            self.assertEqual(applied['proof']['localRevision'], 2)

    def test_local_edit_conflict_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            vault = Path(temporary); operation = {'sequence': 1, 'operationId': 'approve-one', 'action': 'approve', 'plan': V['cloudPlan'], 'predecessorOperationId': None}
            import plan_area
            plan_area.apply_plan_revision(plan_area.plan_area_root(vault), {'day':'2026-09-01','planHash':'f'*64,'items':[],'totalMinutes':0,'overloaded':False,'skipped':[]}, 'local', 'local')
            result = writer.apply_operation(vault, 'a' * 64, operation, V['nativeCatalog'], V['materials'], None)
            self.assertEqual((result['status'], result['reason']), ('blocked', 'local-plan-conflict'))
            self.assertEqual(plan_area.current_revision(plan_area.plan_area_root(vault)), 1)


if __name__ == '__main__': unittest.main()
