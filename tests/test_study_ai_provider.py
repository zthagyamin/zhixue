import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import study_ai_provider as ai
class ProviderTests(unittest.TestCase):
 def test_body_and_redirect_policy(self):
  for provider in ['chatgpt','deepseek']:
   request=ai.build_request({'provider':provider,'model':'chosen','baseUrl':ai.DEFAULT_BASES[provider]},'synthetic-key',{'messages':[],'thinking':{'type':'disabled'},'max_tokens':99})
   body=json.loads(request.data);self.assertEqual(body['model'],'chosen');self.assertEqual('thinking' in body,provider=='deepseek');self.assertEqual(body.get('max_completion_tokens'),99 if provider=='chatgpt' else None)
  for url in ['https://key@host/v1','https://host/?key=x','http://evil.test/v1','https://host/#x']:
   with self.assertRaises(ValueError):ai.endpoint(url)
  self.assertEqual(ai.endpoint('http://127.0.0.1:11434/v1'),'http://127.0.0.1:11434/v1/chat/completions')
  with self.assertRaises(Exception):ai.NoRedirect().redirect_request(None,None,302,'',{},'https://other')
 def test_owner_library_revision_keyring_and_provider_switch(self):
  db=sqlite3.connect(':memory:');secrets={};keyring=Mock();keyring.get_password.side_effect=lambda service,name:secrets.get(name);keyring.set_password.side_effect=lambda service,name,key:secrets.__setitem__(name,key)
  store=ai.SettingsStore(db,keyring,'test',{'deepseek_model':'legacy-model'},lambda owner:'legacy-key' if owner=='one' else None)
  initial=store.get('one','lib');self.assertTrue(initial['configured']);self.assertEqual(initial['model'],'legacy-model')
  request={'provider':'chatgpt','model':'selected','baseUrl':ai.DEFAULT_BASES['chatgpt'],'enabled':True,'confirmCosts':True,'expectedRevision':0,'providerKey':'synthetic-openai-key'}
  settings=store.configure('one','lib',request)['settings'];self.assertEqual(store.key('one','lib'),'synthetic-openai-key');self.assertNotIn('synthetic',json.dumps(settings));self.assertNotIn('synthetic',str(db.execute('select config from study_ai_settings').fetchall()))
  self.assertEqual(store.configure('one','lib',request)['status'],'stale');self.assertFalse(store.get('two','lib')['configured']);self.assertEqual(store.get('one','other')['provider'],'deepseek')
  store.configure('one','lib',{'provider':'deepseek','expectedRevision':1,'enabled':True,'confirmCosts':True});self.assertEqual(store.key('one','lib'),'legacy-key')
 def test_every_legacy_helper_uses_selected_provider_transport(self):
  import ast,types,urllib.request,urllib.error,time,re
  from typing import Any
  from unittest.mock import patch
  names={'_legacy_ai','suggestion_ai','reorder_plan_with_deepseek','get_hint_deepseek','grade_recall_deepseek','correct_card_deepseek','call_deepseek','open_deepseek'}
  tree=ast.parse((Path(__file__).resolve().parents[1]/'companion/server.py').read_text(encoding='utf-8'))
  ns={'json':json,'Any':Any,'re':re,'urllib':urllib,'time':time,'CONFIG':{'deepseek_model':'old-deepseek'},'CURRENT_MODEL_DEFAULT':'old-deepseek','DEEPSEEK_RETRY_ATTEMPTS':2,'DEEPSEEK_RETRY_DELAY_SECONDS':0,'DeepSeekUnavailableError':RuntimeError,'deepseek_key':lambda:'synthetic-selected-key','ai_settings':lambda:{'provider':'chatgpt','model':'chosen-openai','baseUrl':ai.DEFAULT_BASES['chatgpt']},'study_ai_provider':ai}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'provider-helpers','exec'),ns)
  cases=[('suggestion_ai',([],)),('reorder_plan_with_deepseek',([{'itemKey':'one','kind':'study','estimatedMinutes':1,'reasons':[]}],)),('get_hint_deepseek',({'prompt':'question'},'wrong')),('grade_recall_deepseek',({'prompt':'question'},'answer')),('correct_card_deepseek',({'front':'question'},'instruction')),('call_deepseek',('material','','title','scope'))]
  for name,args in cases:
   seen=[]
   def deny_after_inspection(request,timeout):
    self.assertEqual(request.full_url,'https://api.openai.com/v1/chat/completions');body=json.loads(request.data);self.assertEqual(body['model'],'chosen-openai');self.assertNotIn('thinking',body);self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-selected-key');seen.append(True);raise RuntimeError('synthetic-network-denied')
   with patch.object(ai,'open_request',side_effect=deny_after_inspection),patch('urllib.request.urlopen',side_effect=AssertionError('external-urlopen-denied')),patch('urllib.request.build_opener',side_effect=AssertionError('external-opener-denied')):
    with self.assertRaises(Exception):ns[name](*args)
   self.assertEqual(seen,[True],name)
 def test_stream_ignores_hidden_reasoning_and_closes_response(self):
  import io
  from unittest.mock import patch
  settings={'provider':'chatgpt','model':'chosen','baseUrl':ai.DEFAULT_BASES['chatgpt'],'revision':1,'maxOutputTokens':500}
  request={'provider':'chatgpt','model':'chosen','settingsRevision':1,'context':{'id':'q','title':'Question'},'messages':[{'role':'user','content':'Hint'}]}
  data=('data: '+json.dumps({'choices':[{'delta':{'reasoning_content':'hidden','content':'你好'}}]})+'\n\n'+'data: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n').encode()
  stream=io.BytesIO(data)
  with patch.object(ai,'open_request',return_value=stream),patch('urllib.request.urlopen',side_effect=AssertionError('external-urlopen-denied')),patch('urllib.request.build_opener',side_effect=AssertionError('external-opener-denied')):events=list(ai.stream_chat(settings,'synthetic-key',request))
  self.assertEqual(events[0],{'type':'delta','text':'你好'});self.assertEqual(events[-1]['type'],'done');self.assertNotIn('hidden',json.dumps(events));self.assertTrue(stream.closed)
if __name__=='__main__':unittest.main()
