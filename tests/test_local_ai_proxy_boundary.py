"""Local provider routing is direct; public provider proxy behavior is preserved."""
import copy
import io
import json
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
import urllib.request
import urllib.response
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import study_ai_provider as ai

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/local-chat-recovery-v1.json').read_text(encoding='utf-8'))


class LocalAIProxyBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.calls = {'provider': 0, 'proxy': 0}
        self.redirect = False
        parent = self
        def create(label):
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    parent.calls[label] += 1
                    if label == 'provider' and parent.redirect:
                        self.send_response(302)
                        self.send_header('Location', 'https://external-fixture.invalid/v1/models')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    self.reply(json.dumps({'data': [{'id': 'model-' + label}]}).encode(), 'application/json')

                def do_POST(self):
                    value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    parent.calls[label] += 1
                    if value.get('stream'):
                        frame = {'choices': [{'delta': {'content': label}, 'finish_reason': 'stop'}]}
                        raw = ('data: ' + json.dumps(frame) + '\n\ndata: [DONE]\n\n').encode()
                        self.reply(raw, 'text/event-stream')
                    else:
                        self.reply(json.dumps({'choices': [{'message': {'content': label},
                            'finish_reason': 'stop'}]}).encode(), 'application/json')

                def reply(self, raw, content_type):
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    self.wfile.flush()
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join, 3)
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            return server
        self.provider = create('provider')
        self.proxy = create('proxy')
        self.base = f'http://127.0.0.1:{self.provider.server_port}/v1'
        proxy = f'http://127.0.0.1:{self.proxy.server_port}'
        self.proxy_config = mock.patch('urllib.request.getproxies', return_value={'http': proxy, 'https': proxy})
        self.bypass_config = mock.patch('urllib.request.proxy_bypass', return_value=False)
        self.proxy_config.start()
        self.bypass_config.start()
        self.addCleanup(self.proxy_config.stop)
        self.addCleanup(self.bypass_config.stop)
        self.settings = {**FIXTURE['settings'], 'baseUrl': self.base}
        self.request = copy.deepcopy(FIXTURE['request'])

    def test_local_stream_visits_selected_provider_without_proxy(self):
        events = list(ai.stream_chat(self.settings, 'synthetic-key', self.request))
        self.assertEqual(events[0]['text'], 'provider')
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(self.calls, {'provider': 1, 'proxy': 0})

    def test_local_nonstream_chat_uses_the_same_direct_route(self):
        self.assertEqual(ai.chat(self.settings, 'synthetic-key', self.request)['text'], 'provider')
        self.assertEqual(self.calls, {'provider': 1, 'proxy': 0})

    def test_local_model_list_does_not_visit_proxy(self):
        self.assertEqual(ai.fetch_models({'baseUrl': self.base, 'key': 'synthetic-key'}), ['model-provider'])
        self.assertEqual(self.calls, {'provider': 1, 'proxy': 0})

    def test_local_redirect_remains_rejected_before_external_access(self):
        self.redirect = True
        with self.assertRaises(urllib.error.HTTPError) as result:
            ai.fetch_models({'baseUrl': self.base, 'key': 'synthetic-key'})
        self.assertEqual(result.exception.code, 302)
        self.assertEqual(self.calls, {'provider': 1, 'proxy': 0})

    def capture_https_route(self, hostname):
        routes = []
        class CaptureHTTPS(urllib.request.HTTPSHandler):
            def __init__(self):
                urllib.request.AbstractHTTPHandler.__init__(self)
            def https_open(self, request):
                routes.append({'host': request.host, 'tunnel': getattr(request, '_tunnel_host', None)})
                response = urllib.response.addinfourl(io.BytesIO(b'synthetic'), Message(), request.full_url, 200)
                response.msg = 'OK'
                return response
        with mock.patch('urllib.request.HTTPSHandler', CaptureHTTPS), \
                mock.patch('http.client.HTTPSConnection.connect', side_effect=AssertionError('External access forbidden')):
            with ai.open_request(urllib.request.Request('https://' + hostname + '/v1/models'), 2) as response:
                self.assertEqual(response.read(), b'synthetic')
        return routes

    def test_only_exact_loopback_hosts_bypass_proxy_including_ipv6_and_case(self):
        for hostname in ('LOCALHOST', '127.0.0.1', '[::1]'):
            with self.subTest(hostname=hostname):
                routes = self.capture_https_route(hostname)
                self.assertEqual(len(routes), 1)
                self.assertIsNone(routes[0]['tunnel'])
                self.assertEqual(routes[0]['host'].lower(), hostname.lower())

    def test_other_hosts_keep_default_proxy_route(self):
        for hostname in ('public-fixture.invalid', 'localhost.example', '127.0.0.1.example', '127.1', '10.0.0.1'):
            with self.subTest(hostname=hostname):
                routes = self.capture_https_route(hostname)
                self.assertEqual(routes, [{'host': f'127.0.0.1:{self.proxy.server_port}', 'tunnel': hostname}])
        self.assertEqual(self.calls, {'provider': 0, 'proxy': 0})


if __name__ == '__main__':
    unittest.main()
