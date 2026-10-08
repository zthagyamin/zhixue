import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from learning_support import parse_learning_support
from account_sync_schema import seal_item,validate_item

class LearningSupportTests(unittest.TestCase):
    def setUp(self):
        self.support={'schemaVersion':1,'type':'recall','criteria':[{'id':'mechanism','text':'Explain the mechanism','weight':2,'mandatory':True}],'hints':['Direction','Structure','Reference']}
        self.item={'schemaVersion':2,'kind':'practice','itemKey':'question-one','eventKind':'due','subjectId':'reading','title':'Reading','sourceHash':'a'*64,'completionRule':'graded-practice','learningSupport':self.support,'practice':{'itemId':'question-one','abilityId':'reading-main','domain':'course','questionType':'recall','prompt':'Explain.','answer':'Reference','sourceLabel':'Reading'}}
    def test_support_and_content_roundtrip(self):
        self.assertEqual(parse_learning_support(self.support,'recall'),self.support)
        sealed=seal_item(self.item);self.assertEqual(validate_item(sealed),sealed)
        old=copy.deepcopy(self.item);old['schemaVersion']=1;del old['learningSupport'];self.assertEqual(validate_item(seal_item(old)),seal_item(old))
    def test_wrong_type_unknown_fields_and_bad_weights(self):
        for altered in ({**self.support,'type':'quiz'},{**self.support,'extra':True},{**self.support,'hints':['one']},{**self.support,'criteria':[{'id':'x','text':'x','weight':True}]}):
            with self.assertRaises(ValueError):parse_learning_support(altered,'recall')
        self.item['schemaVersion']=1
        with self.assertRaises(ValueError):seal_item(self.item)
    def test_source_table_preserves_explicit_learning_configuration(self):
        import json,index_gateway
        text='| ID | 题干 | 参考答案 | 学习配置 |\n|---|---|---|---|\n| q | Explain. | Reference | '+json.dumps(self.support)+' |\n'
        rows=index_gateway._table_items(text,'recall',{'identity':'legacy'},'source')
        self.assertEqual(rows[0]['learningSupport'],self.support)
    def test_ai_alignment_survives_double_normalization_and_rejects_unknown_ids(self):
        import practice_engine
        item={'questionType':'recall','learningSupport':self.support}
        payload={'verdict':'correct','matchedPointIds':['mechanism'],'missedPointIds':[]}
        result=practice_engine.grade_answer(item,'answer',recall_grader=lambda *_:practice_engine.normalize_recall_grade(payload,criteria=self.support['criteria']))
        self.assertEqual(result['matchedPointIds'],['mechanism'])
        bad={**payload,'matchedPointIds':['invented']}
        self.assertTrue(practice_engine.grade_answer(item,'answer',recall_grader=lambda *_:bad)['aiFallback'])
    def test_fractional_weight_rejected_before_content_hashing(self):
        self.support['criteria'][0]['weight']=0.5
        with self.assertRaisesRegex(ValueError,'weight'):parse_learning_support(self.support,'recall')
    def test_version_two_summary_matches_typescript_golden(self):
        import json,assistance_schema
        golden=json.loads((Path(__file__).parent/'fixtures/assistance-summary-v2.json').read_text(encoding='utf-8'))
        body={k:v for k,v in golden.items() if k not in ('summaryId','summaryHash')}
        self.assertEqual(assistance_schema.seal_summary(body),golden)
