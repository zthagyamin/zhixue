import unittest
import test_index_gateway as fixtures
import test_planning_catalog as planning


class AssistanceIndexExclusionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.IndexGatewayTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.subject('reading', 'quiz'); self.fixture.quiz(self.root)

    def test_auto_discovery_never_reimports_subject_owned_assistance_material(self):
        self.fixture.quiz(self.root, filename='records/assistance/2026/09/summary.md', doc_id='generated-summary')
        catalog = fixtures.gateway.load_gateway(self.fixture.vault)
        self.assertEqual(len(catalog['subjects'][0]['items']), 1)
        target = fixtures.gateway._path(self.fixture.vault, self.root+'/records/assistance/new.json', must_exist=False)
        self.assertTrue(target.is_relative_to(self.fixture.vault/self.root/'records'))

    def test_explicit_cross_subject_reference_cannot_bypass_generated_directory_exclusion(self):
        other = self.fixture.subject('other', 'quiz'); self.fixture.quiz(other, filename='records/assistance/summary.md', doc_id='auxiliary')
        index = self.fixture.vault/self.fixture.entry/'subjects/reading.md'
        index.write_text(index.read_text(encoding='utf-8')+'\n| content_ref | format |\n|---|---|\n| [[subjects/other/records/assistance/summary]] | quiz |\n', encoding='utf-8')
        catalog = fixtures.gateway.load_gateway(self.fixture.vault)
        subject = next(s for s in catalog['subjects'] if s['id']=='reading')
        self.assertEqual(len(subject['items']), 1)

    def test_an_ordinary_subject_named_assistance_still_works(self):
        root = self.fixture.subject('assistance', 'quiz'); self.fixture.quiz(root)
        catalog = fixtures.gateway.load_gateway(self.fixture.vault)
        self.assertEqual(len(next(s for s in catalog['subjects'] if s['id']=='assistance')['items']), 1)

    def test_planning_links_cannot_turn_auxiliary_summaries_into_learning_tasks(self):
        fixture = planning.PlanningCatalogTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.write('subjects/astronomy/records/assistance/summary.md', '---\ntype: course-note\nstatus: ready\n---\nNot learning material.\n')
        fixture.goal_path.write_text(fixture.goal_path.read_text(encoding='utf-8').replace('[[subjects/astronomy/lesson|Lesson]]','[[subjects/astronomy/records/assistance/summary]]'), encoding='utf-8')
        result = fixture.load(); self.assertTrue(result['diagnostics']); self.assertFalse(any(unit['unitId']=='astronomy:orbit' for subject in result['subjects'] for unit in subject['units']))
