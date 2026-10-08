import ast
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

# Execute the production function without importing server startup/config side effects.
tree = ast.parse((Path(__file__).resolve().parents[1] / 'companion/server.py').read_text(encoding='utf-8-sig'))
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'reorder_plan_with_deepseek')
namespace = {'json': json, 'CONFIG': {}, 'deepseek_key': lambda: 'test-key-not-a-credential', 'open_deepseek': lambda request,timeout: __import__('urllib.request',fromlist=['urlopen']).urlopen(request,timeout=timeout)}
exec(compile(ast.Module(body=[function, next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_legacy_ai')], type_ignores=[]), 'server.py', 'exec'), namespace)
reorder = namespace['reorder_plan_with_deepseek']

class ReorderTests(unittest.TestCase):
    def test_duplicate_unknown_and_missing_keys_preserve_input_multiplicity(self):
        items=[{'itemKey':k,'kind':'study','estimatedMinutes':2,'reasons':[]} for k in ['a','b','c']]
        response = types.SimpleNamespace(read=lambda: json.dumps({'choices':[{'message':{'content':json.dumps({'order':['b','b','unknown','a']})}}]}).encode())
        class Response:
            def __enter__(self): return response
            def __exit__(self,*args): pass
        with patch('urllib.request.urlopen',return_value=Response()):
            result=reorder(items)
        self.assertEqual([i['itemKey'] for i in result],['b','a','c'])
        self.assertEqual(items[0]['itemKey'],'a')

    def test_missing_key_has_actionable_error_without_network(self):
        with patch.dict(namespace,{'deepseek_key':lambda:None}), patch('urllib.request.urlopen',side_effect=AssertionError('must not call network')):
            with self.assertRaisesRegex(RuntimeError,'AI'):
                reorder([{'itemKey':'a'}])
