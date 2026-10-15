"""Bounded owned provider process; credentials travel only through memory pipes."""
from __future__ import annotations
import errno
import json
import math
import os
import queue
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from application.ai import ChatTransport
from infrastructure.chat_executor_lock import ChatExecutorLock

MAX_EXECUTION_SECONDS = 120
MAX_FRAME_BYTES = 262144


class ManagedChatExecutor:
    def __init__(self, ledger, ticket, settings, key, request, *, seconds=MAX_EXECUTION_SECONDS):
        if type(seconds) not in (int,float) or not math.isfinite(seconds) or not 0 < seconds <= MAX_EXECUTION_SECONDS:
            raise ValueError("ai-provider-timeout")
        self.deadline = time.monotonic()+seconds
        self.witness = ChatExecutorLock(ledger.path,ledger.scope,ticket["requestId"])
        self.payload = json.dumps({"database":str(ledger.path.resolve()),"scope":list(ledger.scope),
                                   "requestId":ticket["requestId"],"settings":settings,
                                   "key":key,"request":request},ensure_ascii=False).encode("utf8")+b"\n"
        if len(self.payload) > MAX_FRAME_BYTES:
            raise ValueError("invalid-ai-chat")
        self.process = None
        self.stopped = False
        self.ready = False
        self._identity = None
        self._closed = threading.Event()
        self._incoming = queue.Queue(maxsize=4)
        self._outgoing = queue.Queue(maxsize=3)
        self._threads = []

    def remaining(self):
        remaining = self.deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError("ai-provider-timeout")
        return remaining

    def check(self):
        self.remaining()
        if not self.ready or self.stopped or self.process.poll() is not None:
            raise ValueError("ai-provider-error")

    def _publish(self, value):
        while not self._closed.is_set():
            try:
                self._incoming.put(value,timeout=.1)
                return
            except queue.Full:
                continue

    def _read(self):
        try:
            while not self._closed.is_set():
                line = self.process.stdout.readline(MAX_FRAME_BYTES+1)
                if not line:
                    self._publish(("error","ai-provider-error"))
                    return
                if len(line)>MAX_FRAME_BYTES or not line.endswith(b"\n"):
                    self._publish(("error","ai-stream-limit"))
                    return
                value = json.loads(line)
                if not isinstance(value,dict):
                    raise ValueError("invalid-frame")
                self._publish(("frame",value))
        except Exception:
            self._publish(("error","ai-provider-error"))

    def _write(self):
        try:
            while not self._closed.is_set():
                try:
                    message = self._outgoing.get(timeout=.1)
                except queue.Empty:
                    continue
                self.process.stdin.write(message)
                self.process.stdin.flush()
        except Exception:
            self._publish(("error","ai-provider-error"))

    def _receive(self):
        try:
            kind,value = self._incoming.get(timeout=self.remaining())
        except queue.Empty:
            raise TimeoutError("ai-provider-timeout")
        # Watchdog exit may race the final pipe read; never accept late frames.
        self.remaining()
        if kind == "error":
            raise ValueError(value)
        return value

    def acquire(self):
        self.remaining()
        script = Path(__file__).with_name("chat_provider_worker.py")
        allowed = {"SYSTEMROOT","WINDIR","TEMP","TMP","PATH","HTTP_PROXY","HTTPS_PROXY",
                   "ALL_PROXY","NO_PROXY","SSL_CERT_FILE","SSL_CERT_DIR"}
        env = {name:value for name,value in os.environ.items() if name.upper() in allowed}
        # A Windows venv executable can be a redirector with a different PID.
        # This fixed worker uses stdlib and local modules only; own the actual
        # interpreter so kill/wait confirms the process holding the OS lock.
        executable = getattr(sys,"_base_executable",sys.executable)
        self.process = subprocess.Popen([executable,"-I","-B",str(script),repr(self.deadline)],
                                        stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL,cwd=script.parent,env=env)
        self._threads = [threading.Thread(target=target,daemon=True) for target in (self._read,self._write)]
        for thread in self._threads:
            thread.start()
        self._outgoing.put_nowait(self.payload)
        self.payload = None
        try:
            frame = self._receive()
            if (set(frame) != {"type","device","inode","pid"} or frame["type"] != "ready"
                    or type(frame["pid"]) is not int or frame["pid"] != self.process.pid):
                raise ValueError("ai-chat-execution-unverified")
            named = self.witness.path.stat(follow_symlinks=False)
            if (ChatExecutorLock._linked(self.witness.directory) or ChatExecutorLock._linked(self.witness.path)
                    or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1 or named.st_ino == 0
                    or (str(named.st_dev),str(named.st_ino)) != (frame["device"],frame["inode"])):
                raise ValueError("ai-chat-execution-unverified")
            self._identity = named.st_dev,named.st_ino
            self.ready = True
            self.check()
            return True
        except BaseException:
            self.stop()
            raise

    def identity(self):
        self.check()
        return self._identity

    def events(self):
        self.check()
        self._outgoing.put_nowait(b"start\n")
        while True:
            frame = self._receive()
            self.check()
            if set(frame) == {"type","event"} and frame["type"] == "event" and isinstance(frame["event"],dict):
                yield frame["event"]
            elif frame == {"type":"eof"}:
                return
            elif set(frame) == {"type","error"} and frame["type"] == "error":
                if frame["error"] == "ai-provider-timeout":
                    raise TimeoutError("ai-provider-timeout")
                raise ValueError(frame["error"])
            else:
                raise ValueError("ai-provider-error")

    def stop(self):
        if self.stopped:
            return
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait(timeout=5)
            except (OSError,subprocess.TimeoutExpired) as error:
                raise ValueError("ai-chat-execution-unverified") from error
            if self.process.poll() is None:
                raise ValueError("ai-chat-execution-unverified")
        self.stopped = True
        self._closed.set()
        for thread in self._threads:
            thread.join(1)
        if self.process is not None:
            cleanup_error = None
            for pipe in (self.process.stdin,self.process.stdout):
                try:
                    pipe.close()
                except OSError as error:
                    # The owned child has already exited. Buffered Windows pipe
                    # teardown may fail after termination; it must not replace
                    # the original timeout or weaken the exit check above.
                    if error.errno not in (errno.EPIPE,errno.EINVAL) and cleanup_error is None:
                        cleanup_error = error
            if cleanup_error is not None:
                raise cleanup_error

    def close(self):
        self.stop()


def create_managed_chat_transport(ledger,ticket,settings,key,request):
    executor = ManagedChatExecutor(ledger,ticket,settings,key,request)
    return ChatTransport(executor.events,executor)
