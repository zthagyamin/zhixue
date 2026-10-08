import importlib.util
import unittest
from pathlib import Path
from urllib.request import Request

path = Path(__file__).parent / 'fixtures/account_writeback_preview.py'
preview = None
if path.exists():
    spec = importlib.util.spec_from_file_location('account_writeback_preview', path)
    preview = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preview)


class AccountWritebackPreviewTests(unittest.TestCase):
    def test_test_transport_cannot_target_nonloopback_or_a_different_logical_origin(self):
        self.assertIsNotNone(preview, 'A bounded test-only real HTTP adapter must exist')
        for origin in ('https://example.org', 'http://192.168.1.2:3017', 'http://127.0.0.1:43121'):
            with self.assertRaises(ValueError): preview.LoopbackOpener(origin)
        opener = preview.LoopbackOpener('http://127.0.0.1:3017')
        for url in ('https://elsewhere.example/api/account-study', 'https://study.example.test/another-path'):
            with self.assertRaises(ValueError): opener.open(Request(url), timeout=1)

    def test_test_transport_keeps_the_original_method_headers_and_body(self):
        self.assertIsNotNone(preview)
        class Reply:
            status = 200
            headers = {}
            def geturl(self): return 'http://127.0.0.1:3017/api/account-study'
            def close(self): pass
        class Recorder:
            request = None
            def open(self, request, timeout): self.request = request; return Reply()
        recorder = Recorder()
        opener = preview.LoopbackOpener('http://127.0.0.1:3017', opener=recorder)
        request = Request('https://study.example.test/api/account-study', data=b'{"action":"activate-grant"}', method='POST', headers={'Authorization':'Bearer synthetic-only'})
        reply = opener.open(request, timeout=1)
        self.assertEqual(reply.geturl(), request.full_url)
        self.assertEqual(recorder.request.full_url, 'http://127.0.0.1:3017/api/account-study')
        self.assertEqual(recorder.request.data, request.data)
        self.assertEqual(recorder.request.get_header('Authorization'), 'Bearer synthetic-only')
