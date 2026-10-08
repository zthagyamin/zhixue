import sys
import tempfile
import unittest
import threading
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from notion_connector import NotionError
from notion_writeback import NotionOutbox

OWNER='a'*64;OTHER='b'*64;PARENT='11111111-1111-4111-8111-111111111111'

class FakeNotion:
    def __init__(self):self.pages={};self.records={};self.creates=0;self.appends=0;self.lose_append=False;self.hide_append=False
    def find_child_page(self,parent,title):return self.pages.get((parent,title))
    def create_results_page(self,parent,title,marker):
        self.creates+=1;self.pages[parent,title]='22222222-2222-4222-8222-222222222222';return self.pages[parent,title]
    def verify_results_page(self,page,marker,parent):return True
    def find_result(self,page,marker,expected):
        if marker in self.records and not self.hide_append:
            if self.records[marker]!=expected:raise NotionError('notion-result-conflict')
            return '33333333-3333-4333-8333-333333333333'
    def append_result(self,page,text):
        self.appends+=1;marker=text.rsplit('记录标识：',1)[1];self.records[marker]=text
        if self.lose_append:raise NotionError('notion-network',uncertain=True)
        return '33333333-3333-4333-8333-333333333333'

class NotionWritebackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.path=Path(self.temp.name)/'sources.db';self.box=NotionOutbox(self.path);self.client=FakeNotion()
    def enqueue(self):self.box.enqueue(OWNER,'source-one',PARENT,'event-one','c'*64,'2026-09-08','14:00 · 一次真实作答\n本次结果：正确')
    def test_completed_delivery_survives_restart_and_does_not_repeat(self):
        self.enqueue();self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        restarted=NotionOutbox(self.path);self.enqueue();restarted.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual((self.client.creates,self.client.appends),(1,1));self.assertEqual(restarted.summary(OWNER,'source-one')['written'],1)
        self.assertEqual(restarted.summary(OTHER,'source-one')['written'],0)
    def test_timeout_after_remote_write_is_reconciled_by_marker_without_duplicate(self):
        self.enqueue();self.client.lose_append=True;self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual(self.box.summary(OWNER,'source-one')['uncertain'],1)
        self.client.lose_append=False;NotionOutbox(self.path).deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual(self.client.appends,1);self.assertEqual(self.box.summary(OWNER,'source-one')['written'],1)
    def test_unconfirmed_remote_result_never_triggers_blind_append_retry(self):
        self.enqueue();self.client.lose_append=True;self.client.hide_append=True
        for _ in range(2):self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual(self.client.appends,1);self.assertEqual(self.box.summary(OWNER,'source-one')['uncertain'],1)
    def test_post_append_read_failure_remains_uncertain(self):
        self.enqueue();original=self.client.find_result
        def find(page,marker,expected):
            if self.client.appends:raise NotionError('notion-network')
            return original(page,marker,expected)
        self.client.find_result=find;self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual(self.box.summary(OWNER,'source-one')['uncertain'],1)
        self.client.find_result=original;self.client.hide_append=True;self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.assertEqual(self.client.appends,1)
    def test_stale_worker_error_cannot_reopen_an_inflight_append(self):
        self.box.enqueue(OWNER,'source-one',PARENT,'warmup','e'*64,'2026-09-08','warmup');self.box.deliver(OWNER,'source-one',PARENT,'笔记',self.client)
        self.client.appends=0;self.client.records={};self.enqueue();b_ready=threading.Event();a_started=threading.Event();release=threading.Event();errors=[]
        class B(FakeNotion):
            def verify_results_page(self,page,marker,parent):
                b_ready.set();a_started.wait(5);raise NotionError('notion-network')
        b=B();b.pages=self.client.pages
        original_append=self.client.append_result
        def slow_append(page,text):
            a_started.set();release.wait(5);return original_append(page,text)
        self.client.append_result=slow_append
        def deliver(client):
            try:NotionOutbox(self.path).deliver(OWNER,'source-one',PARENT,'笔记',client)
            except Exception as error:errors.append(error)
        bt=threading.Thread(target=deliver,args=(b,));at=threading.Thread(target=deliver,args=(self.client,))
        bt.start();self.assertTrue(b_ready.wait(5));at.start();self.assertTrue(a_started.wait(5));bt.join(5)
        third=FakeNotion();third.pages=self.client.pages;deliver(third)
        self.assertEqual(third.appends,0);release.set();at.join(5);self.assertEqual(errors,[])
    def test_changed_core_or_destination_cannot_retarget_an_existing_delivery(self):
        self.enqueue()
        with self.assertRaises(ValueError):self.box.enqueue(OWNER,'source-one',PARENT,'event-one','d'*64,'2026-09-08','different')
        other_parent='44444444-4444-4444-8444-444444444444'
        self.box.deliver(OWNER,'source-one',other_parent,'笔记',self.client)
        self.assertEqual(self.client.creates,0);self.assertEqual(self.client.appends,0)

if __name__=='__main__':unittest.main()
