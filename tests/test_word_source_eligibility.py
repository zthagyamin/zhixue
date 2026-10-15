"""Content-backed word eligibility; identifiers and display plugins are not proof."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from application.generated_content import ensure_subject_payload, validate_cards
from infrastructure.word_source_eligibility import WordSourceEligibility
from source_area import parse_source_text
import hashlib


def word_payload(word='variant', meaning='A different form.', **item_fields):
    return {'subjects': [{'id': 'ielts-vocabulary', 'name': 'Original words',
                          'pluginType': 'three-stage', 'domain': 'ielts',
                          'items': [{'word': word, 'meaning': meaning, **item_fields}]}]}


class WordSourceEligibilityTests(unittest.TestCase):
    def service(self, *, approved=(), seed=None, cache=None):
        return WordSourceEligibility(lambda: copy.deepcopy(list(approved)),
                                     lambda: copy.deepcopy(seed or {}),
                                     lambda: copy.deepcopy(cache or {}))

    def test_actual_seed_word_keeps_the_real_frontend_key(self):
        seed = ensure_subject_payload(json.loads((Path(__file__).resolve().parents[1] /
                                                  'companion/data/seed.json').read_text(encoding='utf-8')))
        service = self.service(seed=seed)
        result = service.resolve('word:variant', {})
        self.assertTrue(result['eligible'])
        self.assertEqual(result['identity']['word'], 'variant')
        self.assertTrue(result['identity']['meaning'])
        self.assertFalse(service.original_word('word-1', {}))

    def test_kindless_normalized_cache_uses_original_word_and_meaning(self):
        service = self.service(cache=word_payload(id='provider-word-id',
                                                  abilityId='provider-ability',
                                                  accountItemKey='provider-key',
                                                  stateRef='unrelated-state.md'))
        result = service.resolve('word:variant', {})
        self.assertTrue(result['eligible'])
        self.assertEqual(result['identity']['sourceKind'], 'cache')
        self.assertFalse(any(key in result for key in ('route', 'context', 'stateRef', 'stateHandle')))
        for key in ('provider-word-id', 'provider-ability', 'provider-key'):
            self.assertFalse(service.original_word(key, {}))

    def test_request_kind_and_domain_cannot_turn_nonword_content_into_a_word(self):
        payload = {'subjects': [{'id': 'synthetic-quiz', 'pluginType': 'quiz', 'domain': 'ielts',
                                 'items': [{'id': 'variant', 'kind': 'quiz',
                                            'word': 'variant', 'prompt': 'Choose an answer.',
                                            'options': ['A', 'B'], 'answer': 'A'}]}]}
        service = self.service(cache=payload)
        self.assertFalse(service.admit({'item': {'kind': 'word', 'key': 'word:variant'},
                                       'domain': 'ielts'}, {})['eligible'])

    def test_a_word_field_without_a_meaning_is_not_lexical_material(self):
        service = self.service(cache=word_payload(meaning='', prompt='A quiz prompt.'))
        self.assertFalse(service.original_word('word:variant', {}))

    def test_nonword_carrier_summary_and_nested_exercise_are_not_lexical(self):
        for extra in ({'prompt': 'Explain the method.', 'answer': 'A grounded reference.'},
                      {'initialCode': 'def solve(): pass', 'testCode': 'assert solve() == 1'},
                      {'front': 'Explain this concept.', 'back': 'One concept.'},
                      {'practiceItem': {'questionType': 'code', 'prompt': 'Implement solve.'}},
                      {'learningSupport': {'type': 'calculation'}}):
            with self.subTest(extra=extra):
                self.assertFalse(self.service(cache=word_payload(**extra)).original_word('word:variant', {}))

    def test_current_presentation_override_does_not_change_original_word_classification(self):
        payload = word_payload(pluginType='recall')
        payload['subjects'][0]['pluginType'] = 'flashcard'
        self.assertTrue(self.service(cache=payload).original_word('word:variant', {}))

    def test_registered_scoped_vocabulary_uses_only_the_real_registered_identity(self):
        catalog = {'subjects': [{'id': 'registered', 'identity': 'scoped',
                                'items': [{'kind': 'vocabulary', 'abilityId': 'word:registered:42',
                                           'itemId': 'word:registered:42', 'word': 'variant',
                                           'meaning': 'A different form.', 'allowLegacyAliases': False}]}]}
        service = self.service()
        self.assertTrue(service.original_word('word:registered:42', catalog))
        self.assertFalse(service.original_word('word:variant', catalog))
        self.assertEqual(service.resolve('word:registered:42', catalog)['identity']['sourceKind'], 'catalog')

    def test_registered_legacy_vocabulary_retains_casefolded_word_alias(self):
        catalog = {'subjects': [{'id': 'registered', 'identity': 'legacy',
                                'items': [{'kind': 'vocabulary', 'abilityId': 'word:registered:42',
                                           'word': 'Variant', 'meaning': 'A different form.'}]}]}
        self.assertTrue(self.service().original_word('word:variant', catalog))

    def test_independently_reparsed_approved_word_is_eligible_without_a_display_pool(self):
        item = {'kind': 'vocabulary', 'abilityId': 'approved-variant',
                'word': 'variant', 'meaning': 'A different form.', 'subjectId': 'approved-source'}
        service = self.service(approved=[item])
        result = service.resolve('approved-variant', {})
        self.assertTrue(result['eligible'])
        self.assertEqual(result['identity']['sourceKind'], 'approved')

    def test_cache_mirror_of_seed_is_one_original_but_two_actual_candidates_are_ambiguous(self):
        seed = word_payload()
        cache = {**copy.deepcopy(seed), 'status': 'offline'}
        self.assertTrue(self.service(seed=seed, cache=cache).original_word('word:variant', {}))
        catalog = {'subjects': [{'id': 'one', 'identity': 'legacy', 'items': [
            {'kind': 'vocabulary', 'word': 'variant', 'meaning': 'A different form.'},
            {'kind': 'vocabulary', 'word': 'variant', 'meaning': 'A different form.'}]}]}
        self.assertFalse(self.service().original_word('word:variant', catalog))

    def test_seed_and_cache_different_original_meanings_cannot_share_a_key(self):
        service = self.service(seed=word_payload(), cache=word_payload(meaning='A conflicting meaning.'))
        result = service.resolve('word:variant', {})
        self.assertFalse(result['eligible'])
        self.assertEqual(result['reason'], 'word-source-ambiguous')

    def test_same_key_nonword_candidate_blocks_an_otherwise_valid_word(self):
        catalog = {'subjects': [{'id': 'mixed', 'identity': 'legacy', 'items': [
            {'kind': 'vocabulary', 'abilityId': 'word:variant',
             'word': 'variant', 'meaning': 'A different form.'},
            {'kind': 'quiz', 'abilityId': 'word:variant', 'itemId': 'quiz-source',
             'prompt': 'An unrelated question.', 'answer': 'A'}]}]}
        result = self.service().resolve('word:variant', catalog)
        self.assertFalse(result['eligible'])
        self.assertEqual(result['reason'], 'word-source-collision')

    def test_explicit_nonword_kind_with_word_and_meaning_is_not_a_vocabulary_exception(self):
        service = self.service(cache=word_payload(kind='quiz', questionType='quiz',
                                                  prompt='An unrelated question.'))
        self.assertFalse(service.original_word('word:variant', {}))

    def test_nonword_events_never_receive_word_exemption_even_for_a_real_key(self):
        service = self.service(seed=word_payload())
        for kind in ('due', 'python'):
            result = service.admit({'item': {'kind': kind, 'key': 'word:variant'}}, {})
            self.assertFalse(result['eligible'])
        self.assertTrue(service.admit({'item': {'kind': 'word', 'key': 'word:variant'}}, {})['eligible'])

    def test_loader_failure_is_fail_closed_and_does_not_return_partial_authority(self):
        def broken():
            raise OSError('synthetic source unavailable')
        service = WordSourceEligibility(broken, lambda: word_payload(), lambda: {})
        self.assertFalse(service.original_word('word:variant', {}))

    def test_approved_port_uses_actual_source_parser_vocabulary_identity(self):
        text = ('---\ntype: study-loop-source\n---\n## 单词\n'
                '| 单词/词组 | 释义 | 原文语境 |\n| --- | --- | --- |\n'
                '| variant | A different form. | An authored variant. |\n')
        approved = parse_source_text(text, Path('synthetic-approved.md'))
        self.assertEqual(len(approved), 1)
        item = approved[0]
        service = self.service(approved=approved)
        qualified = service.resolve(item['abilityId'], {})
        self.assertTrue(qualified['eligible'])
        self.assertEqual(qualified['identity']['word'], 'variant')
        self.assertEqual(qualified['identity']['sourceKind'], 'approved')

    def test_actual_provider_normalization_drops_incidental_word_fields_on_quiz(self):
        raw = {'subjects': [{'id': 'quiz-source', 'name': 'Quiz', 'pluginType': 'quiz',
                             'items': [{'id': 'word:variant', 'word': 'variant',
                                        'meaning': 'An incidental fake meaning.',
                                        'prompt': 'Choose A.', 'options': ['A', 'B'],
                                        'answer': 'A'}]}]}
        normalized = validate_cards(raw, 'Synthetic source', 'Synthetic scope', seed={},
                                    stamp=lambda _: '2026-10-10', code_material_available=lambda _: False,
                                    hash_text=lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest())
        self.assertNotIn('word', normalized['subjects'][0]['items'][0])
        self.assertFalse(self.service(cache=normalized).original_word('word:variant', {}))

    def test_identity_changes_with_original_meaning_and_is_not_a_route(self):
        one = self.service(seed=word_payload()).resolve('word:variant', {})['identity']
        two = self.service(seed=word_payload(meaning='Changed meaning.')).resolve('word:variant', {})['identity']
        self.assertNotEqual(one['contentHash'], two['contentHash'])
        self.assertNotEqual(one['identityHash'], two['identityHash'])
        self.assertFalse({'stateRef', 'sourceNote', 'route', 'context', 'stateHandle'} & one.keys())


if __name__ == '__main__':
    unittest.main()
