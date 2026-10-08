"""Provider transport exercised in isolation from startup and local secrets."""
import ast
import json
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import plan_suggestions

tree = ast.parse((Path(__file__).resolve().parents[1] / 'companion/server.py').read_text(encoding='utf-8-sig'))
function = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'suggestion_ai'), None)


class ProviderTests(unittest.TestCase):
    def namespace(self, key):
        self.assertIsNotNone(function, 'Suggestion provider must exist')
        namespace = {'json': json, 'urllib': urllib, 'CONFIG': {}, 'plan_suggestions': plan_suggestions,
            'deepseek_key': lambda: key, 'open_deepseek': Mock()}
        exec(compile(ast.Module(body=[function, next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_legacy_ai')], type_ignores=[]), 'server.py', 'exec'), namespace)
        return namespace

    def test_missing_key_has_explicit_safe_fallback_and_no_transport(self):
        namespace = self.namespace(None)
        with self.assertRaises(plan_suggestions.MissingPlanningKey):
            namespace['suggestion_ai']([])
        namespace['open_deepseek'].assert_not_called()

    def test_transport_reuses_bounded_retry_wrapper_and_json_response(self):
        namespace = self.namespace('fixture-key-not-a-credential')
        answer = {'choices': [{'ref': '1', 'count': 1}]}
        reply = Mock()
        reply.read.return_value = json.dumps({'choices': [{'message': {'content': json.dumps(answer)}}]}).encode()
        wrapper = Mock()
        wrapper.__enter__ = Mock(return_value=reply)
        wrapper.__exit__ = Mock(return_value=False)
        namespace['open_deepseek'].return_value = wrapper
        messages = [{'role': 'user', 'content': 'fixture bounded catalog'}]
        self.assertEqual(namespace['suggestion_ai'](messages), answer)
        request = namespace['open_deepseek'].call_args.args[0]
        self.assertEqual(json.loads(request.data)['messages'], messages)
        self.assertLessEqual(namespace['open_deepseek'].call_args.kwargs['timeout'], 20)
