"""Actual legacy grading adapter, inspecting transport data without a model call."""
import io
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from infrastructure.legacy_ai import LegacyLearningProvider,LegacyModelPorts


class LegacyRecallInputTests(unittest.TestCase):
    def setUp(self):
        self.sent=[]
        def opened(request,timeout):
            self.sent.append(json.loads(request.data))
            return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(
                {'verdict':'correct','feedback':'Synthetic protocol reply.','matched_points':[],'missed_points':[]})}}]}).encode())
        self.provider=LegacyLearningProvider(LegacyModelPorts(key=lambda:'synthetic-key',model=lambda default:'selected',
            default_model=lambda:'selected',open=opened,validate=lambda *args:{}))

    def test_long_prompt_reference_review_points_and_original_answer_are_not_silently_clipped(self):
        prompt='Question context '*30+'TASK_TAIL'
        reference='来源解释。'*400+'REFERENCE_TAIL'
        points='Review point '*100+'POINT_TAIL'
        answer='  '+('Learner reasoning '*120)+'ANSWER_TAIL  '
        result=self.provider.grade_recall_deepseek({'prompt':prompt,'explanation':reference,'reviewPoint':points},answer)
        self.assertEqual(result['source'],'ai')
        content=self.sent[0]['messages'][1]['content']
        for original in (prompt,reference,points,answer):self.assertIn(original,content)

    def test_unicode_input_over_request_byte_limit_is_refused_before_any_transport(self):
        with self.assertRaisesRegex(RuntimeError,'完整|过长|上限'):
            self.provider.grade_recall_deepseek({'prompt':'Explain the source.','explanation':'Reliable reference.'},'中'*25000)
        self.assertFalse(self.sent)

    def test_long_answer_suffix_remains_present_even_when_prefix_matches_a_prior_answer(self):
        prefix='An incomplete common prefix. '*80
        for tail in ('FIRST_DIFFERENT_RESULT','SECOND_DIFFERENT_RESULT'):
            self.provider.grade_recall_deepseek({'prompt':'Explain the distinction.','answer':'Reliable reference.'},prefix+tail)
        self.assertIn('FIRST_DIFFERENT_RESULT',self.sent[0]['messages'][1]['content'])
        self.assertIn('SECOND_DIFFERENT_RESULT',self.sent[1]['messages'][1]['content'])
        self.assertNotEqual(self.sent[0]['messages'][1]['content'],self.sent[1]['messages'][1]['content'])
