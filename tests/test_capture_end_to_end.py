"""v1.0 capture-to-site end-to-end verification over real HTTP loopback.

Simulates the full Codex closing sequence against a live Companion server:
1. explicit capture -> plan managed block (review item)
2. approved snapshot (same captureId, Codex step 3)
3. /v1/plan/current reflects the review item
4. /v1/study-data pool is driven by the approved snapshot
5. duplicate captureId stays idempotent
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import plan_authority  # noqa: E402
import server  # noqa: E402
import snapshot_schema  # noqa: E402


def capture_payload(capture_id: str, evidence: str = "explicit") -> dict:
    return {
        "captureId": capture_id, "itemId": "zhx-word-pooling", "domain": "ielts",
        "sourceNote": "02 项目与研究/论文阅读与复现/起步路线/阅读会话/2026-08-22 AlexNet P2.md",
        "stateRef": "01 学习/专项课程/Test/学习记录/L16 学习状态.md",
        "abilityId": "pooling-layer", "contentFingerprint": "e2e-abc-123",
        "pluginType": "three-stage", "planRevision": 1,
        "evidence": evidence, "summary": "pooling layer 释义（端到端）",
    }


class CaptureEndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.original_config = dict(server.CONFIG)
        self.original_database_path = server.LOCAL_DATABASE_PATH
        self.original_pairing_code = server.PAIRING_CODE
        server.LOCAL_DATABASE_PATH = self.vault / "study-loop.db"
        server.PAIRING_CODE = "E2E9F8"
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        server.CONFIG["learning_vault_root"] = str(self.vault)
        server.CONFIG["study_loop_integration_root"] = "_System/Integrations/Study Loop"
        plan_path = self.vault / "01 学习/学习计划/00 学习计划总览.md"
        plan_path.parent.mkdir(parents=True)
        plan_path.write_text("# 学习计划总览\n\n用户说明。\n", encoding="utf-8")
        plan_authority.apply_current_plan(self.vault, {
            "day": "2026-08-25", "planHash": "e" * 64,
            "items": [], "totalMinutes": 0, "overloaded": False, "skipped": [],
        }, revision=1)

    def tearDown(self) -> None:
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)
        server.LOCAL_DATABASE_PATH = self.original_database_path
        server.PAIRING_CODE = self.original_pairing_code
        self.temp_dir.cleanup()

    def _start(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
        request = urllib.request.Request(
            base + "/v1/pair",
            data=json.dumps({"code": "E2E9F8", "userId": "e2e-user-001"}).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
        session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}
        return httpd, base, session_headers

    def test_capture_to_site_end_to_end(self) -> None:
        httpd, base, session_headers = self._start()
        try:
            # 1. Explicit capture -> review route (plan managed block).
            request = urllib.request.Request(
                base + "/v1/capture",
                data=json.dumps(capture_payload("e2e-cap-001")).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            routed = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(routed["status"], "review")
            self.assertGreaterEqual(routed["revision"], 2)

            # 2. Codex step 3: approved snapshot with the same captureId.
            snapshot_schema.write_approved_snapshot(self.vault, snapshot_schema.build_snapshot(
                capture_payload("e2e-cap-001")
            ))
            approved = snapshot_schema.approved_snapshots(self.vault)
            self.assertEqual(len(approved), 1)
            self.assertEqual(approved[0]["captureId"], "e2e-cap-001")

            # 3. /v1/plan/current: managed block contains the review item.
            request = urllib.request.Request(base + "/v1/plan/current", headers=session_headers, method="GET")
            current = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertGreaterEqual(current["revision"], 2)
            review_items = (current["candidate"] or {}).get("reviewItems", [])
            self.assertEqual(review_items[0]["itemId"], "zhx-word-pooling")
            self.assertEqual(review_items[0]["reason"], "显式捕获")

            # 4. /v1/study-data: pool driven by the approved snapshot.
            request = urllib.request.Request(base + "/v1/study-data", headers=session_headers, method="GET")
            study = json.loads(urllib.request.urlopen(request, timeout=5).read())
            # Codex 捕获功能已从网站侧边栏移除：批准快照不再成为科目。
            snapshot_subject = next(
                (subject for subject in study.get("subjects", []) if subject["id"] == "approved-snapshots"),
                None,
            )
            self.assertIsNone(snapshot_subject)

            # 5. Duplicate captureId: idempotent, no extra review entry.
            request = urllib.request.Request(
                base + "/v1/capture",
                data=json.dumps(capture_payload("e2e-cap-001")).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            retry = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(retry["status"], "review")
            request = urllib.request.Request(base + "/v1/plan/current", headers=session_headers, method="GET")
            after = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(len((after["candidate"] or {}).get("reviewItems", [])), 1)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
