import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import study_ai_provider as api

class StudyAIModelSelectionTests(unittest.TestCase):
    def test_model_ids_only_and_no_credential_echo(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'data': [{'id': 'model-one', 'secret': 'never-return'}, {'id': 'bad\nname'}]}).encode()
        with mock.patch.object(api, 'open_request', return_value=response):
            self.assertEqual(api.fetch_models({'provider': 'chatgpt', 'baseUrl': 'https://api.openai.com/v1', 'key': 'synthetic-key'}), ['model-one'])

    def test_existing_key_cannot_be_sent_to_an_unconfirmed_draft_address(self):
        store = types.SimpleNamespace(raw=lambda owner, library: ({'providers': {'chatgpt': {'baseUrl': 'https://api.openai.com/v1'}}}, 3), key_for=lambda *args: 'synthetic-key')
        with self.assertRaisesRegex(ValueError, 'ai-model-list-key-required'):
            api.resolve_model_selection(store, 'owner', 'library', {'provider': 'chatgpt', 'baseUrl': 'https://different.example/v1', 'expectedRevision': 3})
        with self.assertRaisesRegex(ValueError, 'ai-settings-stale'):
            api.resolve_model_selection(store, 'owner', 'library', {'provider': 'chatgpt', 'baseUrl': 'https://api.openai.com/v1', 'expectedRevision': 2})

if __name__ == '__main__':
    unittest.main()
