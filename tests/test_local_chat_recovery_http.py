import json
import sys
import threading
import types
import unittest
import urllib.request
import urllib.error
from dataclasses import replace
from http.server import ThreadingHTTPServer
from unittest import mock
import test_companion as fixtures
from local_chat_transport_fixture import inline_chat_transport
server=fixtures.server
class LocalChatRecoveryHTTP(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.CompanionSyncTests();self.fixture.setUp()
  bind=server.route_services
  patch=mock.patch.object(server,'route_services',side_effect=lambda:replace(bind(),local_chat_transport=inline_chat_transport))
  patch.start();self.addCleanup(patch.stop)
 def tearDown(self):self.fixture.tearDown()
 def test_same_chat_request_is_replayed_without_repeated_provider_send(self):
  origin='https://local-ai-fixture.example';server.CONFIG['allowed_origins']=[origin]
  library=server.local_vault_library_id(self.fixture.vault);secrets={};fake=types.SimpleNamespace(get_password=lambda service,name:secrets.get(name),set_password=lambda service,name,key:secrets.__setitem__(name,key))
  httpd=ThreadingHTTPServer(('127.0.0.1',0),server.Handler);thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start();base='http://127.0.0.1:'+str(httpd.server_port)
  local_opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  def local_only(req,*args,**kwargs):
   url=req.full_url if isinstance(req,urllib.request.Request) else req
   if not url.startswith(base+'/'):raise AssertionError('external-urlopen-denied')
   return local_opener.open(req,*args,**kwargs)
  def post(action,body,session='synthetic-session'):
   req=urllib.request.Request(base+'/v1/ai/'+action,data=json.dumps({'libraryId':library,**body}).encode(),headers={'Origin':origin,'Content-Type':'application/json','X-Study-Loop-Session':session},method='POST')
   with urllib.request.urlopen(req,timeout=5) as r:return r.status,r.headers,r.read().decode()
  self.model_calls=0
  def fake_stream(settings,key,request):
   self.model_calls+=1
   self.assertEqual(settings['provider'],'chatgpt');self.assertEqual(key,'synthetic-openai-key');yield {'type':'delta','text':'fixture answer'};yield {'type':'done','model':'configured-fixture-model','provider':'chatgpt'}
  try:
   with mock.patch.dict(sys.modules,{'keyring':fake}),mock.patch.object(server,'authenticate_session',side_effect=lambda token:'owner-one' if token=='synthetic-session' else None),mock.patch('urllib.request.urlopen',side_effect=local_only),mock.patch('urllib.request.build_opener',side_effect=AssertionError('external-opener-denied')),mock.patch.object(server.study_ai_provider,'stream_chat',side_effect=fake_stream):
    with self.assertRaises(urllib.error.HTTPError) as denied:post('settings',{},'wrong')
    self.assertEqual(denied.exception.code,401)
    status,_,raw=post('settings',{});self.assertEqual(status,200);self.assertNotIn('synthetic-openai-key',raw)
    status,_,raw=post('configure',{'settings':{'provider':'chatgpt','model':'configured-fixture-model','baseUrl':'https://api.openai.com/v1','enabled':True,'confirmCosts':True,'providerKey':'synthetic-openai-key','expectedRevision':0}});self.assertEqual(status,200);self.assertNotIn('synthetic-openai-key',raw)
    for duplicate in range(11):
     status,headers,raw=post('chat',{'request':{'requestId':'same-logical-chat','provider':'chatgpt','model':'configured-fixture-model','settingsRevision':1,'context':{'id':'q','title':'Question'},'messages':[{'role':'user','content':'Hint'}]}});self.assertEqual(status,200);self.assertIn('text/event-stream',headers['Content-Type']);self.assertIn('fixture answer',raw);self.assertIn('done',raw)
    self.assertEqual(self.model_calls,1,'Same logical chat must not issue paid calls again')
    with self.assertRaises(urllib.error.HTTPError) as changed:post('settings',{'libraryId':'another'})
    self.assertEqual(changed.exception.code,409)
  finally:httpd.shutdown();thread.join(3);httpd.server_close()
if __name__=='__main__':unittest.main()
