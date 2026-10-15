"""Retained generated items must not acquire formal source authority."""
import copy
import sqlite3
import unittest
from contextlib import closing
from unittest import mock

import test_companion as fixtures
from infrastructure.study_adapter import create_study_application


class RetainedGeneratedSourceAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.h = fixtures.CompanionSyncTests('test_state_projection_failure_rolls_back_event_and_vault_log')
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.server = fixtures.server
        self.state_ref = '01 学习/专项课程/Test/学习记录/第01讲 学习状态.md'

    def generated_cache(self, item):
        return {'status': 'connected', 'contentMode': 'personal',
                'source': {'path': '已授权的本地来源', 'title': 'Synthetic unrelated lesson', 'scope': 'test'},
                'subjects': [{'id': 'legacy-generated-course', 'name': 'Synthetic',
                              'pluginType': 'quiz', 'domain': 'courses', 'items': [item]}]}

    def activity(self, item, kind='due'):
        key = 'practice:' + item['itemId']
        payload = self.h.make_v3_activity('retained-source-admission', state_ref=item.get('stateRef'),
                                         ability_id=item.get('abilityId'), item_key=key)
        payload['event']['domain'] = 'differential-review' if kind != 'word' else 'ielts'
        payload['event']['item']['kind'] = kind
        payload['event']['coreHash'] = self.server.compute_study_event_core_hash(payload['event'])
        return payload

    def reject_retained(self, *, result_card=False, kind='due'):
        item = {'id': 'old-provider-id', 'itemId': 'unrelated-card',
                'abilityId': 'unrelated-ability', 'prompt': 'Which synthetic statement is correct?',
                'options': ['A', 'B'], 'answer': 'A'}
        if not result_card:
            item['stateRef'] = self.state_ref
        else:
            self.h.write('01 学习/学习结果/unrelated-card.md',
                '---\ntype: learning-result\ndomain: course\nitem_id: unrelated-card\n'
                'ability_id: unrelated-ability\nreview_date: 2026-08-18\n'
                f'state_ref: "[[{self.state_ref}]]"\n---\n# Unrelated\n复习要点：\n- Another concept\n')
        retained = copy.deepcopy(item)
        with mock.patch.object(self.server, 'STATE', self.generated_cache(item)):
            app = create_study_application(self.server.route_services())
            read = app.read('synthetic-owner')
            self.assertTrue(read['subjects'])
            files = {str(path.relative_to(self.h.vault)): path.read_bytes()
                     for path in self.h.vault.rglob('*') if path.is_file()}
            with closing(sqlite3.connect(':memory:')) as database:
                self.server.ensure_study_v3_schema(database)
                with self.assertRaisesRegex(ValueError, 'source-unverified'):
                    self.server.accept_study_event_v3(database, self.h.vault,
                                                     'synthetic-owner', self.activity(retained, kind))
                for table in ['study_events_v3', 'state_handles', 'study_event_bindings',
                              'study_event_projections', 'study_event_stats']:
                    self.assertEqual(database.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0, table)
            self.assertEqual({str(path.relative_to(self.h.vault)): path.read_bytes()
                              for path in self.h.vault.rglob('*') if path.is_file()}, files)

    def test_retained_generated_item_cannot_project_into_an_unrelated_state(self):
        self.reject_retained()

    def test_retained_generated_id_cannot_acquire_due_result_card_authority(self):
        self.reject_retained(result_card=True)

    def test_relabeling_generated_quiz_as_word_does_not_bypass_source_admission(self):
        self.reject_retained(kind='word')


if __name__ == '__main__':
    unittest.main()
