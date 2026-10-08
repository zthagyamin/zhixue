"""Actual source HTTP/application boundary with isolated ports, no vault/config reads."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import routes_sources


class SourceApplicationTests(unittest.TestCase):
    def test_null_mapping_write_retains_post_error_classification_and_call_shape(self):
        calls, replies = [], []

        def mapping(*args):
            calls.append(args)
            raise ValueError('stale-mapping')

        services = SimpleNamespace(vault_mapping_request=mapping, allowed_origin=lambda _origin: True)
        handler = SimpleNamespace(headers={'Origin': 'https://synthetic.test'}, send_json=lambda *args: replies.append(args))
        routes_sources.post_vault_mapping(handler, services, '/v1/vault-mapping', 'synthetic', None)
        self.assertEqual(calls, [('synthetic', None)])
        self.assertEqual(replies, [(409, {'message': 'stale-mapping'})])
        calls.clear()
        replies.clear()
        routes_sources.get_vault_mapping(handler, services, '/v1/vault-mapping', 'synthetic')
        self.assertEqual(calls, [('synthetic',)])
        self.assertEqual(replies, [(400, {'message': 'stale-mapping'})])
