"""Fixed private provider worker. No server, configuration or formal writers."""
import math
import os
import sys
import threading
import time
import json
from pathlib import Path


def send(value):
    raw = json.dumps(value,ensure_ascii=False).encode("utf8")+b"\n"
    if len(raw)>262144:
        raise ValueError("ai-stream-limit")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def run_provider(provider):
    from infrastructure.chat_executor_lock import ChatExecutorLock
    raw = sys.stdin.buffer.readline(262145)
    if len(raw)>262144 or not raw.endswith(b"\n"):
        raise ValueError("invalid-ai-chat")
    payload = json.loads(raw)
    lock = ChatExecutorLock(payload["database"],payload["scope"],payload["requestId"])
    if not lock.acquire():
        raise ValueError("ai-request-pending")
    try:
        device,inode = map(str,lock.identity())
        send({"type":"ready","device":device,"inode":inode,"pid":os.getpid()})
        if sys.stdin.buffer.readline(16) != b"start\n":
            return
        for event in provider.stream_chat(payload["settings"],payload["key"],payload["request"]):
            send({"type":"event","event":event})
        send({"type":"eof"})
        # Parent still needs the witness while committing the final receipt.
        sys.stdin.buffer.readline(16)
    finally:
        lock.close()


def main():
    deadline = float(sys.argv[1])
    if not math.isfinite(deadline) or deadline-time.monotonic()>120:
        raise SystemExit(2)
    def expire():
        threading.Event().wait(max(0,deadline-time.monotonic()))
        # sys.exit in a thread cannot stop a blocking socket in the main thread.
        os._exit(124)
    threading.Thread(target=expire,daemon=True).start()
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    import study_ai_provider
    try:
        run_provider(study_ai_provider)
    except Exception as error:
        try:
            send({"type":"error","error":study_ai_provider.failure_code(error)})
            sys.stdin.buffer.readline(16)
        except Exception:
            pass


if __name__ == "__main__":
    main()
