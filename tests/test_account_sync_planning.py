import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_export as content_export
if importlib.util.find_spec('account_sync_planning'):
    import account_sync_planning as planning
else:
    planning = None
import test_index_gateway as fixtures


class AccountSyncPlanningTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(planning, 'Companion portable planning export must exist')
        self.fixture = fixtures.IndexGatewayTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.vault = self.fixture.vault; self.root = self.fixture.subject('course', 'quiz')
        index = self.vault / self.fixture.entry / 'subjects/course.md'
        index.write_text(index.read_text(encoding='utf-8').replace('enabled: true', f'planning_ref: "[[{self.root}/plan]]"\nenabled: true'), encoding='utf-8')
        self.fixture.quiz(self.root)
        self.fixture.write(self.root + '/plan.md', f'''---
planning_schema_version: 1
---
| unit_id | title | content_ref | state_ref | ability_id | order | prerequisites | action | completion_rule |
|---|---|---|---|---|---|---|---|---|
| u1 | Read one | [[{self.root}/lesson]] | | | 1 | | open-note | self-report |

| goal_id | title | target_kind | target_count | unit_ids | start_on | due_on | priority | required | completion_basis |
|---|---|---|---|---|---|---|---|---|---|
| daily | Daily unit | daily | 1 | u1 | 2026-09-01 | | 3 | true | self-report |
''')

    def export(self):
        gateway, identities = content_export.capture_catalog(self.vault)
        bundle, bindings = content_export.export_catalog(gateway, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        catalog, materials, facts, routes = planning.export_planning(self.vault, gateway, bundle)
        return bundle, bindings, catalog, materials, facts, routes

    def test_paths_stay_local_and_goals_units_remain_complete(self):
        _, _, catalog, materials, facts, _ = self.export(); wire = json.dumps(catalog, ensure_ascii=False)
        self.assertNotIn(self.root, wire); self.assertNotIn('"contentRef":', wire); self.assertNotIn('"stateRef":', wire)
        subject = catalog['subjects'][0]; self.assertEqual(subject['goals'][0]['targetCount'], 1)
        self.assertEqual(subject['units'][0]['action']['kind'], 'open-material')
        self.assertTrue(materials[subject['units'][0]['action']['materialId']]['contentRef'].startswith('[['))
        self.assertEqual(planning.validate_planning_catalog(catalog), catalog)
        self.assertEqual(planning.validate_planning_facts(facts), facts)

    def test_typescript_accepts_exact_python_signed_catalog(self):
        _, _, catalog, _, facts, _ = self.export()
        script = "import {readFileSync} from 'node:fs'; import {parseCloudPlanningCatalog,parseCloudPlanningFacts} from './app/account-study-planning.ts'; const value=JSON.parse(readFileSync(process.argv[1],'utf8')); await parseCloudPlanningCatalog(value.catalog); await parseCloudPlanningFacts(value.facts);"
        temporary = self.vault.parent / 'planning-catalog.json'; temporary.write_text(json.dumps({'catalog': catalog, 'facts': facts}, ensure_ascii=False), encoding='utf-8')
        result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', script, str(temporary)], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_planning_change_changes_catalog_without_changing_questions(self):
        bundle, _, first, _, _, _ = self.export(); path = self.vault / self.root / 'plan.md'
        path.write_text(path.read_text(encoding='utf-8').replace('Daily unit', 'Updated goal'), encoding='utf-8')
        gateway, _ = content_export.capture_catalog(self.vault); second, _, _, _ = planning.export_planning(self.vault, gateway, bundle)
        self.assertNotEqual(first['sourceHash'], second['sourceHash']); self.assertEqual(first['contentRefs'], second['contentRefs'])

    def test_incomplete_diagnostics_never_publish_partial_goal_catalog(self):
        path = self.vault / self.root / 'plan.md'; path.write_text(path.read_text(encoding='utf-8').replace('u1 | 2026', 'missing | 2026'), encoding='utf-8')
        gateway, identities = content_export.capture_catalog(self.vault)
        bundle, _ = content_export.export_catalog(gateway, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        with self.assertRaisesRegex(ValueError, 'planning'): planning.export_planning(self.vault, gateway, bundle)


if __name__ == '__main__': unittest.main()
