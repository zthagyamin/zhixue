"""Deterministic synthetic interleavings: no HTTP server or provider network is used."""
import io
import json
import sqlite3
import sys
import threading
import types
import unittest
from contextlib import contextmanager
from unittest import mock
import test_companion as fixtures
server=fixtures.server
ai=server.study_ai_provider
class ProviderRaceTests(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.CompanionSyncTests();self.fixture.setUp()
  self.secrets={};self.keyring=types.SimpleNamespace(get_password=lambda service,name:self.secrets.get(name),set_password=lambda service,name,key:self.secrets.__setitem__(name,key))
 def tearDown(self):self.fixture.tearDown()
 def test_snapshot_never_combines_old_provider_with_new_provider_key(self):
  db=sqlite3.connect(':memory:');self.addCleanup(db.close)
  store=ai.SettingsStore(db,self.keyring,'test',{'deepseek_model':'legacy'},lambda owner:None)
  base={'enabled':True,'confirmCosts':True,'expectedRevision':0,'providerKey':'synthetic-deepseek-key','provider':'deepseek','model':'old-model'}
  store.configure('owner','library',base);raw=store.raw;changed=False
  def interleave(owner,library):
   nonlocal changed
   selected=raw(owner,library)
   if not changed:
    changed=True;store.configure(owner,library,{**base,'provider':'chatgpt','model':'new-model','providerKey':'synthetic-openai-key','expectedRevision':1})
   return selected
  store.raw=interleave
  with mock.patch('urllib.request.urlopen',side_effect=AssertionError('network-denied')),mock.patch('urllib.request.build_opener',side_effect=AssertionError('network-denied')):
   settings,key=store.snapshot('owner','library')
   request=ai.build_request(settings,key,{'messages':[]})
  self.assertEqual(settings['provider'],'deepseek');self.assertEqual(settings['revision'],1)
  self.assertEqual(request.full_url,'https://api.deepseek.com/chat/completions');self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-deepseek-key')
 def test_configure_holds_shared_lock_through_commit_and_replies_after_commit(self):
  owner='owner';library='library';origin='https://fixture.example';server.CONFIG['allowed_origins']=[origin]
  reached_commit=threading.Event();release_commit=threading.Event();responses=[];errors=[];real_database=server.local_database
  @contextmanager
  def transaction():
   with real_database() as database:
    yield database
    reached_commit.set()
    if not release_commit.wait(3):raise AssertionError('commit-barrier-timeout')
  value={'libraryId':library,'settings':{'provider':'chatgpt','model':'synthetic-model','baseUrl':ai.DEFAULT_BASES['chatgpt'],'providerKey':'synthetic-openai-key','enabled':True,'confirmCosts':True,'expectedRevision':0}}
  encoded=json.dumps(value).encode();handler=object.__new__(server.Handler);handler.path='/v1/ai/configure';handler.headers={'Origin':origin,'Content-Length':str(len(encoded)),'X-Study-Loop-Session':'synthetic-session'};handler.rfile=io.BytesIO(encoded);handler.send_json=lambda status,body:responses.append((status,body))
  def configure():
   try:handler.do_POST()
   except BaseException as error:errors.append(error)
  with mock.patch.dict(sys.modules,{'keyring':self.keyring}),mock.patch.object(server,'authenticate_session',return_value=owner),mock.patch.object(server,'local_vault_library_id',return_value=library),mock.patch.object(server,'local_database',transaction),mock.patch('urllib.request.urlopen',side_effect=AssertionError('network-denied')),mock.patch('urllib.request.build_opener',side_effect=AssertionError('network-denied')):
   worker=threading.Thread(target=configure);worker.start()
   try:
    self.assertTrue(reached_commit.wait(3));acquired=ai.SETTINGS_LOCK.acquire(blocking=False)
    if acquired:ai.SETTINGS_LOCK.release()
    self.assertFalse(acquired,'configuration commit must still own SETTINGS_LOCK');self.assertEqual(responses,[],'accepted response must follow commit')
   finally:release_commit.set();worker.join(3)
  self.assertFalse(worker.is_alive());self.assertEqual(errors,[]);self.assertEqual(responses[0][0],200)
  with real_database() as database:
   settings=ai.SettingsStore(database,self.keyring,'StudyLoopCompanion',server.CONFIG,lambda owner:None).get(owner,library)
   self.assertEqual(settings['revision'],1);self.assertEqual(settings['provider'],'chatgpt')
 def test_legacy_key_setter_uses_same_snapshot_lock(self):
  entered=threading.Event();release=threading.Event();errors=[]
  def save(service,name,key):
   entered.set()
   if not release.wait(3):raise AssertionError('key-barrier-timeout')
  fake=types.SimpleNamespace(set_password=save)
  def call():
   try:server.save_deepseek_key('synthetic-legacy-key','owner')
   except BaseException as error:errors.append(error)
  with mock.patch.dict(sys.modules,{'keyring':fake}):
   worker=threading.Thread(target=call);worker.start()
   try:
    self.assertTrue(entered.wait(3));acquired=ai.SETTINGS_LOCK.acquire(blocking=False)
    if acquired:ai.SETTINGS_LOCK.release()
    self.assertFalse(acquired,'legacy credential mutation must join the snapshot lock')
   finally:release.set();worker.join(3)
  self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
if __name__=='__main__':unittest.main()
