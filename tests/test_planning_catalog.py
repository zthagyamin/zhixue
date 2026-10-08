import importlib.util
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
import index_gateway

CATALOG = importlib.util.find_spec('planning_catalog')
if CATALOG:
    from planning_catalog import load_planning_catalog

GOALS = '| goal_id | title | target_kind | target_count | unit_ids | start_on | due_on | priority | required | completion_basis |\n|---|---|---|---|---|---|---|---|---|---|\n'
UNITS = '| unit_id | title | content_ref | state_ref | ability_id | order | prerequisites | action | completion_rule |\n|---|---|---|---|---|---|---|---|---|\n'


class PlanningCatalogTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(CATALOG, 'Planning catalog adapter must exist')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.entry = '_System/Integrations/Study Loop/gateway'
        self.write(f'{self.entry}/index.md', '---\ntype: zhixue-gateway\nschema_version: 1\n---\n')
        self.write('subjects/astronomy/progress.md', '---\ntype: zhixue-practice-state\n---\n')
        self.index = self.write(f'{self.entry}/subjects/astronomy.md', '''---
type: zhixue-subject-index
schema_version: 1
subject_id: astronomy
name: Astronomy
domain: course
plugin: recall
content_root: subjects/astronomy
progress_ref: "[[subjects/astronomy/progress]]"
records_root: subjects/astronomy/records
planning_ref: "[[subjects/astronomy/goals#Planning|My plan]]"
enabled: true
auto: true
---
''')
        self.note = self.write('subjects/astronomy/lesson.md', '---\ntype: course-note\nstatus: ready\n---\n# Lesson\nA real chapter.\n')
        self.state = self.write('subjects/astronomy/state.md', '---\ntype: learning-state\nmastery: developing\nability_id: orbit\n---\n')
        self.goal_path = self.write_goals()

    def write(self, relative, text):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def write_goals(self, kind='daily', count='1', rule='self-report', basis='self-report', prerequisite=''):
        return self.write('subjects/astronomy/goals.md',
                          '---\nplanning_schema_version: 1\n---\n# Planning\n' +
                          GOALS + f'| study | Learn orbit | {kind} | {count} | orbit | 2026-08-31 | 2026-09-06 | 3 | true | {basis} |\n\n' +
                          UNITS + f'| orbit | Orbit chapter | [[subjects/astronomy/lesson|Lesson]] | [[subjects/astronomy/state]] | orbit | 1 | {prerequisite} | open-note | {rule} |\n')

    def load(self):
        gateway = index_gateway.load_gateway(self.vault)
        self.assertNotIn('definitions', gateway)
        return load_planning_catalog(self.vault, gateway)

    def test_reads_two_separate_tables_and_alias_references_without_writes(self):
        before = {p.relative_to(self.vault): p.read_bytes() for p in self.vault.rglob('*.md')}
        result = self.load()
        subject = result['subjects'][0]
        self.assertEqual(subject['goals'][0]['goalId'], 'astronomy:study')
        self.assertEqual(subject['goals'][0]['unitIds'], ['astronomy:orbit'])
        self.assertEqual(subject['units'][0]['action']['contentRef'], '[[subjects/astronomy/lesson|Lesson]]')
        self.assertFalse(subject['units'][0]['formalComplete'])
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(before, {p.relative_to(self.vault): p.read_bytes() for p in self.vault.rglob('*.md')})

    def test_supports_all_declared_goal_kinds(self):
        for kind in ('daily', 'weekly', 'deadline'):
            with self.subTest(kind=kind):
                self.write_goals(kind=kind)
                self.assertEqual(self.load()['subjects'][0]['goals'][0]['kind'], kind)

    def test_note_existence_does_not_prove_formal_completion(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.assertFalse(self.load()['subjects'][0]['units'][0]['formalComplete'])
        self.state.write_text('---\ntype: learning-state\nmastery: mastered\nability_id: orbit\n---\n', encoding='utf-8')
        self.assertTrue(self.load()['subjects'][0]['units'][0]['formalComplete'])
        self.state.write_text('---\ntype: zhixue-practice-state\nmastery: mastered\nability_id: orbit\n---\n', encoding='utf-8')
        result = self.load()
        self.assertTrue(result['diagnostics'])
        self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_missing_planning_ref_does_not_disable_the_subject(self):
        self.index.write_text('\n'.join(line for line in self.index.read_text(encoding='utf-8').splitlines() if not line.startswith('planning_ref:')) + '\n', encoding='utf-8')
        subject = self.load()['subjects'][0]
        self.assertEqual(subject['planningStatus'], 'none')
        self.assertEqual(subject['goals'], [])

    def test_ai_payload_uses_explicit_topic_only_never_a_title_derived_from_prompt(self):
        from plan_suggestions import suggest_tasks
        self.index.write_text('\n'.join(line for line in self.index.read_text(encoding='utf-8').splitlines() if not line.startswith('planning_ref:')) + '\n', encoding='utf-8')
        self.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson-a\nzhixue_format: recall\nstatus: ready\n---\n| ID | 题干 | 答案 | 主题 |\n|---|---|---|---|\n| q1 | PRIVATE full question body. | private answer | |\n| q2 | ANOTHER private question. | another answer | Safe topic |\n', encoding='utf-8')
        catalog = self.load()
        self.assertEqual(len(catalog['subjects'][0]['units']), 2)
        captured = []
        def ai(messages):
            captured.extend(messages)
            return {'choices': [{'ref': '1', 'count': 1}]}
        request = {'day': '2026-08-31', 'sourceHash': catalog['sourceHash'], 'draftVersion': 1, 'excludedUnitIds': [], 'selectedUnitIds': [], 'intent': 'standard'}
        self.assertEqual(suggest_tasks(catalog, request, ai)['mode'], 'ai')
        import json
        outgoing = json.dumps(captured)
        self.assertNotIn('PRIVATE', outgoing)
        self.assertNotIn('ANOTHER', outgoing)
        self.assertNotIn('private answer', outgoing)
        self.assertIn('Safe topic', outgoing)

    def test_legacy_vocabulary_declares_only_its_known_progress_aliases(self):
        self.index.write_text(self.index.read_text(encoding='utf-8').replace('plugin: recall', 'plugin: three-stage\nidentity: legacy'), encoding='utf-8')
        self.note.write_text('---\ntype: vocabulary-database\n---\n| 单词 | 释义 | 原文语境 |\n|---|---|---|\n| Pooling Layer | 池化层 | A pooling layer. |\n', encoding='utf-8')
        item = self.load()['subjects'][0]['words'][0]
        self.assertEqual(item['itemKey'], 'word:pooling-layer')
        self.assertEqual(set(item['legacyKeys']), {'word:Pooling Layer', 'word:pooling layer'})
        self.assertEqual(item['language'], 'en')

    def test_invalid_goal_is_not_silently_treated_as_no_goal(self):
        self.write_goals(count='many')
        result = self.load()
        self.assertEqual(result['subjects'][0]['planningStatus'], 'invalid')
        self.assertTrue(result['diagnostics'])

    def test_cyclic_dependency_and_duplicate_unit_are_rejected(self):
        self.write_goals(prerequisite='orbit')
        self.assertTrue(self.load()['diagnostics'])
        self.write_goals()
        with self.goal_path.open('a', encoding='utf-8') as handle:
            handle.write('| orbit | Duplicate | [[subjects/astronomy/lesson]] | | | 2 | | open-note | self-report |\n')
        self.assertTrue(self.load()['diagnostics'])

    def test_code_fences_do_not_create_goals(self):
        self.goal_path.write_text('---\nplanning_schema_version: 1\n---\n# Planning\n```markdown\n' + GOALS +
                                  '| fake | Example | daily | 1 | missing | 2026-08-31 | | 1 | true | self-report |\n```\n', encoding='utf-8')
        result = self.load()
        self.assertEqual(result['subjects'][0]['goals'], [])
        self.assertEqual(result['diagnostics'], [])

    def test_escaped_table_pipe_remains_part_of_a_title(self):
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('Orbit chapter', 'Orbit \\| chapter'), encoding='utf-8')
        result = self.load()
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(result['subjects'][0]['units'][0]['title'], 'Orbit | chapter')

    def test_source_hash_tracks_full_file_bytes_and_state(self):
        first = self.load()['sourceHash']
        self.note.write_bytes(b'\xef\xbb\xbf' + self.note.read_bytes())
        self.assertNotEqual(self.load()['sourceHash'], first)
        second = self.load()['sourceHash']
        self.state.write_text('---\ntype: learning-state\nmastery: developing\nability_id: orbit\n---\nchanged\n', encoding='utf-8')
        self.assertNotEqual(self.load()['sourceHash'], second)

    def test_draft_source_and_unregistered_external_root_are_rejected(self):
        self.note.write_text('---\ntype: course-note\nstatus: draft\n---\n', encoding='utf-8')
        self.assertTrue(self.load()['diagnostics'])
        self.write('other/secret.md', '# Unregistered\n')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('subjects/astronomy/lesson|Lesson', 'other/secret'), encoding='utf-8')
        self.assertTrue(self.load()['diagnostics'])

    def test_invalid_foreign_subject_cannot_leave_dangling_goal_units(self):
        self.write(f'{self.entry}/subjects/botany.md', self.index.read_text(encoding='utf-8').replace('astronomy', 'botany'))
        for filename in ('progress.md', 'lesson.md', 'state.md', 'goals.md'):
            self.write('subjects/botany/' + filename, (self.vault / 'subjects/astronomy' / filename).read_text(encoding='utf-8').replace('astronomy', 'botany'))
        botany_goals = self.vault / 'subjects/botany/goals.md'
        botany_goals.write_text(botany_goals.read_text(encoding='utf-8').replace('| true | self-report |', '| true | formal-state |'), encoding='utf-8')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('| 1 | orbit | 2026', '| 1 | botany:orbit | 2026'), encoding='utf-8')
        result = self.load()
        units = {unit['unitId'] for subject in result['subjects'] for unit in subject['units']}
        self.assertTrue(all(set(goal['unitIds']) <= units for subject in result['subjects'] for goal in subject['goals']))

    def test_formal_ability_must_be_inside_the_referenced_section(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('[[subjects/astronomy/state]]', '[[subjects/astronomy/state#Requested]]'), encoding='utf-8')
        self.state.write_text('---\ntype: learning-state\nmastery: mastered\n---\n# Requested\nNot orbit.\n# Other\n| ability_id | mastery |\n|---|---|\n| orbit | mastered |\n', encoding='utf-8')
        result = self.load()
        self.assertTrue(result['diagnostics'])
        self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_formal_row_state_cannot_be_overridden_by_file_mastery(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.state.write_text('---\ntype: learning-state\nmastery: mastered\n---\n| ability_id | mastery |\n|---|---|\n| orbit | developing |\n', encoding='utf-8')
        result = self.load()
        self.assertTrue(result['diagnostics'])
        self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_formal_block_and_other_formal_rules_are_supported(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('[[subjects/astronomy/state]]', '[[subjects/astronomy/state#^orbit]]'), encoding='utf-8')
        self.state.write_text('---\ntype: learning-state\n---\n\nability_id:: orbit\nmastery:: mastered\n^orbit\n', encoding='utf-8')
        self.assertTrue(self.load()['subjects'][0]['units'][0]['formalComplete'])
        for rule, kind, status in [('formal-done', 'project', 'done'), ('formal-completed-reference', 'course', 'completed-reference')]:
            with self.subTest(rule=rule):
                self.write_goals(rule=rule, basis='formal-state')
                self.state.write_text(f'---\ntype: {kind}\nstatus: {status}\nability_id: orbit\n---\n', encoding='utf-8')
                self.assertTrue(self.load()['subjects'][0]['units'][0]['formalComplete'])

    def test_missing_identifier_header_is_an_invalid_goal_not_no_goal(self):
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('goal_id', 'goal_identifier'), encoding='utf-8')
        result = self.load()
        self.assertEqual(result['subjects'][0]['planningStatus'], 'invalid')
        self.assertTrue(result['diagnostics'])

    def test_open_note_cannot_promise_a_three_stage_practice_round(self):
        self.write_goals(rule='three-stage', basis='practice-round')
        self.assertEqual(self.load()['subjects'][0]['planningStatus'], 'invalid')

    def test_nested_fence_example_does_not_create_a_goal(self):
        self.goal_path.write_text('---\nplanning_schema_version: 1\n---\n# Planning\n````markdown\n```markdown\n' + GOALS +
                                  '| fake | Example | daily | 1 | missing | 2026-08-31 | | 1 | true | self-report |\n```\n````\n', encoding='utf-8')
        result = self.load()
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(result['subjects'][0]['goals'], [])

    def test_whole_registered_quiz_can_be_targeted_by_chapter(self):
        self.note.write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: quiz\nstatus: ready\n---\n# Chapter\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q1 | First? | A;B | A | First |\n# Another\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q2 | Second? | A;B | B | Second |\n', encoding='utf-8')
        self.write_goals(rule='graded-practice', basis='practice-round')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('subjects/astronomy/lesson|Lesson', 'subjects/astronomy/lesson#Chapter').replace('| open-note |', '| practice |'), encoding='utf-8')
        result = self.load()
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(result['subjects'][0]['units'][0]['action']['itemKeys'], ['practice:astronomy:lesson:q1'])
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('graded-practice', 'three-stage'), encoding='utf-8')
        self.assertEqual(self.load()['subjects'][0]['planningStatus'], 'invalid')

    def test_unregistered_content_is_rejected_before_reading_its_body(self):
        outside = self.write('other/private.md', 'Unregistered body\n')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('subjects/astronomy/lesson|Lesson', 'other/private'), encoding='utf-8')
        observed = []
        original = index_gateway._read
        def read(path):
            observed.append(path.resolve())
            return original(path)
        with mock.patch.object(index_gateway, '_read', side_effect=read):
            self.assertTrue(self.load()['diagnostics'])
        self.assertNotIn(outside.resolve(), observed)

    def test_inline_formal_state_in_a_code_example_is_not_evidence(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.state.write_text('---\ntype: learning-state\n---\n```markdown\nability_id:: orbit\nmastery:: mastered\n```\n', encoding='utf-8')
        result = self.load()
        self.assertTrue(result['diagnostics'])
        self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_hidden_or_indented_examples_are_not_formal_evidence(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        for body in ('<!--\nability_id:: orbit\nmastery:: mastered\n-->',
                     '%%\nability_id:: orbit\nmastery:: mastered\n%%',
                     '    ability_id:: orbit\n    mastery:: mastered'):
            with self.subTest(body=body):
                self.state.write_text('---\ntype: learning-state\n---\n\n' + body + '\n', encoding='utf-8')
                result = self.load()
                self.assertTrue(result['diagnostics'])
                self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_literal_comment_markers_in_examples_do_not_hide_real_state(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        for example in ('```text\n<!--\n```', '```text\n%%\n```', '<!--\n```\n-->', '`<!--`'):
            with self.subTest(example=example):
                self.state.write_text('---\ntype: learning-state\n---\n' + example + '\n\n# Actual\nability_id:: orbit\nmastery:: mastered\n', encoding='utf-8')
                result = self.load()
                self.assertEqual(result['diagnostics'], [])
                self.assertTrue(result['subjects'][0]['units'][0]['formalComplete'])

    def test_multiline_inline_code_is_not_formal_state(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.state.write_text('---\ntype: learning-state\n---\n\n`example\nability_id:: orbit\nmastery:: mastered\n`\n', encoding='utf-8')
        self.assertTrue(self.load()['diagnostics'])

    def test_block_inside_a_code_fence_is_not_a_formal_state_target(self):
        self.write_goals(rule='formal-mastered', basis='formal-state')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('[[subjects/astronomy/state]]', '[[subjects/astronomy/state#^orbit]]'), encoding='utf-8')
        self.state.write_text('---\ntype: learning-state\n---\n```markdown\nability_id:: orbit\nmastery:: mastered\n^orbit\n```\n', encoding='utf-8')
        result = self.load()
        self.assertTrue(result['diagnostics'])
        self.assertFalse(any(u.get('formalComplete') for u in result['subjects'][0]['units']))

    def test_independently_registered_chapter_keeps_its_own_document_id(self):
        self.note.write_text('---\ntype: course-note\nstatus: ready\n---\n# First\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q1 | First? | A;B | A | First |\n# Second\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q2 | Second? | A;B | B | Second |\n', encoding='utf-8')
        self.index.write_text(self.index.read_text(encoding='utf-8') + '\n# Sources\n| id | content_ref | format | state_ref |\n|---|---|---|---|\n| first | [[subjects/astronomy/lesson#First]] | quiz | [[subjects/astronomy/progress]] |\n| second | [[subjects/astronomy/lesson#Second]] | quiz | [[subjects/astronomy/progress]] |\n', encoding='utf-8')
        self.write_goals(rule='graded-practice', basis='practice-round')
        self.goal_path.write_text(self.goal_path.read_text(encoding='utf-8').replace('subjects/astronomy/lesson|Lesson', 'subjects/astronomy/lesson#Second').replace('| open-note |', '| practice |'), encoding='utf-8')
        result = self.load()
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual(result['subjects'][0]['units'][0]['action']['itemKeys'], ['practice:astronomy:second:q2'])


if __name__ == '__main__':
    unittest.main()
