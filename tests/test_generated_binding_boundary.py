"""Synthetic provider output cannot choose an unrelated learning-note target."""
import json
import hashlib
import sqlite3
import unittest
from contextlib import closing
from unittest import mock

import test_companion as fixture_module
from infrastructure.legacy_ai import LegacyLearningProvider, LegacyModelPorts
from application.generated_content import sanitize_generated_payload as normalize_generated_payload
from infrastructure.study_adapter import create_study_application


def sanitize_generated_payload(value):
    return normalize_generated_payload(value, hash_text=lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest())


class GeneratedBindingBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.h = fixture_module.CompanionSyncTests('test_state_projection_failure_rolls_back_event_and_vault_log')
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.server = fixture_module.server
        self.state_ref = '01 学习/专项课程/Test/学习记录/第01讲 学习状态.md'
        self.state = self.h.vault / self.state_ref

    def generate(self, item):
        payload = {'subjects': [{'id': 'synthetic-course', 'name': 'Current lesson',
            'pluginType': 'quiz', 'domain': 'courses', 'items': [item]}]}
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            'choices': [{'message': {'content': json.dumps(payload)}}]}).encode()
        transport = mock.Mock(return_value=response)
        provider = LegacyLearningProvider(LegacyModelPorts(
            key=lambda: 'synthetic-not-a-live-key', model=lambda default: default,
            default_model=lambda: 'synthetic-model', open=transport, validate=self.server.validate_cards))
        result = provider.call_deepseek('Current lesson concerns a different topic.', '', 'Current lesson', 'synthetic')
        self.assertEqual(transport.call_count, 1)
        return result['subjects'][0]['items'][0]

    def item(self, **metadata):
        return {'id': 'synthetic-provider-id', 'prompt': 'Which statement explains the current concept?',
                'options': ['First statement', 'Second statement'], 'answer': 'First statement', **metadata}

    def accept_like_subject_host(self, item):
        # Mirror only the host's metadata bridge; parsing/provider/native writer
        # are real. This is not a browser or real-model instruction-following test.
        if item.get('itemId'):
            key = 'practice:' + item['itemId'].removeprefix('practice:')
        elif item.get('abilityId'):
            key = item['abilityId']
        elif item.get('topic'):
            key = 'topic:' + item['topic']
        else:
            key = item['id']
        activity = self.h.make_v3_activity('synthetic-generated-attempt',
            state_ref=item.get('stateRef'), ability_id=item.get('abilityId') or key, item_key=key)
        activity['event']['domain'] = 'differential-review'
        activity['event']['item']['kind'] = 'due'
        activity['event']['coreHash'] = self.server.compute_study_event_core_hash(activity['event'])
        with closing(sqlite3.connect(':memory:')) as database:
            return self.server.accept_study_event_v3(database, self.h.vault, 'synthetic-owner', activity)

    def test_provider_metadata_does_not_project_into_unrelated_state(self):
        self.assertFalse(self.server.effective_gateway(self.h.vault)['active'])
        before = self.state.read_bytes()
        item = self.generate(self.item(itemId='synthetic-question', abilityId='unrelated-ability', stateRef=self.state_ref))
        with self.assertRaisesRegex(ValueError, 'source-unverified'):
            self.accept_like_subject_host(item)
        self.assertEqual(self.state.read_bytes(), before)

    def test_provider_item_id_cannot_redirect_unmapped_result_card_fallback(self):
        card = self.h.write('01 学习/学习结果/unrelated-card.md',
            '---\ntype: learning-result\ndomain: course\nitem_id: unrelated-card\n'
            'ability_id: unrelated-ability\nreview_date: 2026-08-18\n'
            f'state_ref: "[[{self.state_ref}]]"\n---\n# Card\n复习要点：\n- Other topic\n')
        before = card.read_bytes()
        item = self.generate(self.item(itemId='unrelated-card', abilityId='unrelated-ability', id='practice:unrelated-card'))
        with self.assertRaisesRegex(ValueError, 'source-unverified'):
            self.accept_like_subject_host(item)
        self.assertEqual(card.read_bytes(), before)

    def test_bare_provider_id_does_not_acquire_result_card_authority(self):
        card = self.h.write('01 学习/学习结果/unrelated-card.md',
            '---\ntype: learning-result\ndomain: course\nitem_id: unrelated-card\n'
            'ability_id: practice:unrelated-card\nreview_date: 2026-08-18\n'
            f'state_ref: "[[{self.state_ref}]]"\n---\n# Card\n复习要点：\n- Other topic\n')
        before = card.read_bytes()
        item = self.generate(self.item(id='practice:unrelated-card', topic=''))
        with self.assertRaisesRegex(ValueError, 'source-unverified'):
            self.accept_like_subject_host(item)
        self.assertEqual(card.read_bytes(), before)

    def test_cached_generated_bindings_are_retired_before_handle_attachment(self):
        from types import SimpleNamespace
        cached = {'contentMode': 'personal', 'source': {'path': '已授权的本地来源',
            'title': 'Current lesson', 'scope': 'synthetic'}, 'subjects': [
            {'id': 'synthetic-course', 'pluginType': 'recall', 'items': [{
                'id': 'practice:old-card', 'prompt': 'Current concept', 'explanation': 'Reference',
                'abilityId': 'old-ability', 'stateRef': self.state_ref, 'stateHandle': 'old-handle'}]}]}
        before = json.loads(json.dumps(cached))
        observed = []

        def handles(value, owner):
            item = value['subjects'][0]['items'][0]
            self.assertFalse({'stateRef', 'abilityId', 'stateHandle'} & item.keys())
            observed.append(owner)
            return value

        services = SimpleNamespace(source_path=lambda _: self.h.vault / 'no-configured-vault', DATA_LOCK=self.server.DATA_LOCK,
            STATE=cached, indexed_study_payload=lambda *_args, **_kwargs: None,
            attach_state_handles=handles, local_vault_library_id=lambda _: 'synthetic-library',
            with_connections=lambda value: value)
        app = create_study_application(services)
        read = app.read('synthetic-owner')
        self.assertEqual(observed, ['synthetic-owner'])
        self.assertEqual(cached, before)
        self.assertEqual(sanitize_generated_payload(read), read)

    def test_trusted_source_payload_and_generated_word_content_remain_intact(self):
        trusted = {'source': {'path': 'lesson.md'}, 'subjects': [{'id': 'mapped:course',
            'pluginType': 'recall', 'items': [{'id': 'registered', 'itemId': 'registered',
                'abilityId': 'trusted-ability', 'stateRef': self.state_ref}]}]}
        self.assertIs(sanitize_generated_payload(trusted), trusted)
        words = {'subjects': [{'id': 'ielts-vocabulary', 'name': 'Words', 'pluginType': 'three-stage',
            'items': [{'id': 'word-stable', 'word': 'variant', 'meaning': '变体',
                'example': 'A variant.', 'source': 'Current lesson', 'distractors': ['a', 'b', 'c']}]}]}
        item = self.server.validate_cards(words, 'Current lesson', 'synthetic')['subjects'][0]['items'][0]
        self.assertEqual(item['id'], 'word-stable')
        self.assertEqual((item['word'], item['meaning'], item['example'], item['distractors']),
                         ('variant', '变体', 'A variant.', ['a', 'b', 'c']))

    def test_nonword_content_identity_ignores_provider_routing_and_ids(self):
        plain = self.generate(self.item(id='provider-a'))
        altered = self.generate(self.item(id='provider-b', itemId='foreign', abilityId='foreign', stateRef=self.state_ref))
        self.assertEqual(plain['itemId'], altered['itemId'])
        self.assertEqual(plain['id'], plain['itemId'])
        self.assertFalse(plain['allowLegacyAliases'])
        self.assertEqual(plain['contentHash'], plain['id'].removeprefix('generated:'))
        self.assertTrue(plain['sourceConfirmationRequired'])
        different = self.generate({**self.item(), 'prompt': 'A different actual task.'})
        self.assertNotEqual(plain['id'], different['id'])

    def test_provider_cannot_shadow_the_trusted_mapped_subject_namespace(self):
        value = self.server.validate_cards({'subjects': [{'id': 'mapped:course', 'name': 'Generated',
            'pluginType': 'recall', 'items': [{'id': 'raw', 'prompt': 'Current concept'}]}]},
            'Current lesson', 'synthetic')
        self.assertTrue(value['subjects'][0]['id'].startswith('generated-subject:'))
        self.assertEqual(sanitize_generated_payload(value), value)

    def test_all_generated_formats_exclude_provider_binding_fields(self):
        cases = [
            ('three-stage', {'word': 'variant', 'meaning': '变体'}),
            ('quiz', self.item()),
            ('recall', {'prompt': 'Explain the concept', 'answer': 'Reference'}),
            ('calculation', {'prompt': 'Compute the result', 'answer': 2}),
            ('flashcard', {'front': 'One concept', 'back': 'Reference'}),
            ('code', {'prompt': 'Implement f', 'initialCode': 'def f(): pass',
                      'testCode': 'assert f() == 1'})]
        for plugin, content in cases:
            raw = {**content, 'id': 'provider-id', 'itemId': 'foreign', 'abilityId': 'foreign',
                   'stateRef': self.state_ref, 'sourceNote': self.state_ref,
                   'stateHandle': 'foreign-handle', 'accountItemKey': 'foreign-key'}
            with self.subTest(plugin=plugin):
                value = self.server.validate_cards({'subjects': [{'id': 'generated-content',
                    'pluginType': plugin, 'items': [raw]}]}, 'Current lesson', 'synthetic')
                item = value['subjects'][0]['items'][0]
                self.assertFalse({'abilityId', 'stateRef', 'sourceNote', 'stateHandle', 'accountItemKey'} & item.keys())
                if plugin == 'three-stage':
                    self.assertEqual(item['id'], 'provider-id')
                    self.assertNotIn('itemId', item)
                else:
                    self.assertTrue(item['itemId'].startswith('generated:'))
                    self.assertFalse(item['allowLegacyAliases'])
                self.assertEqual(sanitize_generated_payload(value), value)
