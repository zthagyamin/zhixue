import copy
import importlib.util
import json
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import account_sync_schema as schema
import test_index_gateway as fixtures
if importlib.util.find_spec('account_sync_export'):
    import account_sync_export as exporter
else:
    exporter = None


class AccountSyncExportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(exporter, 'Full active catalog export must exist')
        self.fixture = fixtures.IndexGatewayTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.vault = self.fixture.vault

    def word(self, example='', language='en', plugin='three-stage'):
        root = self.fixture.subject('words', plugin)
        path = self.vault / self.fixture.entry / 'subjects/words.md'
        path.write_text(path.read_text(encoding='utf-8').replace('enabled: true', f'language: {language}\nenabled: true'), encoding='utf-8')
        self.fixture.write(root + '/words.md', f'---\ntype: vocabulary-database\n---\n| word | meaning | example |\n|---|---|---|\n| Tree | 树 | {example} |\n')
        return root

    def capture(self):
        catalog, identities = exporter.capture_catalog(self.vault)
        return exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')

    def test_flashcards_expand_before_local_bindings_and_portable_export(self):
        from flashcard_support import child_id
        import index_gateway
        root=self.fixture.subject('cards','flashcard')
        support={'schemaVersion':1,'type':'flashcard','mode':'bidirectional'}
        source=self.fixture.write(root+'/cards.md','---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: flashcard\nstatus: ready\n---\n| ID | 正面 | 背面 | 学习配置 |\n|---|---|---|---|\n| 原卡 | 正面问题 | 背面答案 | '+json.dumps(support)+' |\n')
        original=source.read_bytes();parent='cards:lesson:原卡';reverse=child_id(parent,'reverse')
        bundle,bindings=self.capture();keys=['practice:'+parent,'practice:'+reverse]
        self.assertEqual([i['itemKey'] for i in bundle['items']],keys)
        self.assertEqual(set(bindings),set(keys));self.assertNotEqual(bindings[keys[0]]['binding']['abilityId'],bindings[keys[1]]['binding']['abilityId'])
        self.assertEqual([i['practice']['answer'] for i in bundle['items']],['背面答案','正面问题'])
        self.assertEqual(schema.validate_bundle(bundle),bundle)
        second,_=self.capture();self.assertEqual(bundle,second)
        binding=bindings[keys[1]]['binding']
        event={'schemaVersion':3,'eventId':'reverse-only','coreHash':'fixture','eventType':'practice-attempt','occurredAt':'2026-09-10T01:00:00Z','item':{'key':keys[1]},'attempt':{'correct':True,'rating':'good','stageAfter':3}}
        index_gateway.record_subject_event(self.vault,binding,'fixture',event,{})
        self.assertEqual([e['event']['item']['key'] for e in index_gateway.read_subject_events(self.vault,binding,'fixture')],[keys[1]])
        self.assertEqual(source.read_bytes(),original)

    def test_source_spelling_mapping_survives_export_and_word_binding(self):
        root=self.word(plugin='spelling')
        support={'schemaVersion':1,'type':'spelling','word':'ship','segments':[{'letters':'sh','phoneme':'ʃ','isTricky':True},{'letters':'ip','phoneme':'ɪp'}]}
        self.fixture.write(root+'/words.md','---\ntype: vocabulary-database\n---\n| word | meaning | 学习配置 |\n|---|---|---|\n| ship | 船 | '+json.dumps(support)+' |\n')
        bundle,bindings=self.capture();item=bundle['items'][0]
        self.assertEqual(item['learningSupport'],support)
        self.assertEqual(item['recommendedPlugin'],'spelling')
        self.assertEqual(schema.compatible_modes(item),['spelling'])
        self.assertIn(item['itemKey'],bindings)
        self.assertEqual(schema.validate_bundle(bundle),bundle)
        bad=copy.deepcopy(item);bad.pop('contentHash');bad['word']['word']='shop'
        with self.assertRaisesRegex(ValueError,'spelling-mapping-mismatch'):schema.seal_item(bad)

    def test_versioned_quiz_source_exports_without_duplicate_answers(self):
        root=self.fixture.subject('choice','quiz')
        support={'schemaVersion':1,'type':'quiz','selection':'multiple','options':[{'optionId':'a','text':'同名'},{'optionId':'b','text':'同名'},{'optionId':'c','text':'第三项','trapType':'out_of_scope','trapExplanation':'原文未提及'}],'correctOptionIds':['a','b']}
        self.fixture.write(root+'/quiz.md','---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: quiz\nstatus: ready\n---\n| ID | 题干 | 学习配置 |\n|---|---|---|\n| one | 选择全部正确项 | '+json.dumps(support)+' |\n')
        bundle,bindings=self.capture();item=bundle['items'][0]
        self.assertEqual(item['learningSupport'],support)
        self.assertNotIn('answer',item['practice']);self.assertNotIn('options',item['practice'])
        self.assertEqual(schema.compatible_modes(item),['quiz']);self.assertIn(item['itemKey'],bindings)
        self.assertEqual(schema.validate_bundle(bundle),bundle)
        bad=copy.deepcopy(item);bad.pop('contentHash');bad['practice']['answer']=0
        with self.assertRaisesRegex(ValueError,'duplicate-quiz-answer-source'):schema.seal_item(bad)

    def test_complete_catalog_including_future_cards_not_due_subset(self):
        root = self.fixture.subject('reading', 'recall')
        self.fixture.write(root + '/future.md', f'''---
type: learning-result
item_id: future-one
ability_id: reading-main
domain: course
source_note: "[[{root}/source]]"
state_ref: "[[{root}/state]]"
review_enabled: true
review_date: 2099-01-01
plugin_hint: recall
---
# Future review
## 复习要点
- Existing reference fact
''')
        self.fixture.write(root + '/source.md', '# Original source\n')
        catalog, identities = exporter.capture_catalog(self.vault)
        self.assertEqual(catalog['practiceItems'], [])
        bundle, bindings = exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        self.assertEqual(len(bundle['items']), 1)
        self.assertEqual(bundle['items'][0]['itemKey'], 'practice:future-one')
        self.assertEqual(bindings['practice:future-one']['reviewCardPath'], root + '/future.md')
        self.assertEqual(schema.validate_bundle(bundle), bundle)

    def test_active_registered_card_can_keep_a_draft_source_note_for_local_provenance(self):
        root = self.fixture.subject('reading', 'recall')
        self.fixture.write(root + '/card.md', f'''---
type: learning-result
item_id: draft-source-card
ability_id: reading-draft-source
domain: paper
source_note: "[[{root}/source]]"
state_ref: "[[{root}/state]]"
review_enabled: true
review_date: 2026-09-01
plugin_hint: recall
---
# Verified review card
## 复习要点
- Registered reference fact
''')
        self.fixture.write(root + '/source.md', '''---
type: paper-note
status: active
quality_status: draft
---
# Original draft source
''')
        try:
            catalog, identities = exporter.capture_catalog(self.vault)
        except ValueError as error:
            self.fail(f'draft source provenance blocked an active registered card: {error}')
        bundle, bindings = exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        self.assertEqual([item['itemKey'] for item in bundle['items']], ['practice:draft-source-card'])
        self.assertIn(root + '/source.md', bindings['practice:draft-source-card']['binding']['sourceFingerprints'])

    def test_two_column_words_remain_learnable_without_invented_example(self):
        self.word()
        before = {p: p.read_bytes() for p in self.vault.rglob('*.md')}
        bundle, bindings = self.capture(); item = bundle['items'][0]
        self.assertEqual(item['word']['example'], '')
        self.assertEqual(item['completionRule'], 'graded-practice')
        self.assertEqual(item['language'], 'en')
        self.assertEqual(schema.compatible_modes(item), ['recall', 'flashcard', 'spelling'])
        self.assertEqual({p: p.read_bytes() for p in self.vault.rglob('*.md')}, before)
        self.assertIn('stateRef', bindings[item['itemKey']]['binding'])
        wire = json.dumps(bundle, ensure_ascii=False)
        for forbidden in ('sourceNote', 'stateRef', 'contentRef', 'documentPath', 'recordsRoot', str(self.vault)):
            self.assertNotIn(forbidden, wire)

    def test_full_word_and_explicit_item_spelling_keep_semantics(self):
        self.word('A tree grows here.')
        catalog, identities = exporter.capture_catalog(self.vault)
        bundle, _ = self.capture()
        self.assertEqual(bundle['items'][0]['completionRule'], 'three-stage')
        catalog['subjects'][0]['items'][0]['pluginType'] = 'spelling'
        # The pure mapper is also usable by a trusted approved-source adapter.
        bundle, _ = exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-b', 2, '2026-09-01T00:00:00.000Z')
        self.assertEqual(bundle['items'][0]['recommendedPlugin'], 'spelling')
        self.assertEqual(bundle['items'][0]['completionRule'], 'graded-practice')

    def test_quiz_numeric_text_answer_is_matched_before_index_conversion(self):
        root = self.fixture.subject('math', 'quiz')
        self.fixture.write(root + '/numbers.md', '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: numbers\nzhixue_format: quiz\n---\n| ID | prompt | options | answer |\n|---|---|---|---|\n| q1 | One? | 1;2;3 | 1 |\n')
        bundle, _ = self.capture(); self.assertEqual(bundle['items'][0]['practice']['answer'], 0)

    def test_flashcard_keeps_back_and_code_does_not_decode_twice(self):
        root = self.fixture.subject('cards', 'flashcard')
        self.fixture.write(root + '/cards.md', '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: cards\nzhixue_format: flashcard\n---\n| ID | front | back |\n|---|---|---|\n| q1 | Front text | Back fact |\n')
        root2 = self.fixture.subject('code', 'code')
        self.fixture.write(root2 + '/code.md', '---\ntype: zhixue-content\nzhixue: true\nzhixue_id: code\nzhixue_format: code\n---\n| ID | prompt | initialCode | testCode |\n|---|---|---|---|\n| q1 | Code? | def f():\\n  return 1 | assert f() == 1 |\n')
        bundle, _ = self.capture()
        by_subject = {i['subjectId']: i for i in bundle['items']}
        self.assertEqual(by_subject['cards']['practice']['answer'], 'Back fact')
        self.assertEqual(by_subject['code']['practice']['initialCode'], 'def f():\n  return 1')

    def test_diagnostics_unknown_language_and_disabled_gateway_pause_publication(self):
        self.word(language='')
        with self.assertRaisesRegex(ValueError, 'language'): self.capture()
        self.word()
        catalog, identities = exporter.capture_catalog(self.vault)
        catalog['diagnostics'].append({'code': 'source-unreadable'})
        with self.assertRaisesRegex(ValueError, 'incomplete'): exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        path = self.vault / self.fixture.entry / 'index.md'
        path.write_text('---\ntype: zhixue-gateway\nschema_version: 1\nenabled: false\n---\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'disabled'): self.capture()

    def test_semantic_source_change_changes_content_but_clock_does_not(self):
        root = self.word('A tree grows here.')
        catalog, identities = exporter.capture_catalog(self.vault)
        first, _ = self.capture()
        second, _ = exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-b', 2, '2026-09-02T00:00:00.000Z')
        self.assertEqual(first['items'], second['items'])
        path = self.vault / root / 'words.md'; path.write_text(path.read_text(encoding='utf-8').replace('树', '树木'), encoding='utf-8')
        third, _ = self.capture()
        self.assertNotEqual(first['items'][0]['contentHash'], third['items'][0]['contentHash'])

    def test_missing_bindings_or_duplicate_items_never_publish_partial_bundle(self):
        self.word('A tree grows here.'); catalog, identities = exporter.capture_catalog(self.vault)
        catalog['bindings'] = {}
        with self.assertRaisesRegex(ValueError, 'binding'): exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')
        catalog, identities = exporter.capture_catalog(self.vault)
        catalog['subjects'][0]['items'].append(copy.deepcopy(catalog['subjects'][0]['items'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'): exporter.export_catalog(catalog, identities, 'library-a', 'snapshot-a', 1, '2026-09-01T00:00:00.000Z')

    def test_repeated_file_capture_cannot_mix_language_with_another_source_revision(self):
        self.fixture.subject('words', 'three-stage')
        path = self.vault / self.fixture.entry / 'subjects/words.md'
        original = path.read_text(encoding='utf-8').replace('auto: true', 'auto: false\nlanguage: en')
        original += f'\n| id | content_ref | format |\n|---|---|---|\n| words | [[{self.fixture.entry}/subjects/words#Words]] | vocabulary |\n\n## Words\n| word | meaning | example |\n|---|---|---|\n| Tree | 树 | A tree grows here. |\n'
        path.write_text(original, encoding='utf-8')
        read_bytes = Path.read_bytes; calls = 0
        def changed_file(target):
            nonlocal calls
            if target == path:
                calls += 1
                if calls == 1: target.write_text(original.replace('language: en', 'language: fr').replace('| Tree |', '| Arbre |'), encoding='utf-8')
                if calls == 2: target.write_text(original.replace('language: en', 'language: ja'), encoding='utf-8')
            return read_bytes(target)
        with mock.patch.object(Path, 'read_bytes', changed_file):
            with self.assertRaisesRegex(ValueError, 'capture-conflict'): exporter.capture_catalog(self.vault)

    def test_source_fingerprint_ignores_owned_index_and_quoted_card_schedule(self):
        from managed_markdown import replace_managed_block
        original = '# Source\nOriginal facts.\n'
        updated = replace_managed_block(original, '%% ZHIXUE:GATEWAY-INDEX:BEGIN %%', '%% ZHIXUE:GATEWAY-INDEX:END %%', 'Generated references')
        self.assertEqual(exporter.source_fingerprint(original.encode()), exporter.source_fingerprint(updated.encode()))
        card = '---\ntype: "learning-result"\nreview_date: 2026-09-01\nreview_enabled: true\n---\n# Card\nOriginal fact\n'
        changed = card.replace('2026-09-01', '2026-09-08').replace('review_enabled: true', 'review_enabled: false')
        self.assertEqual(exporter.source_fingerprint(card.encode()), exporter.source_fingerprint(changed.encode()))


if __name__ == '__main__': unittest.main()
