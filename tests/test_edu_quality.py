"""Deterministic fixtures, no network or real study records."""
import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from recall_quality import validate_recall_evaluation, recall_reference
import practice_engine

class EduQualityTests(unittest.TestCase):
    def test_shared_evaluation_fixtures(self):
        cases=json.loads((Path(__file__).parent/'fixtures/edu-recall-evaluation-v1.json').read_text(encoding='utf-8'))['cases']
        for case in cases:
            with self.subTest(case=case['id']):
                if case.get('error'):
                    with self.assertRaises(ValueError) as raised:
                        validate_recall_evaluation(case['result'],case['criteria'])
                    self.assertEqual(str(raised.exception),case['error'])
                else:
                    self.assertEqual(validate_recall_evaluation(case['result'],case['criteria']),case['expected'])

    def test_no_reference_never_calls_grader(self):
        def denied(*_):
            self.fail('provider must not be called without reference')
        item={'questionType':'recall','prompt':'为什么？','answer':'为什么？','explanation':'为什么？'}
        before=copy.deepcopy(item)
        result=practice_engine.grade_answer(item,'我的回答',recall_grader=denied)
        self.assertIsNone(result['correct'])
        self.assertEqual(result['source'],'self-assess')
        self.assertNotIn('rating',result)
        self.assertEqual(item,before)

    def test_independent_answer_is_selected_and_item_is_not_modified(self):
        item={'questionType':'recall','itemId':'unchanged','fingerprint':'v1','prompt':'为什么？','explanation':'为什么？','answer':'因为有前提条件。'}
        before=copy.deepcopy(item)
        def grader(received, answer):
            self.assertEqual(received['explanation'],'因为有前提条件。')
            self.assertEqual(received['itemId'],'unchanged')
            self.assertEqual(received['fingerprint'],'v1')
            return {'verdict':'correct'}
        result=practice_engine.grade_answer(item,'因为有前提条件',recall_grader=grader)
        self.assertEqual(result['rating'],'good')
        self.assertEqual(item,before)

    def test_conflict_remains_ungraded_not_silently_downgraded(self):
        item={'questionType':'recall','prompt':'Q','answer':'A'}
        for payload in ({'verdict':'incorrect','rating':'good'},{'feedback':'only prose'}):
            result=practice_engine.grade_answer(item,'A',recall_grader=lambda *_:payload)
            self.assertEqual(result['source'],'self-assess')
            self.assertIsNone(result['correct'])
            self.assertNotIn('rating',result)
            self.assertTrue(result['aiFallback'])

    def test_mandatory_gap_cannot_claim_complete(self):
        support={'schemaVersion':1,'type':'recall','criteria':[{'id':'condition','text':'成立条件','mandatory':True}]}
        item={'questionType':'recall','prompt':'Q','answer':'A','learningSupport':support}
        result=practice_engine.grade_answer(item,'A',recall_grader=lambda *_:{'verdict':'correct','matchedPointIds':[],'missedPointIds':['condition']})
        self.assertEqual(result['source'],'self-assess')
        self.assertNotIn('rating',result)

    def test_model_cannot_upgrade_correct_to_easy(self):
        result=practice_engine.grade_answer({'questionType':'recall','prompt':'Q','answer':'A'},'A',
            recall_grader=lambda *_:{'verdict':'correct','rating':'easy'})
        self.assertEqual(result['source'],'self-assess')
        self.assertNotIn('rating',result)

    def test_zero_and_symbol_distinctions_are_preserved(self):
        for prompt,answer in [('Q',0),('x²','x2'),('x+1','x-1'),('X','x')]:
            self.assertEqual(recall_reference({'prompt':prompt,'answer':answer}),str(answer))

if __name__=='__main__':
    unittest.main()
