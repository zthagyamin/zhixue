"""Saved website option IDs preserve the shared selection meaning."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from application.source_choice import grade_source_choice
from quiz_support import parse_quiz_support


class SourceChoiceTests(unittest.TestCase):
    def test_shared_website_selection_fixtures(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/source-choice-v1.json').read_text(encoding='utf-8'))
        self.assertEqual(fixture['schemaVersion'], 1)
        for case in fixture['cases']:
            with self.subTest(case=case['id']):
                before = copy.deepcopy(case)
                result = grade_source_choice(case['item'], json.dumps(case['selection'], ensure_ascii=False), parse_support=parse_quiz_support)
                verdict = 'incorrect' if result['verdict'] == 'wrong' else result['verdict']
                self.assertEqual(verdict, case['status'])
                self.assertEqual(result['correct'], case['status'] == 'correct')
                self.assertEqual(case, before)

    def test_invalid_or_unknown_selection_is_not_incorrect(self):
        item = {'options': ['first', 'second'], 'answer': 'first'}
        for answer in ('not-json', '[]', '["unknown-id"]', '["option-0","option-0"]',
                       '["option-0","option-1"]', True, None):
            with self.subTest(answer=answer):
                self.assertEqual(grade_source_choice(item, answer, parse_support=parse_quiz_support)['verdict'], 'unknown')
                self.assertIsNone(grade_source_choice(item, answer, parse_support=parse_quiz_support)['correct'])


if __name__ == '__main__':
    unittest.main()
