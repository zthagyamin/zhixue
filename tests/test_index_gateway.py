import importlib
import tempfile
import unittest
from unittest import mock
from pathlib import Path

try:
    gateway = importlib.import_module("index_gateway")
except ModuleNotFoundError:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
    try:
        gateway = importlib.import_module("index_gateway")
    except ModuleNotFoundError:
        gateway = None


class IndexGatewayTests(unittest.TestCase):
    def test_vocabulary_blank_rows_do_not_silently_drop_registered_words(self):
        root = self.subject('words', 'three-stage')
        self.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning |\n|---|---|\n| Tree | 树 |\n\n| River | 河 |\n\n\n| Sea | 海 |\n\n| word | meaning |\n|---|---|\n| Lake | 湖 |\n\nUnrelated paragraph.\n\n| arbitrary | data |\n')
        catalog = gateway.load_gateway(self.vault, refresh=False)
        self.assertEqual([item['word'] for item in catalog['subjects'][0]['items']], ['Tree', 'River', 'Sea', 'Lake'])
        self.assertEqual(catalog['diagnostics'], [])

    def setUp(self):
        self.assertIsNotNone(gateway, "The fixed index gateway is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name)
        self.entry = "_System/Integrations/Study Loop/gateway"
        self.write(f"{self.entry}/index.md", "---\ntype: zhixue-gateway\nschema_version: 1\n---\n# Gateway\n")

    def tearDown(self):
        if hasattr(self, "temp"):
            self.temp.cleanup()

    def write(self, relative, text):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_read_request_reuses_paths_but_next_request_revalidates_sources(self):
        root = self.subject('words', 'three-stage')
        words = self.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning |\n|---|---|\n' +
                           ''.join(f'| word{i} | meaning |\n' for i in range(100)))
        resolve, calls = Path.resolve, []
        def observed(path, *args, **kwargs):
            calls.append(str(path))
            return resolve(path, *args, **kwargs)
        with mock.patch.object(Path, 'resolve', observed):
            before = gateway.load_gateway(self.vault)
        self.assertEqual(len(before['subjects'][0]['items']), 100)
        self.assertLess(len(calls), 200, 'A catalog read should not canonicalize the same root/state per item')
        words.write_text(words.read_text(encoding='utf-8').replace('word0 | meaning', 'word0 | changed meaning'), encoding='utf-8')
        after = gateway.load_gateway(self.vault)
        key = next(key for key, binding in before['bindings'].items() if binding['wordKey'] == 'word0')
        self.assertNotEqual(before['bindings'][key]['signature'], after['bindings'][key]['signature'])

    def subject(self, subject_id="astronomy-fixture", plugin="quiz", identity="scoped"):
        root = f"subjects/{subject_id}"
        self.write(f"{root}/state.md", "---\ntype: zhixue-practice-state\n---\n# Practice state\n")
        self.write(f"{self.entry}/subjects/{subject_id}.md", f'''---
type: zhixue-subject-index
schema_version: 1
subject_id: {subject_id}
name: Test subject
domain: astronomy
plugin: {plugin}
content_root: "{root}"
progress_ref: "[[{root}/state]]"
records_root: "{root}/records"
identity: {identity}
enabled: true
auto: true
---
# Index
''')
        return root

    def quiz(self, root, filename="lesson.md", doc_id="lesson-a", status="ready"):
        return self.write(f"{root}/{filename}", f'''---
type: zhixue-content
zhixue: true
zhixue_id: {doc_id}
zhixue_format: quiz
status: {status}
---
# Lesson
| ID | 题干 | 选项 | 答案 | 解析 |
|---|---|---|---|---|
| q1 | Which planet? | Earth;Mars | Earth | Grounded explanation |
''')

    def test_new_subject_is_data_only_and_has_scoped_identity(self):
        root = self.subject()
        source = self.quiz(root)
        before = source.read_bytes()
        catalog = gateway.load_gateway(self.vault, refresh=True)
        self.assertTrue(catalog["active"])
        self.assertEqual(catalog["diagnostics"], [])
        subject = catalog["subjects"][0]
        self.assertEqual(subject["id"], "astronomy-fixture")
        self.assertEqual(subject["domain"], "astronomy")
        self.assertEqual(subject["eventDomain"], "differential-review")
        self.assertEqual(subject["sourceMode"], "gateway")
        self.assertEqual(subject["items"][0]["itemId"], "astronomy-fixture:lesson-a:q1")
        self.assertEqual(subject["items"][0]["stateRef"], root + "/state.md")
        self.assertEqual(source.read_bytes(), before)
        index = (self.vault / self.entry / "subjects/astronomy-fixture.md").read_text(encoding="utf-8")
        self.assertIn(f"[[{root}/lesson.md]]", index)
        self.assertNotIn("Which planet?", index)

    def test_add_content_and_subject_without_restarting_reader(self):
        root = self.subject()
        self.quiz(root)
        self.assertEqual(len(gateway.load_gateway(self.vault)["subjects"]), 1)
        second = self.subject("botany-fixture")
        self.quiz(second)
        self.quiz(root, "next.md", "lesson-b")
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual([len(s["items"]) for s in catalog["subjects"]], [2, 1])

    def test_rename_retains_item_identity_and_updates_reference(self):
        root = self.subject()
        path = self.quiz(root)
        before = gateway.load_gateway(self.vault)["subjects"][0]["items"][0]["itemId"]
        path.rename(path.with_name("renamed.md"))
        item = gateway.load_gateway(self.vault)["subjects"][0]["items"][0]
        self.assertEqual(item["itemId"], before)
        self.assertEqual(item["sourceNote"], root + "/renamed.md")

    def test_draft_archive_and_unregistered_content_do_not_enter(self):
        root = self.subject()
        self.quiz(root)
        self.quiz(root, "draft.md", "draft", "draft")
        self.quiz(root, "_Archive/old.md", "old")
        self.quiz("unregistered", "outside.md", "outside")
        items = gateway.load_gateway(self.vault)["subjects"][0]["items"]
        self.assertEqual([i["itemId"] for i in items], ["astronomy-fixture:lesson-a:q1"])

    def test_removal_is_reflected_in_derived_index(self):
        root = self.subject()
        path = self.quiz(root)
        gateway.load_gateway(self.vault, refresh=True)
        path.unlink()
        catalog = gateway.load_gateway(self.vault, refresh=True)
        self.assertEqual(catalog["subjects"][0]["items"], [])
        self.assertNotIn("lesson.md", (self.vault / self.entry / "subjects/astronomy-fixture.md").read_text(encoding="utf-8"))

    def test_file_heading_and_block_references_select_only_target_content(self):
        self.write("notes/note.md", "# Note\n## First\nAlpha\n\n## Second\nBeta\n\nA paragraph\nwith two lines. ^target\n")
        path, text = gateway.resolve_reference(self.vault, "[[notes/note#First|Alias]]")
        self.assertEqual(path.name, "note.md")
        self.assertIn("Alpha", text)
        self.assertNotIn("Beta", text)
        _, block = gateway.resolve_reference(self.vault, "[[notes/note#^target]]")
        self.assertIn("A paragraph", block)
        self.assertNotIn("Alpha", block)

    def test_ambiguous_heading_and_missing_target_fail_closed(self):
        self.write("notes/note.md", "# Same\nA\n# Same\nB\n")
        with self.assertRaises(ValueError):
            gateway.resolve_reference(self.vault, "[[notes/note#Same]]")
        with self.assertRaises(ValueError):
            gateway.resolve_reference(self.vault, "[[missing]]")

    def test_reference_cannot_escape_vault(self):
        for ref in ("[[../outside]]", "[[/etc/passwd]]", "[[C:/outside]]", "https://example.com"):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                gateway.resolve_reference(self.vault, ref)

    def test_invalid_gateway_does_not_enable_legacy_fallback(self):
        self.write(f"{self.entry}/index.md", "---\ntype: zhixue-gateway\nschema_version: 999\n---\n")
        catalog = gateway.load_gateway(self.vault)
        self.assertTrue(catalog["active"])
        self.assertEqual(catalog["subjects"], [])
        self.assertIn("unsupported-version", [d["code"] for d in catalog["diagnostics"]])

    def test_missing_index_in_gateway_directory_fails_closed(self):
        (self.vault / self.entry / "index.md").unlink()
        self.assertTrue(gateway.load_gateway(self.vault)["active"])
        self.assertTrue(gateway.load_gateway(self.vault)["diagnostics"])

    def test_absent_gateway_keeps_explicit_legacy_mode(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertFalse(gateway.load_gateway(Path(empty))["active"])

    def test_unsupported_plugin_is_reported_not_reinterpreted(self):
        self.subject(plugin="speech-scoring")
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(catalog["subjects"], [])
        self.assertIn("unsupported-plugin", [d["code"] for d in catalog["diagnostics"]])

    def test_duplicate_document_ids_do_not_silently_pick_one(self):
        root = self.subject()
        self.quiz(root)
        self.quiz(root, "duplicate.md")
        catalog = gateway.load_gateway(self.vault)
        self.assertIn("duplicate-item-id", [d["code"] for d in catalog["diagnostics"]])
        self.assertEqual(catalog["subjects"][0]["items"], [])

    def test_vocabulary_table_aliases_and_scoped_words(self):
        root = self.subject(plugin="three-stage")
        self.write(root + "/vocab.md", "---\ntype: vocabulary-database\nstatus: active\n---\n# Words\n| 单词 / 词组 | 释义 | 原文语境 (Context) |\n|---|---|---|\n| cell | 细胞 | A cell grows. |\n")
        item = gateway.load_gateway(self.vault)["subjects"][0]["items"][0]
        self.assertEqual(item["abilityId"], "word:astronomy-fixture:cell")
        self.assertEqual(item["example"], "A cell grows.")

    def test_legacy_identity_preserves_existing_vocabulary_key(self):
        root = self.subject(plugin="three-stage", identity="legacy")
        self.write(root + "/vocab.md", "---\ntype: vocabulary-session\n---\n| 单词 / 词组 | 释义 | 原文语境 (Context) |\n|---|---|---|\n| pooling layer | 池化层 | Pooling layers. |\n")
        item = gateway.load_gateway(self.vault)["subjects"][0]["items"][0]
        self.assertEqual(item["abilityId"], "word:pooling-layer")

    def test_explicit_index_is_a_reference_not_a_content_copy(self):
        root = self.subject()
        index = self.vault / self.entry / "subjects/astronomy-fixture.md"
        text = index.read_text(encoding="utf-8").replace("auto: true", "auto: false")
        index.write_text(text + f"\n| id | content_ref | format | state_ref |\n|---|---|---|---|\n| manual | [[{root}/plain#Quiz]] | quiz | [[{root}/state]] |\n", encoding="utf-8")
        self.write(root + "/plain.md", "# Raw\n## Quiz\n| ID | 题干 | 选项 | 答案 |\n|---|---|---|---|\n| q1 | Which? | A;B | A |\n## Other\nDo not include.\n")
        item = gateway.load_gateway(self.vault)["subjects"][0]["items"][0]
        self.assertEqual(item["itemId"], "astronomy-fixture:manual:q1")
        self.assertEqual(item["prompt"], "Which?")

    def test_result_cards_are_discovered_only_from_indexed_subjects(self):
        root = self.subject(plugin="recall")
        card = "---\ntype: learning-result\ndomain: course\nitem_id: old-stable-id\nability_id: ability-a\nreview_enabled: true\nreview_date: 2026-01-01\nsource_note: \"[[%s/state]]\"\nstate_ref: \"[[%s/state]]\"\n---\n# Result\n\n复习要点：\n- Explain A\n" % (root, root)
        target = self.write(root + "/result.md", card)
        self.write("01 学习/学习结果/unregistered.md", card.replace("old-stable-id", "outside"))
        self.assertEqual(gateway.indexed_result_paths(self.vault), [target.resolve()])

    def test_result_card_load_keeps_identity_and_does_not_guess_assessment(self):
        root = self.subject(plugin="recall")
        self.write(root + "/result.md", f'---\ntype: learning-result\ndomain: course\nitem_id: stable-result\nability_id: known-ability\nreview_enabled: true\nreview_date: 2026-01-01\nsource_note: "[[{root}/state]]"\nstate_ref: "[[{root}/state]]"\n---\n# Result\n\n复习要点：\n- Explain the distinction\n')
        try:
            catalog = gateway.load_gateway(self.vault)
        except AttributeError as error:
            self.fail(f"The indexed result-card boundary is missing: {error}")
        self.assertEqual(catalog["resultCards"][0]["itemId"], "stable-result")
        self.assertEqual(catalog["practiceItems"][0]["questionType"], "recall")
        # Preserve the existing safe-prompt policy while verifying that no reference is lost.
        item = catalog["practiceItems"][0]
        self.assertNotIn("Explain the distinction", item["prompt"])
        self.assertEqual(item["prompt"], "阅读材料：Result（待补具体问题）")
        for field in ("answer", "explanation", "reviewPoint"):
            self.assertEqual(item[field], "Explain the distinction")
        self.assertEqual(item["itemId"], "stable-result")
        self.assertEqual(item["abilityId"], "known-ability")
        self.assertEqual(item["sourceNote"], f"{root}/state.md")

    def test_subject_journal_is_local_to_subject_and_idempotent(self):
        root = self.subject()
        source = self.quiz(root)
        original = source.read_bytes()
        catalog = gateway.load_gateway(self.vault)
        binding = catalog["bindings"]["practice:astronomy-fixture:lesson-a:q1"]
        event = {"schemaVersion": 3, "eventId": "fixture-event-1", "coreHash": "hash", "eventType": "practice-attempt", "occurredAt": "2026-08-31T01:00:00Z", "item": {"key": "practice:astronomy-fixture:lesson-a:q1"}, "attempt": {"correct": True, "rating": "good", "stageAfter": 3}}
        record = getattr(gateway, "record_subject_event", None)
        self.assertIsNotNone(record, "Subject-owned recording is not implemented")
        path = record(self.vault, binding, "fixture-account", event, {})
        record(self.vault, binding, "fixture-account", event, {})
        self.assertTrue(path.is_relative_to(self.vault / root / "records"))
        self.assertEqual(len(gateway.read_subject_events(self.vault, binding, "fixture-account")), 1)
        self.assertEqual(gateway.read_subject_events(self.vault, binding, "another-account"), [])
        self.assertEqual(source.read_bytes(), original)
        with self.assertRaises(ValueError):
            record(self.vault, binding, "fixture-account", {**event, "coreHash": "changed"}, {})

    def test_journal_final_path_must_remain_inside_records_root(self):
        from unittest.mock import patch
        root = self.subject()
        self.quiz(root)
        binding = next(iter(gateway.load_gateway(self.vault)["bindings"].values()))
        original_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            resolved = original_resolve(path, *args, **kwargs)
            if path.name == "2026-08-31.jsonl":
                return self.vault / "outside" / path.name
            return resolved
        with patch.object(Path, "resolve", resolve), self.assertRaises(ValueError):
            gateway.subject_event_path(self.vault, binding, {"occurredAt": "2026-08-31T01:00:00Z"})

    def test_progress_events_reject_conflicts_across_subject_journals(self):
        from unittest.mock import patch
        catalog = {"bindings": {"a": {"recordsRoot": "a"}, "b": {"recordsRoot": "b"}}}
        def rows(vault, binding, account):
            return [{"event": {"eventId": "same", "coreHash": binding["recordsRoot"], "item": {"key": binding["recordsRoot"]}, "occurredAt": "2026-08-31T01:00:00Z"}}]
        with patch.object(gateway, "read_subject_events", rows), self.assertRaises(ValueError):
            gateway.progress_events(self.vault, catalog, "account")

    def test_numeric_answer_text_is_not_reinterpreted_as_option_index(self):
        root = self.subject()
        source = self.quiz(root)
        source.write_text(source.read_text(encoding='utf-8').replace('Earth;Mars | Earth', '1;2;3 | 1'), encoding='utf-8')
        self.assertEqual(gateway.load_gateway(self.vault)['subjects'][0]['items'][0]['answer'], '1')

    def test_explicit_short_alias_or_fragment_wins_over_auto_file(self):
        for ref in ('lesson', 'lesson|Alias', 'lesson#Lesson'):
            with self.subTest(ref=ref):
                root = self.subject()
                self.quiz(root)
                index = self.vault / self.entry / 'subjects/astronomy-fixture.md'
                index.write_text(index.read_text(encoding='utf-8') + f'\n| id | content_ref | format |\n|---|---|---|\n| manual | [[{root}/{ref}]] | quiz |\n', encoding='utf-8')
                catalog = gateway.load_gateway(self.vault)
                self.assertEqual(catalog['diagnostics'], [])
                self.assertEqual(len(catalog['subjects'][0]['items']), 1)

    def test_invalid_file_does_not_remove_other_content_in_the_subject(self):
        root = self.subject()
        self.quiz(root)
        self.write(root + '/bad.md', '---\ntype: zhixue-content\nzhixue: yes\n---\n# Bad')
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(len(catalog['subjects'][0]['items']), 1)
        self.assertTrue(catalog['diagnostics'])

    def test_table_source_and_explicit_ability_are_preserved_and_scoped(self):
        root = self.subject()
        self.write(root + '/original.md', '# Original\n')
        self.write(root + '/lesson.md', f'---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: quiz\n---\n| ID | 题干 | 选项 | 答案 | 来源笔记 | 能力ID |\n|---|---|---|---|---|---|\n| q | Which? | A;B | A | [[{root}/original]] | shared |\n')
        item = gateway.load_gateway(self.vault)['subjects'][0]['items'][0]
        self.assertEqual(item['sourceNote'], root + '/original.md')
        self.assertEqual(item['abilityId'], 'astronomy-fixture:shared')

    def test_different_symbols_and_non_latin_words_do_not_collapse(self):
        root = self.subject(plugin='three-stage')
        self.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning | context |\n|---|---|---|\n| C++ | language | Example |\n| C# | language | Example |\n| 细胞 | cell | Example |\n| 原子 | atom | Example |\n')
        items = gateway.load_gateway(self.vault)['subjects'][0]['items']
        self.assertEqual(len(items), 4)
        self.assertEqual(len({i['itemId'] for i in items}), 4)

    def test_default_progress_must_be_a_practice_state_not_original_content(self):
        root = self.subject()
        self.write(root + '/state.md', '# This is original content\n')
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(catalog['subjects'], [])
        self.assertTrue(catalog['diagnostics'])

    def test_dotted_wikilink_without_md_extension_resolves(self):
        self.write('notes/lesson.v1.md', '# Version one\n')
        path, text = gateway.resolve_reference(self.vault, '[[notes/lesson.v1]]')
        self.assertEqual(path.name, 'lesson.v1.md')

    def test_reference_can_include_citation_suffix_and_same_folder_link(self):
        root=self.subject(plugin='three-stage',identity='legacy')
        self.write(root+'/source.md','# Source\n')
        self.write(root+'/words.md','---\ntype: vocabulary-database\n---\n| word | meaning | context | sourceNote |\n|---|---|---|---|\n| cell | 细胞 | A cell. | [[source]]（原句第1页） |\n')
        catalog=gateway.load_gateway(self.vault)
        self.assertEqual(catalog['diagnostics'],[])
        self.assertEqual(catalog['subjects'][0]['items'][0]['sourceNote'],root+'/source.md')

    def test_multiple_provenance_targets_are_not_silently_guessed(self):
        self.write('one.md','# One\n')
        self.write('two.md','# Two\n')
        with self.assertRaises(ValueError):
            gateway.resolve_reference(self.vault,'[[one]] 和 [[two]]')

    def test_invalid_result_does_not_leak_to_other_catalog_outputs(self):
        root = self.subject(plugin='recall')
        self.write(root + '/card.md', f'---\ntype: learning-result\nitem_id: card\nability_id: a\nreview_enabled: true\nreview_date: 2026-01-01\nstate_ref: "[[{root}/state]]"\nsource_note: "[[missing]]"\n---\n# Card\n复习要点：\n- Point\n')
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(catalog['subjects'][0]['items'], [])
        self.assertEqual(catalog['practiceItems'], [])
        self.assertEqual(catalog['resultCards'], [])

    def test_future_result_is_available_as_content_but_not_due_practice(self):
        root = self.subject(plugin='recall')
        self.write(root + '/card.md', f'---\ntype: learning-result\nitem_id: card\nability_id: a\nreview_enabled: true\nreview_date: 2999-01-01\nstate_ref: "[[{root}/state]]"\nsource_note: "[[{root}/state]]"\n---\n# Card\n复习要点：\n- Point\n')
        catalog = gateway.load_gateway(self.vault)
        self.assertEqual(len(catalog['subjects'][0]['items']), 1)
        self.assertEqual(catalog['practiceItems'], [])

    def test_explicit_result_format_is_inferred_consistently(self):
        root = self.subject(plugin='recall')
        index = self.vault / self.entry / 'subjects/astronomy-fixture.md'
        index.write_text(index.read_text(encoding='utf-8').replace('auto: true','auto: false') + f'\n| id | content_ref | format |\n|---|---|---|\n| card | [[{root}/card]] | |\n', encoding='utf-8')
        path = self.write(root + '/card.md', f'---\ntype: learning-result\nitem_id: card\nability_id: a\nstate_ref: "[[{root}/state]]"\nsource_note: "[[{root}/state]]"\n---\n# Card\n复习要点：\n- Point\n')
        self.assertEqual(gateway.indexed_result_paths(self.vault), [path.resolve()])
