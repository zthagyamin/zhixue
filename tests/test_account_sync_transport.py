import io
import json
import sys
import unittest
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from account_sync_worker import HttpTransport, CloudFailure, _NoRedirect

ORIGIN = 'https://study.example.test'
SECRET = 'x' * 43


class Response(io.BytesIO):
    def __init__(self, url, payload, content_type='application/json'):
        super().__init__(payload); self.url = url; self.status = 200
        self.headers = Message(); self.headers['Content-Type'] = content_type
    def geturl(self): return self.url


class Opener:
    def __init__(self, action): self.action = action; self.calls = []
    def open(self, request, *, timeout):
        self.calls.append((request, timeout)); return self.action(request)


class AccountSyncTransportTests(unittest.TestCase):
    def test_fixed_endpoint_bounded_timeout_and_no_secret_in_url_or_json(self):
        opener = Opener(lambda req: Response(req.full_url, b'{"accepted":true}'))
        transport = HttpTransport([ORIGIN], opener=opener)
        transport.request('POST', ORIGIN, SECRET, 'begin-snapshot', payload={'snapshot': {'id': 'synthetic'}})
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, ORIGIN + '/api/account-study')
        self.assertEqual(timeout, 15); self.assertEqual(request.get_header('Authorization'), 'Bearer ' + SECRET)
        self.assertNotIn(SECRET, request.full_url); self.assertNotIn(SECRET.encode(), request.data)
        self.assertEqual(json.loads(request.data)['action'], 'begin-snapshot')
        with self.assertRaises(ValueError): transport.request('GET', 'https://other.example.test', SECRET, 'grant-info')
        with self.assertRaises(ValueError): transport.request('GET', ORIGIN, SECRET, 'grant-info', params={'url': 'https://other.example.test'})
        self.assertEqual(len(opener.calls), 1)

    def test_redirects_are_not_followed_with_machine_authorization(self):
        handler = next(h for h in HttpTransport([ORIGIN]).opener.handlers if isinstance(h, _NoRedirect))
        self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://other.example.test'))
        opener = Opener(lambda req: Response('https://other.example.test', b'{}'))
        with self.assertRaises(CloudFailure): HttpTransport([ORIGIN], opener=opener).request('GET', ORIGIN, SECRET, 'grant-info')

    def test_invalid_json_oversize_wrong_content_type_are_rejected(self):
        for payload in (b'{"a":1,"a":2}', b'{"number":NaN}', b'[]', b'\xff', b'x' * 2200001):
            opener = Opener(lambda req: Response(req.full_url, payload))
            with self.assertRaises(ValueError): HttpTransport([ORIGIN], opener=opener).request('GET', ORIGIN, SECRET, 'grant-info')
        opener = Opener(lambda req: Response(req.full_url, b'{}', 'text/html'))
        with self.assertRaises(ValueError): HttpTransport([ORIGIN], opener=opener).request('GET', ORIGIN, SECRET, 'grant-info')

    def test_error_payload_does_not_echo_remote_paths_or_credentials(self):
        def denied(req):
            raise HTTPError(req.full_url, 401, 'private detail', Message(), io.BytesIO(b'{"error":"a secret / path"}'))
        with self.assertRaises(CloudFailure) as raised:
            HttpTransport([ORIGIN], opener=Opener(denied)).request('GET', ORIGIN, SECRET, 'grant-info')
        self.assertEqual(str(raised.exception), 'account-cloud-error')
        self.assertEqual(raised.exception.status, 401)
        def offline(req): raise URLError('secret ' + SECRET)
        with self.assertRaises(OSError) as raised:
            HttpTransport([ORIGIN], opener=Opener(offline)).request('GET', ORIGIN, SECRET, 'grant-info')
        self.assertNotIn(SECRET, str(raised.exception))


if __name__ == '__main__': unittest.main()
