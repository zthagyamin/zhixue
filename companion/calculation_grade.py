import json
from fractions import Fraction
from pathlib import Path
import re
import subprocess
import sys
from learning_support import parse_learning_support

def grade_calculation_reference(item,answer):
    unknown={'correct':None,'verdict':'unknown','explanation':'暂不能可靠判定，原答案保留待核对。'}
    try:
        support=parse_learning_support(item['learningSupport'],'calculation') if 'learningSupport' in item else None
        expected=str(item.get('answer','')).strip();actual=str(answer).strip()
        if not expected or not actual:return unknown
        if support and support['mode']=='symbolic':
            if len(expected)>512 or len(actual)>512:return unknown
            result=subprocess.run([sys.executable,'-I',str(Path(__file__).with_name('symbolic_math.py'))],input=json.dumps({'actual':actual,'expected':expected,'variables':support['variables']}),capture_output=True,text=True,encoding='utf-8',timeout=2,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode or len(result.stdout)>4096:return unknown
            checked=json.loads(result.stdout)
            if support.get('schemaVersion')==2 and support.get('conditions') and checked.get('verdict')=='wrong':
                return {**unknown,'explanation':'当前内核不能核对这些附加条件下的表达式差异，原答案保留待核对。'}
            return checked
        decimal=r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?'
        def read(value):
            if len(value)>128 or not re.fullmatch(decimal,value) or abs(int(value.lower().split('e')[1] if 'e' in value.lower() else '0'))>100:raise ValueError('limit')
            result=Fraction(value)
            if len(str(abs(result.numerator)))>120 or len(str(result.denominator))>120:raise ValueError('limit')
            return result
        left=read(expected);right=read(actual);tolerance=read(support.get('tolerance','0.000001')) if support else Fraction(1,1000000)
        correct=abs(left-right)<=max(1,abs(left))*tolerance
        return {'correct':correct,'verdict':'correct' if correct else 'wrong','explanation':'答案一致。' if correct else '参考答案：'+expected}
    except (ValueError,TypeError,KeyError,OSError,subprocess.TimeoutExpired):return unknown
