import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from symbolic_math import compare_expressions
from calculation_grade import grade_calculation_reference
from calculation_support import parse_calculation_support
from practice_engine import grade_answer,variant_for

class SymbolicMathTests(unittest.TestCase):
    def test_precision_and_zero_powers(self):
        support={'schemaVersion':1,'type':'calculation','mode':'numeric','domain':'real','variables':[],'tolerance':'0'}
        self.assertFalse(grade_calculation_reference({'answer':'9007199254740992','learningSupport':support},'9007199254740993')['correct'])
        self.assertIsNone(grade_calculation_reference({'answer':'1e-999','learningSupport':support},'0')['correct'])
        for expression in ('0^0','x^0','(x-x)^0','x^-+2'):self.assertIsNone(compare_expressions(expression,'1',['x'])['correct'])
    def test_proven_equal_and_unequal(self):
        for a,b in [('(x+1)^2','x^2+2*x+1'),('sin(2*x)','2*sin(x)*cos(x)'),('1/sqrt(2)','sqrt(2)/2'),('-x^2','-(x*x)')]:self.assertEqual(compare_expressions(a,b,['x'])['verdict'],'correct')
        self.assertEqual(compare_expressions('x+1','x+2',['x'])['verdict'],'wrong')
    def test_unsupported_or_malicious_unknown(self):
        for a,b in [('x/x','1'),('sqrt(x)^2','x'),('sin(x)^2+cos(x)^2','1'),('__import__("os")','1'),('x'*600,'x'),('(x+1)^999999','1'),('1/0','0')]:self.assertEqual(compare_expressions(a,b,['x'])['verdict'],'unknown')
    def test_real_process_and_frozen_variant(self):
        item={'questionType':'calculation','prompt':'Expand','answer':'(x+1)^2','learningSupport':{'schemaVersion':1,'type':'calculation','mode':'symbolic','domain':'real','variables':['x']}}
        self.assertTrue(grade_answer(item,'x^2+2*x+1')['correct'])
        self.assertEqual(variant_for(item,3),item)
        self.assertIsNone(grade_answer(item,'x/x')['correct'])
    def test_decimal_metadata_and_finite_numeric(self):
        support={'schemaVersion':1,'type':'calculation','mode':'numeric','domain':'real','variables':[],'tolerance':'0.000001'}
        self.assertEqual(parse_calculation_support(support),support)
        with self.assertRaises(ValueError):parse_calculation_support({**support,'tolerance':0.1})
        for answer in ('NaN','Infinity','0x10'):
            self.assertIsNone(grade_calculation_reference({'answer':'16','learningSupport':support},answer)['correct'])
