import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from practice_engine import grade_answer


class CourseTaskAiBoundaryTests(unittest.TestCase):
    def test_legacy_grader_never_scores_v2_without_the_new_task_context(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures' / 'course-task-support-v2.json').read_text(encoding='utf-8'))
        for row in fixture['cases']:
            if not row['valid']:
                continue
            for qtype in (row['mode'], 'calculation', 'code', 'flashcard', 'unknown'):
                calls = []
                item = {'questionType': qtype, 'prompt': row['support']['task']['prompt'], 'learningSupport': row['support'], 'answer': '1'}
                with self.subTest(kind=row['id'], display=qtype):
                    with self.assertRaisesRegex(ValueError, 'course-task-evaluation-unavailable'):
                        grade_answer(item, '1', recall_grader=lambda *_: calls.append('called'))
                    self.assertEqual(calls, [])
