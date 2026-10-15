"""Real owned child process and SQLite; no provider network or system inventory."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from pathlib import Path
from contextlib import closing
import sqlite3
import test_companion
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.chat_executor_lock import ChatExecutorLock
from application.failures import CompanionFailure

FIXTURE=json.loads((Path(__file__).parent/'fixtures/local-chat-recovery-v1.json').read_text(encoding='utf8'))
REQUEST,SETTINGS=(FIXTURE[key] for key in ('request','settings'))
CHILD='''
import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from infrastructure.local_chat_ledger import LocalChatLedger
from application.local_chat import execute_chat
data=json.loads(sys.argv[4])
ledger=LocalChatLedger(sys.argv[2],'owner','library',sys.argv[3],lambda:1000)
ticket=ledger.begin(data['request'],data['settings'])
def provider():
 yield {'type':'delta','text':'reliably saved partial'}
 sys.stdin.readline()
stream=execute_chat(ledger,ticket,provider,lambda:None).events
first=next(stream)
print(json.dumps({'ready':True,'pid':os.getpid(),'first':first}),flush=True)
sys.stdin.readline()
stream.close()
'''

class ExecutorRecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.db=self.root/'synthetic.sqlite'
  self.ledger=LocalChatLedger(self.db,'owner','library',self.root,lambda:1000)
 def child(self):
  # Windows venv redirectors spawn a separate interpreter that holds the lock.
  # Launch the interpreter itself so kill/wait observes the actual lock owner.
  executable=getattr(sys,'_base_executable',sys.executable)
  process=subprocess.Popen([executable,'-I','-u','-c',CHILD,str(Path(__file__).resolve().parents[1]/'companion'),str(self.db),str(self.root),json.dumps({'request':REQUEST,'settings':SETTINGS})],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  def cleanup():
   if process.poll() is None:process.kill();process.wait(5)
   for pipe in (process.stdin,process.stdout,process.stderr):pipe.close()
  self.addCleanup(cleanup)
  line=process.stdout.readline(1000)
  self.assertTrue(line,'Child must actually signal readiness')
  ready=json.loads(line)
  self.assertTrue(ready['ready']);self.assertIsNone(process.poll())
  self.assertEqual(ready['pid'],process.pid,'Termination must target the actual lock-owning interpreter')
  return process
 def different(self):
  result=copy.deepcopy(REQUEST);result['requestId']='another-chat';result['messages'][0]['content']='Different question';return result
 def test_confirmed_child_termination_releases_only_concurrency_and_never_resends_original(self):
  process=self.child();process.kill();process.wait(5);self.assertIsNotNone(process.poll())
  resumed=self.ledger.lookup(REQUEST)
  self.assertEqual(resumed,{'kind':'unknown','text':'reliably saved partial'})
  self.assertEqual(self.ledger.begin(self.different(),SETTINGS)['kind'],'start')
  with closing(sqlite3.connect(self.db)) as db:
   state,reserved=db.execute('SELECT state,reserved FROM study_chat_budget WHERE request_id=?',(REQUEST['requestId'],)).fetchone()
   self.assertEqual(state,'unknown');self.assertGreater(reserved,0)
   self.assertEqual(db.execute('SELECT request,text,result FROM study_chat_requests WHERE request_id=?',(REQUEST['requestId'],)).fetchone()[1:],('reliably saved partial',None))
 def test_live_child_keeps_slot_despite_age_and_another_ledger(self):
  process=self.child()
  another=LocalChatLedger(self.db,'owner','library',self.root,lambda:99999)
  self.assertEqual(another.lookup(REQUEST)['kind'],'unknown')
  with self.assertRaisesRegex(ValueError,'account-ai-concurrency-limit'):another.begin(self.different(),SETTINGS)
  self.assertIsNone(process.poll())
 def test_failed_recovery_transaction_does_not_erase_dispatch_or_original_input(self):
  process=self.child();process.kill();process.wait(5)
  with closing(sqlite3.connect(self.db)) as db:
   before=db.execute('SELECT request,text FROM study_chat_requests').fetchone()
  # A failed new reservation rolls recovery back; the original data remains.
  tiny={**SETTINGS,'dailyTokenLimit':1}
  with self.assertRaisesRegex(ValueError,'account-ai-token-limit'):self.ledger.begin(self.different(),tiny)
  with closing(sqlite3.connect(self.db)) as db:self.assertEqual(db.execute('SELECT request,text FROM study_chat_requests').fetchone(),before)
 def test_two_recoverers_preserve_one_unknown_record_and_one_reservation(self):
  process=self.child();process.kill();process.wait(5);gate=threading.Barrier(2)
  def recover():
   gate.wait(3)
   return LocalChatLedger(self.db,'owner','library',self.root,lambda:1000).lookup(REQUEST)
  with ThreadPoolExecutor(max_workers=2) as pool:
   futures=[pool.submit(recover) for _ in range(2)]
   self.assertTrue(all(f.result(5)['kind']=='unknown' for f in futures))
  with closing(sqlite3.connect(self.db)) as db:
   self.assertEqual(db.execute('SELECT count(*),state FROM study_chat_requests').fetchone(),(1,'unknown'))
   self.assertEqual(db.execute('SELECT count(*) FROM study_chat_budget').fetchone()[0],1)
 def test_legacy_unmarked_dispatch_is_not_assumed_dead(self):
  process=self.child();process.kill();process.wait(5)
  with closing(sqlite3.connect(self.db)) as db:
   db.execute('DELETE FROM study_chat_executors');db.commit()
  self.assertEqual(self.ledger.lookup(REQUEST)['kind'],'unknown')
  with self.assertRaisesRegex(ValueError,'account-ai-concurrency-limit'):self.ledger.begin(self.different(),SETTINGS)
  with closing(sqlite3.connect(self.db)) as db:self.assertEqual(db.execute('SELECT state FROM study_chat_budget').fetchone()[0],'inflight')
 def test_replaced_lock_identity_refuses_recovery_without_overwriting(self):
  process=self.child();process.kill();process.wait(5)
  lock=ChatExecutorLock(self.db,self.ledger.scope,REQUEST['requestId'])
  saved=lock.path.with_suffix('.saved')
  self.assertTrue(lock.path.resolve().is_relative_to(self.root.resolve()));self.assertTrue(saved.resolve().is_relative_to(self.root.resolve()))
  lock.path.rename(saved);lock.path.write_bytes(b'0')
  with self.assertRaisesRegex(ValueError,'ai-chat-execution-unverified'):self.ledger.lookup(REQUEST)
  with closing(sqlite3.connect(self.db)) as db:self.assertEqual(db.execute('SELECT state FROM study_chat_requests').fetchone()[0],'dispatched')
 def test_storage_permission_failure_is_not_an_absent_executor(self):
  process=self.child();process.kill();process.wait(5)
  with mock.patch.object(ChatExecutorLock,'acquire',side_effect=PermissionError('synthetic-denied')):
   with self.assertRaises(CompanionFailure):self.ledger.lookup(REQUEST)
  with closing(sqlite3.connect(self.db)) as db:self.assertEqual(db.execute('SELECT state FROM study_chat_budget').fetchone()[0],'inflight')
 def test_hardlinked_lock_is_rejected(self):
  lock=ChatExecutorLock(self.db,self.ledger.scope,'synthetic-file')
  self.assertTrue(lock.acquire());lock.close()
  os.link(lock.path,self.root/'synthetic-hardlink')
  with self.assertRaisesRegex(ValueError,'ai-chat-execution-unverified'):lock.acquire(create=False)
 def test_dispatch_without_real_execution_lock_is_rejected(self):
  ticket=self.ledger.begin(REQUEST,SETTINGS)
  with self.assertRaisesRegex(ValueError,'ai-chat-execution-required'):self.ledger.dispatch(ticket)
  with closing(sqlite3.connect(self.db)) as db:self.assertEqual(db.execute('SELECT state FROM study_chat_requests').fetchone()[0],'preflight')

if __name__=='__main__':unittest.main()
