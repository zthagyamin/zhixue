import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest import mock
import test_gateway_server as fixtures
import assistance_schema as schema


class AssistanceServiceTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.GatewayServerTests();self.f.setUp();self.addCleanup(self.f.tearDown)
        self.method=getattr(fixtures.server,'accept_assistance_payload',None);self.assertIsNotNone(self.method)
        self.payload=self.f.payload();item=fixtures.index_gateway.load_gateway(self.f.vault)['subjects'][0]['items'][0]
        self.binding=dict(schemaVersion=1,eventId=self.payload['event']['eventId'],coreHash=self.payload['event']['coreHash'],contentHash=item['contentHash'],localBindingHash=item['localBindingHash'],practiceMode='quiz')
        self.payload['attemptBinding']=self.binding
        self.summary=schema.seal_summary(dict(schemaVersion=1,attemptEventId=self.binding['eventId'],attemptCoreHash=self.binding['coreHash'],practiceMode='quiz',observationScope='current-page-attempt',preSubmitAssistance=[],postSubmitFeedback=[dict(action='ai-hint',count=1)]))
        self.record=schema.seal_native_assistance(self.binding,self.summary)

    def test_paired_native_receive_writes_independent_evidence_without_regrading(self):
        self.f.accept(self.payload)
        result=self.method('account',{'record':self.record});self.assertTrue(result['durable']);self.assertEqual(result['receipt']['receipt']['status'],'applied')
        second=self.method('account',{'record':self.record});self.assertEqual(second['status'],'duplicate');self.assertEqual(second['receipt'],result['receipt'])
        files=list((self.f.vault/self.f.root/'records/assistance').rglob('*.json'));self.assertEqual(len(files),1)
        with fixtures.server.local_database() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM study_events_v3').fetchone()[0],1)
        with self.assertRaisesRegex(ValueError,'parent'):self.method('different',{'record':self.record})

    def test_old_native_attempt_stays_auxiliary_unknown_and_original_record_is_preserved(self):
        self.payload.pop('attemptBinding');self.f.accept(self.payload)
        result=self.method('account',{'record':self.record});self.assertEqual(result['receipt']['receipt']['status'],'blocked');self.assertEqual(result['receipt']['receipt']['reason'],'baseline-unverified')
        self.assertFalse((self.f.vault/self.f.root/'records/assistance').exists())

    def test_summary_arriving_before_original_attempt_stays_explicitly_pending(self):
        with self.assertRaisesRegex(ValueError,'assistance-parent-pending'):
            self.method('account',{'record':self.record})
        self.assertFalse((self.f.vault/self.f.root/'records/assistance').exists())

    def test_native_background_resume_uses_the_paired_owner_without_an_open_browser(self):
        self.f.accept(self.payload);blocker=self.f.vault/self.f.root/'records/assistance';blocker.write_text('Temporary file obstruction',encoding='utf-8')
        result=self.method('account',{'record':self.record});self.assertEqual(result['receipt']['receipt']['status'],'blocked')
        blocker.unlink()
        with mock.patch.object(fixtures.server.account_sync_service,'_installation_identity',return_value=('different',b'x'*32)):
            fixtures.server.resume_native_assistance_once()
        self.assertFalse(blocker.exists())
        with mock.patch.object(fixtures.server.account_sync_service,'_installation_identity',return_value=('account',b'x'*32)):
            fixtures.server.resume_native_assistance_once()
        resumed=self.method('account',{'record':self.record});self.assertEqual(resumed['receipt']['receipt']['status'],'applied')
        self.assertEqual(len(list(blocker.rglob('*.json'))),1)

    def test_new_native_endpoint_requires_session_and_allowed_origin(self):
        self.f.accept(self.payload);httpd=ThreadingHTTPServer(('127.0.0.1',0),fixtures.server.Handler);thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(httpd.shutdown(),httpd.server_close(),thread.join(3)))
        url=f'http://127.0.0.1:{httpd.server_port}/v1/assistance'
        def request(origin,token):return urllib.request.Request(url,data=json.dumps({'record':self.record}).encode(),headers={'Content-Type':'application/json','Origin':origin,'X-Study-Loop-Session':token})
        observed_statuses=[];original_send=fixtures.server.Handler.send_json
        def observe_send(handler,status,*args,**kwargs):
            observed_statuses.append(status)
            return original_send(handler,status,*args,**kwargs)
        with mock.patch.object(fixtures.server.Handler,'send_json',new=observe_send),mock.patch.object(fixtures.server,'allowed_origin',side_effect=lambda origin:origin=='https://isolated.example.test'),mock.patch.object(fixtures.server,'authenticate_session',side_effect=lambda token:'account' if token=='synthetic-session' else None):
            for origin,token,code in [('https://other.example.test','synthetic-session',403),('https://isolated.example.test','wrong',401)]:
                with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(request(origin,token),timeout=5)
                self.assertEqual(caught.exception.code,code,f'Expected local endpoint response; observed handler statuses: {observed_statuses}')
                caught.exception.close()
            with urllib.request.urlopen(request('https://isolated.example.test','synthetic-session'),timeout=5) as response:
                self.assertEqual(response.status,200);self.assertEqual(json.loads(response.read())['receipt']['receipt']['status'],'applied')
