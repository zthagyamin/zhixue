"""Actual selected-provider transport, synthetic sockets and responses only."""
import io
import http.client
import json
import socket
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from infrastructure.legacy_transport import LegacyProviderTransport
from infrastructure.legacy_ai import LegacyLearningProvider,LegacyModelPorts

SETTINGS={'provider':'deepseek','model':'selected','baseUrl':'https://api.deepseek.com'}

class LegacyTransportBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.transport=LegacyProviderTransport(settings=lambda:SETTINGS,key=lambda:'synthetic-key',
            attempts=2,delay=0,unavailable=RuntimeError)
        self.request=urllib.request.Request('https://api.deepseek.com/chat/completions',
            data=json.dumps({'messages':[{'role':'user','content':'Synthetic learning input'}]}).encode())

    def test_unknown_delivery_never_automatically_reissues_post_even_if_next_attempt_would_succeed(self):
        for error in (TimeoutError(),ConnectionResetError(),urllib.error.URLError(ConnectionResetError()),OSError('socket reset')):
            with self.subTest(error=type(error).__name__),mock.patch('study_ai_provider.open_request',
                    side_effect=[error,io.BytesIO(b'{}')]) as opener:
                with self.assertRaises(RuntimeError):self.transport.open(self.request,1)
                self.assertEqual(opener.call_count,1)

    def test_confirmed_preconnection_dns_failure_can_retry_without_reissuing_a_delivered_post(self):
        error=urllib.error.URLError(socket.gaierror(socket.EAI_AGAIN,'Synthetic name resolution failure'))
        with mock.patch('study_ai_provider.open_request',side_effect=[error,io.BytesIO(b'{}')]) as opener:
            with self.transport.open(self.request,1) as response:self.assertEqual(response.read(),b'{}')
            self.assertEqual(opener.call_count,2)

    def test_large_response_is_bounded_and_closed_on_read_failure(self):
        raw=io.BytesIO(b'x'*100001)
        with mock.patch('study_ai_provider.open_request',return_value=raw):
            with self.assertRaisesRegex(RuntimeError,'output-limit'):
                with self.transport.open(self.request,1) as response:response.read()
        self.assertTrue(raw.closed)

    def test_repeated_small_reads_cannot_bypass_total_limit(self):
        raw=io.BytesIO(b'x'*100001)
        with mock.patch('study_ai_provider.open_request',return_value=raw):
            with self.assertRaisesRegex(RuntimeError,'output-limit'):
                with self.transport.open(self.request,1) as response:
                    for _ in range(51):response.read(2000)
        self.assertTrue(raw.closed)

    def test_normal_word_and_nonword_response_content_remains_exact_and_model_selection_preserved(self):
        body=json.dumps({'subjects':[{'pluginType':'three-stage','items':[{'word':'learn','meaning':'学习'}]},
                                   {'pluginType':'recall','items':[{'prompt':'Define a stack.'}]}]},ensure_ascii=False).encode()
        request=urllib.request.Request(self.request.full_url,data=json.dumps({'model':'old','max_tokens':5000,'messages':[]}).encode())
        with mock.patch('study_ai_provider.open_request',return_value=io.BytesIO(body)) as opener:
            with self.transport.open(request,1) as response:self.assertEqual(response.read(),body)
        sent=json.loads(opener.call_args.args[0].data)
        self.assertEqual(sent['model'],'selected');self.assertEqual(sent['max_tokens'],5000)

    def test_provider_http_rejection_is_preserved_without_retry(self):
        error=urllib.error.HTTPError('https://api.deepseek.com',429,'Rejected',{},io.BytesIO(b'error'))
        with mock.patch('study_ai_provider.open_request',side_effect=error) as opener:
            with self.assertRaises(urllib.error.HTTPError) as raised:self.transport.open(self.request,1)
            self.assertIs(raised.exception,error);self.assertEqual(opener.call_count,1)
        error.close()

    def test_real_http_response_with_short_declared_body_cannot_become_valid_hint(self):
        body=json.dumps({'choices':[{'message':{'content':'Synthetic valid hint'}}]}).encode()
        class Socket:
            def makefile(self,*args):
                return io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)+10).encode()+b'\r\n\r\n'+body)
        response=http.client.HTTPResponse(Socket());response.begin()
        provider=LegacyLearningProvider(LegacyModelPorts(key=lambda:'synthetic-key',model=lambda default:'selected',
            default_model=lambda:'selected',open=self.transport.open,validate=lambda *args:{}))
        with mock.patch('study_ai_provider.open_request',return_value=response) as opener:
            with self.assertRaises(RuntimeError):provider.get_hint_deepseek({'prompt':'Synthetic question'},'answer')
            self.assertEqual(opener.call_count,1)
        self.assertTrue(response.isclosed())
