"""Real owned child and loopback provider; no real key, model or learning data."""
import copy
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import types
import urllib.request
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
import test_companion
from application.local_chat import execute_chat
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.managed_chat import ManagedChatExecutor
from infrastructure.chat_executor_lock import ChatExecutorLock
from infrastructure import managed_chat

FIXTURE = json.loads((Path(__file__).parent/"fixtures/local-chat-recovery-v1.json").read_text(encoding="utf8"))


class LocalChatDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root/"synthetic.sqlite"
        self.request = copy.deepcopy(FIXTURE["request"])
        self.ledger = LocalChatLedger(self.path,"owner","library",self.root)
        self.stop = threading.Event()
        self.calls = []
        parent = self

        class Provider(BaseHTTPRequestHandler):
            def log_message(self,*_args):
                pass

            def do_POST(self):
                parent.calls.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                try:
                    if parent.mode == "headers":
                        parent.stop.wait(5)
                        return
                    self.send_response(200)
                    self.send_header("Content-Type","text/event-stream")
                    self.end_headers()
                    if parent.mode == "partial":
                        self.wfile.write(b'data: {"choices":[{"delta":{"content":"saved partial"}}]}\n')
                        self.wfile.flush()
                    if parent.mode in ("comments","partial","line"):
                        frame = b'x' if parent.mode == "line" else b': heartbeat\n'
                        while not parent.stop.is_set():
                            self.wfile.write(frame)
                            self.wfile.flush()
                            parent.stop.wait(.05)
                        return
                    self.wfile.write(b'data: {"choices":[{"delta":{"content":"normal answer"},"finish_reason":"stop"}]}\n')
                    self.wfile.write(b'data: [DONE]\n')
                    self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
                    pass

        self.mode = "normal"
        self.httpd = ThreadingHTTPServer(("127.0.0.1",0),Provider)
        self.thread = threading.Thread(target=self.httpd.serve_forever,daemon=True)
        self.thread.start()
        def cleanup():
            self.stop.set()
            self.httpd.shutdown()
            self.httpd.server_close()
            self.thread.join(3)
        self.addCleanup(cleanup)
        self.settings = {**FIXTURE["settings"],"baseUrl":"http://127.0.0.1:"+str(self.httpd.server_port)+"/v1"}

    def prepare(self, seconds=1.5):
        ticket = self.ledger.begin(self.request,self.settings)
        self.worker = ManagedChatExecutor(self.ledger,ticket,self.settings,"synthetic-key",self.request,seconds=seconds)
        self.addCleanup(self.worker.close)
        return execute_chat(self.ledger,ticket,self.worker.events,lambda:None,executor=self.worker).events

    def assert_unknown(self,text=""):
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT state,text,result FROM study_chat_requests").fetchone(),("unknown",text,None))
            state,reserved = db.execute("SELECT state,reserved FROM study_chat_budget").fetchone()
            self.assertEqual(state,"unknown")
            self.assertGreater(reserved,0)
        self.assertIsNotNone(self.worker.process.poll())
        self.assertEqual(self.ledger.begin(self.request,self.settings)["kind"],"unknown")
        different = copy.deepcopy(self.request)
        different["requestId"] = "different"
        different["messages"][0]["content"] = "Different question"
        self.assertEqual(self.ledger.begin(different,self.settings)["kind"],"start")
        self.assertEqual(len(self.calls),1)

    def test_blocked_headers_are_bounded(self):
        self.mode = "headers"
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            list(self.prepare())
        self.assertLess(time.monotonic()-started,4)
        self.assert_unknown()

    def test_continuous_comments_are_bounded(self):
        self.mode = "comments"
        with self.assertRaises(TimeoutError):
            list(self.prepare())
        self.assert_unknown()

    def test_unfinished_line_is_bounded(self):
        self.mode = "line"
        with self.assertRaises(TimeoutError):
            list(self.prepare())
        self.assert_unknown()

    def test_partial_is_saved_before_timeout(self):
        self.mode = "partial"
        stream = self.prepare()
        self.assertEqual(next(stream),{"type":"delta","text":"saved partial"})
        with self.assertRaises(TimeoutError):
            next(stream)
        self.assert_unknown("saved partial")

    def test_normal_result_is_saved_before_done_and_replayed(self):
        events = list(self.prepare(seconds=5))
        self.assertEqual(events[0]["text"],"normal answer")
        self.assertEqual(events[-1]["type"],"done")
        self.assertIsNotNone(self.worker.process.poll())
        prior = self.ledger.lookup(self.request)
        self.assertEqual(prior["kind"],"done")
        self.assertEqual(prior["result"]["text"],"normal answer")
        self.assertEqual(len(self.calls),1)

    def test_cancel_confirms_child_exit_before_releasing_slot(self):
        self.mode = "partial"
        stream = self.prepare(seconds=5)
        self.assertEqual(next(stream)["text"],"saved partial")
        self.assertIsNone(self.worker.process.poll())
        stream.close()
        self.assert_unknown("saved partial")

    def test_stop_uncertain_keeps_dispatch_and_inflight(self):
        self.mode = "partial"
        stream = self.prepare(seconds=5)
        self.assertEqual(next(stream)["text"],"saved partial")
        real_stop = self.worker.stop
        with mock.patch.object(self.worker,"stop",side_effect=ValueError("ai-chat-execution-unverified")):
            with self.assertRaisesRegex(ValueError,"ai-chat-execution-unverified"):
                stream.close()
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT state FROM study_chat_requests").fetchone()[0],"dispatched")
            self.assertEqual(db.execute("SELECT state FROM study_chat_budget").fetchone()[0],"inflight")
        real_stop()
        self.assertEqual(self.ledger.lookup(self.request),{"kind":"unknown","text":"saved partial"})

    def test_late_buffered_delta_cannot_be_saved_or_completed(self):
        self.mode = "partial"
        stream = self.prepare()
        self.assertEqual(next(stream)["text"],"saved partial")
        threading.Event().wait(1.7)
        with self.assertRaises(TimeoutError):
            next(stream)
        self.assert_unknown("saved partial")

    def test_eof_keeps_lock_until_parent_final_transaction(self):
        reached,release = threading.Event(),threading.Event()
        original = self.ledger.complete
        errors,events = [],[]
        def commit(ticket,metadata):
            reached.set()
            if not release.wait(3):
                raise AssertionError("commit-barrier")
            original(ticket,metadata)
        def consume():
            try:
                # This case tests commit ownership; deadline behavior has its
                # own short-policy cases. Allow bounded startup in the full suite.
                events.extend(self.prepare(seconds=10))
            except BaseException as error:
                errors.append(error)
        with mock.patch.object(self.ledger,"complete",side_effect=commit):
            thread = threading.Thread(target=consume)
            thread.start()
            try:
                self.assertTrue(reached.wait(8),"commit not reached: "+repr(errors))
                other = LocalChatLedger(self.path,"owner","library",self.root)
                self.assertEqual(other.lookup(self.request)["kind"],"unknown")
                with closing(sqlite3.connect(self.path)) as db:
                    self.assertEqual(db.execute("SELECT state FROM study_chat_requests").fetchone()[0],"dispatched")
                    self.assertEqual(db.execute("SELECT state FROM study_chat_budget").fetchone()[0],"inflight")
                self.assertIsNone(self.worker.process.poll())
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual(events[-1]["type"],"done")
        self.assertEqual(self.ledger.lookup(self.request)["kind"],"done")

    def test_blocked_large_initial_pipe_is_bounded_and_unsent_reservation_released(self):
        original_popen = subprocess.Popen
        def blocked(args,**kwargs):
            return original_popen([sys.executable,"-I","-B","-c","import time; time.sleep(5)"],**kwargs)
        self.request["context"]["question"] = "中"*4000
        with mock.patch.object(managed_chat.subprocess,"Popen",side_effect=blocked):
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                list(self.prepare())
            self.assertLess(time.monotonic()-started,4)
        self.assertEqual(self.calls,[])
        self.assertIsNotNone(self.worker.process.poll())
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT state FROM study_chat_requests").fetchone()[0],"abandoned")
            self.assertEqual(db.execute("SELECT state,reserved FROM study_chat_budget").fetchone(),("released",0))

    def test_parent_hard_exit_leaves_child_locked_until_its_deadline(self):
        self.mode = "partial"
        code = """
import json,sys
sys.path.insert(0,sys.argv[1])
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.managed_chat import ManagedChatExecutor
from application.local_chat import execute_chat
f=json.loads(sys.stdin.readline())
ledger=LocalChatLedger(sys.argv[2],'owner','library',sys.argv[3])
ticket=ledger.begin(f['request'],f['settings'])
worker=ManagedChatExecutor(ledger,ticket,f['settings'],'synthetic-key',f['request'],seconds=2.5)
stream=execute_chat(ledger,ticket,worker.events,lambda:None,executor=worker).events
next(stream)
print('READY',flush=True)
sys.stdin.readline()
"""
        process = subprocess.Popen([sys.executable,"-I","-B","-u","-c",code,
                                    str(Path(__file__).resolve().parents[1]/"companion"),
                                    str(self.path),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL,text=True,encoding="utf8")
        try:
            process.stdin.write(json.dumps({"request":self.request,"settings":self.settings})+"\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline(100),"READY\n")
            self.assertIsNone(process.poll())
            lock = ChatExecutorLock(self.path,self.ledger.scope,self.request["requestId"])
            self.assertFalse(lock.acquire(create=False))
            process.kill()
            process.wait(5)
            # Parent exit alone must not release the actual child's OS lock.
            self.assertFalse(lock.acquire(create=False))
            until = time.monotonic()+4
            while time.monotonic()<until:
                if lock.acquire(create=False):
                    break
                threading.Event().wait(.05)
            else:
                self.fail("Child watchdog did not release actual execution lock")
            lock.close()
            self.assertEqual(self.ledger.lookup(self.request),{"kind":"unknown","text":"saved partial"})
            with closing(sqlite3.connect(self.path)) as db:
                state,reserved = db.execute("SELECT state,reserved FROM study_chat_budget").fetchone()
                self.assertEqual(state,"unknown")
                self.assertGreater(reserved,0)
            self.assertEqual(len(self.calls),1)
        finally:
            self.stop.set()
            if process.poll() is None:
                process.kill()
                process.wait(5)
            process.stdin.close()
            process.stdout.close()

    def test_actual_handler_default_transport_uses_real_worker_and_replays(self):
        server = test_companion.server
        fixture = test_companion.CompanionSyncTests()
        fixture.setUp()
        origin = "https://chat-worker-fixture.example"
        server.CONFIG["allowed_origins"] = [origin]
        library = server.local_vault_library_id(fixture.vault)
        secrets = {}
        keyring = types.SimpleNamespace(get_password=lambda _service,name:secrets.get(name),
                                       set_password=lambda _service,name,value:secrets.__setitem__(name,value))
        companion = ThreadingHTTPServer(("127.0.0.1",0),server.Handler)
        thread = threading.Thread(target=companion.serve_forever,daemon=True)
        thread.start()
        base = "http://127.0.0.1:"+str(companion.server_port)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def post(action,value):
            request = urllib.request.Request(base+"/v1/ai/"+action,
                data=json.dumps({"libraryId":library,**value}).encode(),
                headers={"Origin":origin,"Content-Type":"application/json","X-Study-Loop-Session":"synthetic"},
                method="POST")
            with opener.open(request,timeout=8) as response:
                return response.status,response.headers,response.read().decode()
        try:
            with mock.patch.dict(sys.modules,{"keyring":keyring}), \
                    mock.patch.object(server,"authenticate_session",side_effect=lambda token:"owner" if token=="synthetic" else None):
                self.assertIsNone(server.route_services().local_chat_transport)
                status,_,raw = post("configure",{"settings":{"provider":"chatgpt","model":"fixture-model",
                    "baseUrl":self.settings["baseUrl"],"enabled":True,"confirmCosts":True,
                    "providerKey":"synthetic-key","expectedRevision":0}})
                self.assertEqual(status,200)
                self.assertNotIn("synthetic-key",raw)
                for _ in range(2):
                    status,headers,raw = post("chat",{"request":self.request})
                    self.assertEqual(status,200)
                    self.assertIn("text/event-stream",headers["Content-Type"])
                    self.assertIn("normal answer",raw)
                    self.assertIn('"type": "done"',raw)
                    self.assertNotIn("synthetic-key",raw)
                self.assertEqual(len(self.calls),1)
                with closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as db:
                    self.assertEqual(db.execute("SELECT count(*),state FROM study_chat_requests").fetchone(),(1,"done"))
                    self.assertEqual(db.execute("SELECT count(*) FROM study_chat_budget").fetchone()[0],1)
                self.assertEqual(list(fixture.vault.rglob("*.jsonl")),[])
        finally:
            companion.shutdown()
            companion.server_close()
            thread.join(3)
            fixture.tearDown()


if __name__ == "__main__":
    unittest.main()
