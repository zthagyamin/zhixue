"""Task 11: end-to-end practice loop over real HTTP loopback with a temp vault.

list -> variant -> grade -> v3 practice-event write-back, asserting that the
review queue managed block and the review point text land in the result card.

The v3 payload follows the REAL production shape (same envelope the website
sends): the practice item identity lives in ``event.item.key`` as
"practice:{itemId}" and abilityId travels in ``localContext``. The website's
stateRef plumbing only forwards paths that end in ``.md``, while result-card
items carry wikilink targets WITHOUT ``.md`` — so production practice events
arrive with ``stateRef`` DROPPED (unmapped). The write-back routing must still
resolve the card through ``item.key`` ("practice:" prefix stripped) and fire.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import review_queue  # noqa: E402
import server  # noqa: E402

SOURCE_NOTE = "01 学习/专项课程/Stanford CS231n/课程笔记/第06讲 CNN架构与训练"
STATE_NOTE = "01 学习/专项课程/Stanford CS231n/学习记录/第06讲 学习状态"
REVIEW_POINT = "归一化解决每层信号失控；γ 缩放、β 平移"


class PracticeE2ETests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.original_config = dict(server.CONFIG)
        self.original_db = server.LOCAL_DATABASE_PATH
        self.original_pairing_code = server.PAIRING_CODE
        server.LOCAL_DATABASE_PATH = self.vault / "study-loop.db"
        server.PAIRING_CODE = "PRAC42"
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        server.CONFIG["learning_vault_root"] = str(self.vault)
        server.CONFIG["study_loop_integration_root"] = "_System/Integrations/Study Loop"

        # The v3 path validates that sourceNote/stateRef resolve to existing
        # vault notes, and the state projection requires a learning-state note.
        for note_path in (SOURCE_NOTE, STATE_NOTE):
            note = self.vault / f"{note_path}.md"
            note.parent.mkdir(parents=True, exist_ok=True)
            note.write_text(f"# {note.name}\n\n正文……\n", encoding="utf-8")
        (self.vault / f"{STATE_NOTE}.md").write_text("""---
type: learning-state
---

# 第06讲 学习状态
""", encoding="utf-8")

        result_root = self.vault / "01 学习/学习结果"
        result_root.mkdir(parents=True)
        (result_root / "l6-norm.md").write_text(f"""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2000-01-01
source_note: "[[{SOURCE_NOTE}]]"
state_ref: "[[{STATE_NOTE}]]"
---

# L6 · 归一化作用

复习要点：
- {REVIEW_POINT}
""", encoding="utf-8")

    def tearDown(self) -> None:
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)
        server.LOCAL_DATABASE_PATH = self.original_db
        server.PAIRING_CODE = self.original_pairing_code
        self.temp_dir.cleanup()

    def _v3_practice_event(self) -> dict:
        # Real production envelope: item.key carries "practice:{itemId}",
        # abilityId lives in localContext, coreHash is server-computed, and
        # stateRef is ABSENT — the app drops non-.md stateRefs (result cards
        # store wikilink targets without .md), so the event arrives unmapped.
        event = {
            "schemaVersion": 3,
            "eventId": "practice-e2e-001",
            "occurredAt": "2026-08-26T02:00:00.000Z",
            "domain": "ielts",
            "eventType": "practice-attempt",
            "item": {"kind": "word", "key": "practice:cs231n-l6-norm"},
            "attempt": {"rating": "again", "correct": False, "stageBefore": 2, "stageAfter": 3},
            "scheduling": {"reviewedAt": "2026-08-26T02:00:00.000Z", "schedulerVersion": server.SCHEDULER_VERSION},
        }
        event["coreHash"] = server.compute_study_event_core_hash(event)
        return {"event": event, "localContext": {
            "title": "归一化作用",
            "activityType": "website-practice",
            "durationMin": 2,
            "weakPoints": ["误答为治过拟合"],
            "sourceNote": f"{SOURCE_NOTE}.md",
            "abilityId": "norm-purpose",
        }}

    def test_practice_list_grade_variant_and_writeback(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(base + "/v1/pair",
                data=json.dumps({"code": "PRAC42", "userId": "e2e-user"}).encode("utf-8"), headers=headers, method="POST")
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            # 列表：学习结果卡条目（复习要点 → recall 兜底）
            request = urllib.request.Request(base + "/v1/practice", headers=session_headers, method="GET")
            payload = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(len(payload["items"]), 1)
            item = payload["items"][0]
            self.assertEqual(item["itemId"], "cs231n-l6-norm")
            self.assertEqual(item["reviewPoint"], REVIEW_POINT)

            # 变式：attempt 轮转选项（该条目为 recall 时换角度前缀）
            request = urllib.request.Request(base + "/v1/practice/variant",
                data=json.dumps({"item": item, "attempt": 1}).encode("utf-8"), headers=session_headers, method="POST")
            variant = json.loads(urllib.request.urlopen(request, timeout=5).read())["item"]
            self.assertNotEqual(variant["prompt"], item["prompt"])

            # 判题：recall 在线（无 AI 时 self-assess）
            request = urllib.request.Request(base + "/v1/practice/grade",
                data=json.dumps({"item": item, "answer": "任意"}).encode("utf-8"), headers=session_headers, method="POST")
            graded = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertIn("correct", graded)

            # 写回：v3 事件 rating=again → 学习结果卡托管块出现复习点。
            # stateRef 被生产客户端丢弃（unmapped），但 item.key 的
            # "practice:{itemId}" 仍必须命中结果卡并触发写回。
            request = urllib.request.Request(base + "/v1/activity",
                data=json.dumps(self._v3_practice_event()).encode("utf-8"), headers=session_headers, method="POST")
            result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(result["mappingStatus"], "unmapped")
            card_text = (self.vault / "01 学习/学习结果/l6-norm.md").read_text(encoding="utf-8")
            self.assertIn(review_queue.REVIEW_QUEUE_BEGIN, card_text)
            self.assertIn("归一化解决每层信号失控", card_text)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
