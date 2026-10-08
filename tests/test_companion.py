from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import os
from datetime import UTC, date, datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "companion"))

import plan_authority  # noqa: E402
import server  # noqa: E402


class CompanionSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ai_network_guard = mock.patch.object(server.study_ai_provider, 'open_request', side_effect=AssertionError('provider-network-denied-in-tests'))
        self.ai_network_guard.start()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp_dir.name)
        self.original_config = dict(server.CONFIG)
        self.original_database_path = server.LOCAL_DATABASE_PATH
        self.original_pairing_code = server.PAIRING_CODE
        self.original_pairing_failures = server.PAIRING_FAILURES
        server.LOCAL_DATABASE_PATH = self.vault / "study-loop.db"
        server.PAIRING_CODE = "A1B2C3"
        server.PAIRING_FAILURES = 0
        server.CONFIG["learning_vault_root"] = str(self.vault)
        server.CONFIG["study_loop_integration_root"] = "_System/Integrations/Study Loop"

        self.write(
            "01 学习/学习计划/00 学习计划总览.md",
            """---
type: learning-plan
priority:
  - 完成当前课程
  - 复习薄弱点
---
# 学习计划
""",
        )
        self.write(
            "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
            """---
type: learning-state
course_id: TEST
lecture_no: 1
topic: Test Topic
review_enabled: true
review_date: 2026-08-21
next_action: 定向复测
---
# 第01讲｜学习状态

## 复习队列（新增 2 项）
""",
        )

    def tearDown(self) -> None:
        self.ai_network_guard.stop()
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)
        server.LOCAL_DATABASE_PATH = self.original_database_path
        server.PAIRING_CODE = self.original_pairing_code
        server.PAIRING_FAILURES = self.original_pairing_failures
        self.temp_dir.cleanup()

    def write(self, relative: str, content: str) -> Path:
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_dashboard_reuses_existing_authority(self) -> None:
        dashboard = server.daily_dashboard(date(2026, 8, 21))
        self.assertEqual(dashboard["priorities"], ["完成当前课程", "复习薄弱点"])
        self.assertEqual(dashboard["dueReviewCount"], 2)
        self.assertEqual(dashboard["dueReviews"][0]["timing"], "today")

    def test_due_review_queue_becomes_one_renderable_item_per_review_point(self) -> None:
        state_path = self.vault / "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
        state_path.write_text(
            """---
type: learning-state
course_id: TEST
lecture_no: 1
topic: Test Topic
review_enabled: true
review_date: 2026-08-21
next_action: 定向复测
---
# 第01讲｜学习状态

## 复习队列（新增 3 项）

见 [[01 学习/专项课程/Test/检测与错题/第01讲 掌握检测|掌握检测]]：梯度检查、矩阵反传、学习率调度。
""",
            encoding="utf-8",
        )

        review = server.due_review_items(date(2026, 8, 21))[0]
        self.assertEqual(review["itemCount"], 3)
        self.assertEqual(len(review["studyItems"]), 3)
        self.assertEqual(
            [item["front"] for item in review["studyItems"]],
            ["梯度检查", "矩阵反传", "学习率调度"],
        )
        self.assertTrue(all(item["pluginType"] == "flashcard" for item in review["studyItems"]))
        self.assertTrue(all(item["stateRef"] == review["path"] for item in review["studyItems"]))

    def test_activity_is_append_only_idempotent_and_rebuilds_report(self) -> None:
        payload = {
            "eventId": "web-20260821-0001",
            "occurredAt": "2026-08-21T09:00:00+08:00",
            "domain": "python",
            "activityType": "practice",
            "title": "Python 向量化练习",
            "outcome": "completed",
            "durationMin": 20,
            "correct": 4,
            "total": 5,
            "weakPoints": ["broadcasting"],
            "sourceNote": "01 学习/学习计划/00 学习计划总览.md",
            "stateRef": "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
            "abilityId": "python-broadcasting",
        }
        first = server.accept_activity(payload)
        second = server.accept_activity(payload)

        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["dashboard"]["activityCount"], 1)
        self.assertEqual(first["event"]["schemaVersion"], 2)
        self.assertEqual(first["event"]["sourceNote"], payload["sourceNote"])
        self.assertEqual(first["event"]["stateRef"], payload["stateRef"])
        self.assertEqual(first["event"]["abilityId"], "python-broadcasting")

        event_file = self.vault / "_System/Integrations/Study Loop/events/2026/2026-08-21.jsonl"
        report_file = self.vault / "_System/Reports/Daily/2026/2026-08-21 学习同步.md"
        self.assertEqual(len(event_file.read_text(encoding="utf-8").splitlines()), 1)
        self.assertIn("Python 向量化练习", report_file.read_text(encoding="utf-8"))
        self.assertIn("|状态目标]]", report_file.read_text(encoding="utf-8"))

    def test_legacy_related_note_becomes_provenance_not_state_target(self) -> None:
        payload = {
            "eventId": "legacy-related-note-1",
            "occurredAt": "2026-08-21T09:05:00+08:00",
            "domain": "ielts",
            "activityType": "website-practice",
            "title": "Legacy vocabulary event",
            "outcome": "needs-review",
            "durationMin": 1,
            "relatedNote": "01 学习/学习计划/00 学习计划总览.md",
        }
        result = server.accept_activity(payload)
        self.assertEqual(result["event"]["schemaVersion"], 2)
        self.assertEqual(result["event"]["sourceNote"], payload["relatedNote"])
        self.assertEqual(result["event"]["stateRef"], "")

    def test_repeated_attempts_are_kept_when_event_ids_differ(self) -> None:
        base = {
            "occurredAt": "2026-08-21T09:00:00+08:00",
            "domain": "ielts",
            "activityType": "website-practice",
            "title": "词汇自评：variant",
            "durationMin": 1,
            "correct": 0,
            "total": 1,
        }
        server.accept_activity({**base, "eventId": "word-variant-attempt-1", "outcome": "needs-review"})
        server.accept_activity({**base, "eventId": "word-variant-attempt-2", "outcome": "completed", "correct": 1})

        events = server.read_activity_events(date(2026, 8, 21))
        self.assertEqual([item["outcome"] for item in events], ["needs-review", "completed"])

    def test_pairing_binds_one_companion_installation_to_one_account(self) -> None:
        paired = server.pair_account("A1B2C3", "site-user-001")
        self.assertTrue(server.authenticate_session(paired["sessionToken"]))

        with self.assertRaisesRegex(ValueError, "已绑定另一账号"):
            server.pair_account(server.PAIRING_CODE, "site-user-002")

    def test_request_paths_accept_browser_and_proxy_variants(self) -> None:
        self.assertEqual(server.normalize_request_path("/v1/pair"), "/v1/pair")
        self.assertEqual(server.normalize_request_path("/v1/pair/"), "/v1/pair")
        self.assertEqual(server.normalize_request_path("//v1//pair"), "/v1/pair")
        self.assertEqual(server.normalize_request_path("http://127.0.0.1:43121/v1/pair?source=site"), "/v1/pair")

    def test_local_sqlite_events_are_namespaced_by_paired_account(self) -> None:
        paired = server.pair_account("A1B2C3", "site-user-001")
        hashed_user = server.authenticate_session(paired["sessionToken"])
        self.assertIsNotNone(hashed_user)
        server.store_local_activity(str(hashed_user), {"eventId": "local-event-1", "title": "Local only"})

        with server.local_database() as database:
            row = database.execute(
                "SELECT user_hash, event_id FROM local_activity_events WHERE event_id = ?",
                ("local-event-1",),
            ).fetchone()
        self.assertEqual(row, (hashed_user, "local-event-1"))

    def test_pairing_code_rotates_after_five_failures(self) -> None:
        original_code = server.PAIRING_CODE
        for _ in range(4):
            with self.assertRaisesRegex(ValueError, "还可尝试"):
                server.pair_account("FFFFFF", "site-user-001")
        with self.assertRaisesRegex(ValueError, "旧配对码已作废"):
            server.pair_account("FFFFFF", "site-user-001")
        self.assertNotEqual(server.PAIRING_CODE, original_code)

    def test_companion_session_can_be_revoked(self) -> None:
        paired = server.pair_account("A1B2C3", "site-user-001")
        self.assertTrue(server.authenticate_session(paired["sessionToken"]))
        self.assertTrue(server.revoke_session(paired["sessionToken"]))
        self.assertIsNone(server.authenticate_session(paired["sessionToken"]))

    def test_local_notes_folder_is_a_first_class_source(self) -> None:
        notes = self.vault / "Plain Notes"
        first = self.write("Plain Notes/older.md", "# Older note")
        latest = self.write("Plain Notes/latest.txt", "Latest learning material")
        os.utime(first, (1_700_000_000, 1_700_000_000))
        os.utime(latest, (1_800_000_000, 1_800_000_000))
        server.CONFIG["current_source"] = ""
        server.CONFIG["learning_vault_root"] = str(self.vault / "missing-vault")
        server.CONFIG["local_notes_root"] = str(notes)

        self.assertEqual(server.resolve_current_source(), latest)
        local_connection = next(item for item in server.connection_state() if item["key"] == "localnotes")
        self.assertEqual(local_connection["status"], "ready")
        self.assertEqual(local_connection["count"], 2)

    def test_local_notes_only_activity_does_not_create_fake_vault(self) -> None:
        server.CONFIG["learning_vault_root"] = str(self.vault / "missing-vault")
        payload = {
            "eventId": "local-notes-event-1",
            "occurredAt": "2026-08-21T09:00:00+08:00",
            "domain": "python",
            "activityType": "practice",
            "title": "Local notes practice",
            "outcome": "completed",
            "durationMin": 5,
            "correct": 1,
            "total": 1,
        }
        result = server.accept_activity(payload, write_to_vault=False)
        self.assertTrue(result["accepted"])
        self.assertFalse((self.vault / "missing-vault").exists())

    def test_legacy_seed_is_exposed_as_plugin_subjects(self) -> None:
        payload = server.ensure_subject_payload({
            "source": {"title": "Legacy"},
            "words": [{"word": "robust", "meaning": "稳健的", "example": "The result is robust."}],
            "pythonTopics": ["列表推导式"],
        })
        self.assertEqual([subject["pluginType"] for subject in payload["subjects"]], ["three-stage", "flashcard"])
        self.assertEqual(payload["subjects"][0]["items"][0]["word"], "robust")
        self.assertEqual(payload["contentMode"], "demo")

    def test_ai_subject_payload_preserves_per_item_plugin_routing(self) -> None:
        payload = server.validate_cards({
            "subjects": [{
                "id": "python-mixed",
                "name": "Python 混合练习",
                "pluginType": "quiz",
                "domain": "python",
                "items": [
                    {
                        "id": "quiz-1",
                        "prompt": "len([1, 2]) 的结果是？",
                        "options": ["1", "2", "3"],
                        "answer": "2",
                        "explanation": "列表包含两个元素。",
                    },
                    {
                        "id": "code-1",
                        "pluginType": "code",
                        "prompt": "实现 add(a, b)",
                        "initialCode": "def add(a, b):\n    pass",
                        "testCode": "assert add(1, 2) == 3",
                        "solutionCode": "def add(a, b):\n    return a + b",
                    },
                ],
            }]
        }, "Python notes", "当前学习材料")
        subject = payload["subjects"][0]
        self.assertEqual(subject["pluginType"], "quiz")
        self.assertEqual(subject["items"][1]["pluginType"], "code")
        self.assertEqual(payload["status"], "connected")
        self.assertEqual(payload["contentMode"], "personal")

    def test_ai_payload_ignores_non_list_items_and_tomorrow(self) -> None:
        payload = server.validate_cards({
            "subjects": [
                {"id": "invalid", "name": "Invalid", "pluginType": "quiz", "items": {"prompt": "not-a-list"}},
                {
                    "id": "valid",
                    "name": "Valid",
                    "pluginType": "flashcard",
                    "items": [{"id": "card-1", "front": "Question", "back": "Answer"}],
                },
            ],
            "tomorrow": {"word": "not-a-list"},
        }, "Notes", "当前学习材料")
        self.assertEqual([subject["id"] for subject in payload["subjects"]], ["valid"])
        self.assertEqual(payload["tomorrow"], server.SEED.get("tomorrow", []))

    def test_ai_payload_accepts_paper_recall_and_calculation_modules(self) -> None:
        payload = server.validate_cards({
            "subjects": [{
                "id": "paper-review",
                "name": "论文复习",
                "pluginType": "recall",
                "domain": "paper",
                "items": [
                    {"id": "recall-1", "prompt": "解释残差连接", "explanation": "学习要点", "abilityId": "paper:residual"},
                    {"id": "calc-1", "pluginType": "calculation", "prompt": "计算输出尺寸", "answer": 14, "explanation": "按卷积公式计算"},
                ],
            }]
        }, "ResNet", "当前论文")
        subject = payload["subjects"][0]
        self.assertEqual(subject["domain"], "paper")
        self.assertEqual(subject["pluginType"], "recall")
        self.assertEqual(subject["items"][0]["abilityId"], "paper:residual")
        self.assertEqual(subject["items"][1]["pluginType"], "calculation")
        self.assertEqual(subject["items"][1]["answer"], 14)

    def test_credential_store_session_error_is_actionable(self) -> None:
        with mock.patch("keyring.set_password", side_effect=OSError(1312, "no logon session")):
            with self.assertRaisesRegex(RuntimeError, "Windows 桌面会话"):
                server.save_deepseek_key("sk-test-key-long-enough", "owner-hash")


    def make_v3_activity(self, event_id: str, rating: str = "good", state_ref: str | None = None, ability_id: str | None = None, item_key: str = "word-1") -> dict:
        event = {
            "schemaVersion": 3,
            "eventId": event_id,
            "coreHash": "",
            "occurredAt": "2026-08-24T10:00:00.000Z",
            "domain": "ielts",
            "eventType": "practice-attempt",
            "item": {"kind": "word", "key": item_key},
            "attempt": {"rating": rating, "correct": rating in ("good", "easy"), "stageBefore": 2, "stageAfter": 3},
            "scheduling": {"reviewedAt": "2026-08-24T10:00:00.000Z", "schedulerVersion": server.SCHEDULER_VERSION},
        }
        event["coreHash"] = server.compute_study_event_core_hash(event)
        local_context: dict = {
            "title": "词汇自评：variant",
            "activityType": "website-practice",
            "durationMin": 2,
            "weakPoints": [],
        }
        if state_ref:
            local_context["stateRef"] = state_ref
        if ability_id:
            local_context["abilityId"] = ability_id
        return {"event": event, "localContext": local_context}

    def count_jsonl_event(self, event_id: str) -> int:
        events_dir = self.vault / "_System/Integrations/Study Loop/events"
        count = 0
        for path in events_dir.glob("**/*.jsonl"):
            for line in path.read_text(encoding="utf-8").splitlines():
                if json.loads(line).get("eventId") == event_id:
                    count += 1
        return count

    def formal_state_hashes(self) -> list[str]:
        hashes: list[str] = []
        for path in sorted(self.vault.rglob("*.md")):
            content = path.read_text(encoding="utf-8")
            if "type: learning-state" in content:
                hashes.append(hashlib.sha256(content.encode("utf-8")).hexdigest())
        return hashes

    def test_schema_v3_same_event_is_idempotent(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            payload = self.make_v3_activity("evt-v3-idempotent")
            first = server.accept_study_event_v3(connection, self.vault, "account-001", payload)
            second = server.accept_study_event_v3(connection, self.vault, "account-001", payload)
            self.assertEqual(first["status"], "accepted")
            self.assertEqual(second["status"], "duplicate")
            self.assertEqual(self.count_jsonl_event("evt-v3-idempotent"), 1)
            stats = connection.execute(
                "SELECT duplicate_count FROM study_event_stats WHERE account_id = 'account-001'"
            ).fetchone()
            self.assertEqual(int(stats[0]), 1)
        finally:
            connection.close()

    def test_schema_v3_conflicting_hash_preserves_original(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            server.accept_study_event_v3(connection, self.vault, "account-001", self.make_v3_activity("evt-v3-conflict"))
            changed = self.make_v3_activity("evt-v3-conflict", rating="again")
            with self.assertRaisesRegex(ValueError, "event-conflict"):
                server.accept_study_event_v3(connection, self.vault, "account-001", changed)
            stored = connection.execute(
                "SELECT event_json FROM study_events_v3 WHERE account_id = 'account-001' AND event_id = 'evt-v3-conflict'"
            ).fetchone()
            self.assertEqual(json.loads(stored[0])["attempt"]["rating"], "good")
            stats = connection.execute(
                "SELECT conflict_count FROM study_event_stats WHERE account_id = 'account-001'"
            ).fetchone()
            self.assertEqual(int(stats[0]), 1)
        finally:
            connection.close()

    def test_unmapped_v3_event_cannot_change_formal_state(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            before = self.formal_state_hashes()
            result = server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("evt-v3-unmapped", state_ref=None, ability_id=None),
            )
            self.assertEqual(result["mappingStatus"], "unmapped")
            self.assertEqual(before, self.formal_state_hashes())
        finally:
            connection.close()

    def test_schema_v3_mapped_event_returns_a_state_handle(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
            result = server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("evt-v3-mapped", state_ref=state_ref, ability_id="word-variant"),
            )
            self.assertEqual(result["mappingStatus"], "mapped")
            self.assertTrue(result["stateHandle"])
            self.assertEqual(result["stateProjection"]["status"], "reviewed")
            state_content = (self.vault / state_ref).read_text(encoding="utf-8")
            self.assertIn("ZHIXUE:LEARNING-EVIDENCE", state_content)
            self.assertNotIn("mastered", state_content.lower())
            row = connection.execute(
                "SELECT state_handle, state_ref, ability_id FROM state_handles WHERE account_id = 'account-001'"
            ).fetchone()
            self.assertEqual(row[0], result["stateHandle"])
            self.assertEqual(row[1], state_ref)
            self.assertEqual(row[2], "word-variant")
            # A later mapped event reuses the same stable handle so older events
            # keep resolving their opaque handle back to the local path.
            second = server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("evt-v3-mapped-2", state_ref=state_ref, ability_id="word-variant"),
            )
            self.assertEqual(second["stateHandle"], result["stateHandle"])
        finally:
            connection.close()

    def test_state_projection_failure_rolls_back_event_and_vault_log(self) -> None:
        connection = sqlite3.connect(":memory:")
        state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
        payload = self.make_v3_activity("evt-v3-projection-fail", state_ref=state_ref, ability_id="word-fail")
        before_state = (self.vault / state_ref).read_bytes()
        try:
            with mock.patch.object(server.state_projection, "project_mapped_events", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    server.accept_study_event_v3(connection, self.vault, "account-001", payload)
            count = connection.execute("SELECT count(*) FROM study_events_v3").fetchone()[0]
            self.assertEqual(count, 0)
            self.assertEqual(self.count_jsonl_event("evt-v3-projection-fail"), 0)
            self.assertEqual((self.vault / state_ref).read_bytes(), before_state)
        finally:
            connection.close()

    def test_state_projection_preserves_evidence_for_sibling_abilities(self) -> None:
        connection = sqlite3.connect(":memory:")
        state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
        try:
            server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("evt-v3-ability-one", state_ref=state_ref, ability_id="ability-one"),
            )
            server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("evt-v3-ability-two", state_ref=state_ref, ability_id="ability-two"),
            )

            state_content = (self.vault / state_ref).read_text(encoding="utf-8")
            self.assertIn("ability-one", state_content)
            self.assertIn("ability-two", state_content)
        finally:
            connection.close()

    def test_schema_v3_diagnostics_are_account_scoped_and_secret_free(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            server.accept_study_event_v3(connection, self.vault, "account-001", self.make_v3_activity("evt-v3-diag"))
            payload = server.study_event_stats_payload(connection, "account-001")
            self.assertEqual(payload["eventCount"], 1)
            self.assertTrue(payload["eventSetHash"])
            self.assertEqual(payload["schedulerVersion"], server.SCHEDULER_VERSION)
            serialized = json.dumps(payload)
            for forbidden in ("sourceNote", "stateRef", "vaultPath", "localPath", "apiKey", "token"):
                self.assertNotIn(forbidden, serialized)
            empty = server.study_event_stats_payload(connection, "account-002")
            self.assertEqual(empty["eventCount"], 0)
        finally:
            connection.close()

    def test_constraint_estimation_cannot_overwrite_a_concurrent_user_save(self) -> None:
        now = datetime(2026, 8, 25, 8, tzinfo=UTC)
        server.constraint_area.write_constraints(
            self.vault,
            server.constraint_area.default_constraints(now),
            now,
        )
        estimate_started = threading.Event()
        release_estimate = threading.Event()
        real_estimate = server.history_estimator.estimate_schedule

        def slow_estimate(*args, **kwargs):
            estimate_started.set()
            release_estimate.wait(3)
            return real_estimate(*args, **kwargs)

        def save_locked_override() -> None:
            with server.constraint_area.CONSTRAINT_LOCK:
                document = server.constraint_area.read_constraints(self.vault, now)
                document["mode"] = "locked"
                document["override"] = {"dailyMinutes": {"min": 40, "max": 70}}
                server.constraint_area.write_constraints(self.vault, document, now)

        with mock.patch.object(server.history_estimator, "estimate_schedule", side_effect=slow_estimate):
            getter = threading.Thread(target=server.effective_constraints, args=(self.vault, "account-001", now))
            getter.start()
            self.assertTrue(estimate_started.wait(3))
            saver = threading.Thread(target=save_locked_override)
            saver.start()
            release_estimate.set()
            getter.join(3)
            saver.join(3)

        stored = server.constraint_area.read_constraints(self.vault, now)
        self.assertEqual(stored["mode"], "locked")
        self.assertEqual(stored["effective"]["dailyMinutes"], {"min": 40, "max": 70})

    def test_effective_constraints_expires_temporary_override_into_auto_mode(self) -> None:
        saved_at = datetime(2026, 8, 20, 8, tzinfo=UTC)
        document = server.constraint_area.default_constraints(saved_at)
        document["mode"] = "temporary"
        document["override"] = {"dailyMinutes": {"min": 100, "max": 120}}
        document["temporaryUntil"] = "2026-08-24T00:00:00+00:00"
        server.constraint_area.write_constraints(self.vault, document, saved_at)

        effective = server.effective_constraints(
            self.vault,
            "account-001",
            datetime(2026, 8, 25, 8, tzinfo=UTC),
        )

        self.assertEqual(effective["mode"], "auto")
        self.assertIsNone(effective["override"])
        self.assertIsNone(effective["temporaryUntil"])
        self.assertEqual(effective["effective"], effective["system"])

    def test_refresh_without_deepseek_returns_safe_status(self) -> None:
        """Refreshing before a local key is configured must not mark Companion offline."""
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            pair_request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "refresh-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(pair_request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}
            server.snapshot_schema.write_approved_snapshot(
                self.vault,
                server.snapshot_schema.build_snapshot(
                    {
                        "captureId": "refresh-approved-1",
                        "itemId": "refresh-item-1",
                        "domain": "python",
                        "sourceNote": "01 学习/专项课程/Test/检测.md",
                        "stateRef": "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
                        "abilityId": "refresh-ability-1",
                        "contentFingerprint": "sha256:refresh-approved-1",
                        "pluginType": "quiz",
                        "planRevision": 0,
                    },
                ),
            )
            refresh_request = urllib.request.Request(
                base + "/v1/refresh",
                data=b"{}",
                headers=session_headers,
                method="POST",
            )
            with mock.patch.object(server, "deepseek_key", return_value=None):
                refresh = json.loads(urllib.request.urlopen(refresh_request, timeout=5).read())
            self.assertEqual(refresh["status"], "key_missing")
            self.assertIn("AI", refresh["message"])
            self.assertNotIn("approved-snapshots", [subject["id"] for subject in refresh["subjects"]])
        finally:
            httpd.shutdown()
            thread.join(3)

    def test_deepseek_transport_failure_retries_and_raises_safe_error(self) -> None:
        """A reset DeepSeek connection is retried and never leaks the raw socket error."""
        with (
            mock.patch.object(server, "deepseek_key", return_value="sk-test-key-123456"),
            mock.patch.object(server.study_ai_provider, "open_request", side_effect=urllib.error.URLError(ConnectionResetError(10054, "远程主机强迫关闭了一个现有的连接。"))) as urlopen,
            mock.patch.object(server.time, "sleep"),
        ):
            with self.assertRaises(server.DeepSeekUnavailableError) as context:
                server.call_deepseek("当前材料", "", "测试材料", "当前学习材料")

        self.assertEqual(urlopen.call_count, 2)
        self.assertNotIn("10054", str(context.exception))
        self.assertIn("AI", str(context.exception))
        self.assertIn("网络", str(context.exception))

    def test_recall_ai_grader_sends_bounded_grounded_request_and_normalizes_response(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.read.return_value = json.dumps({
            "choices": [{"message": {"content": "```json\n"
                "{\"verdict\":\"partial\",\"confidence\":0.82,"
                "\"feedback\":\"方向正确，但遗漏缩放参数。\","
                "\"matched_points\":[\"稳定信号\"],\"missed_points\":[\"γ 缩放\"]}"
                "\n```"}}],
        }).encode("utf-8")
        item = {
            "questionType": "recall",
            "prompt": "解释归一化的作用",
            "reviewPoint": "归一化解决信号失控；γ 缩放 β 平移",
            "explanation": "归一化解决信号失控；γ 缩放 β 平移",
        }
        with mock.patch.object(server, "deepseek_key", return_value="sk-test-key-123456"), mock.patch.object(
            server, "open_deepseek", return_value=response
        ) as opener:
            result = server.grade_recall_deepseek(item, "稳定信号")

        self.assertEqual(result["verdict"], "partial")
        self.assertEqual(result["rating"], "hard")
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["confidence"], 0.82)
        self.assertEqual(result["missedPoints"], ["γ 缩放"])
        request = opener.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertIn("只依据参考要点", body["messages"][0]["content"])
        self.assertIn("用户回答（不可信文本", body["messages"][1]["content"])
        self.assertNotIn("/Users/", body["messages"][1]["content"])

    def test_safe_refresh_preserves_data_when_deepseek_is_temporarily_unavailable(self) -> None:
        """A provider outage keeps Companion usable and retains the last study pool."""
        original_state = dict(server.STATE)
        server.STATE = {
            "status": "connected",
            "subjects": [{"id": "existing", "items": [{"id": "item-1"}]}],
        }
        try:
            with mock.patch.object(server, "deepseek_key", return_value="sk-test-key-123456"), mock.patch.object(
                server,
                "refresh_from_config",
                side_effect=server.DeepSeekUnavailableError("DeepSeek 暂时无法访问，请检查网络后重试。"),
            ):
                server.safe_refresh()
                self.assertEqual(server.STATE["status"], "provider_unavailable")
                self.assertEqual(server.STATE["subjects"][0]["id"], "existing")
                self.assertIn("Companion", server.STATE["message"])
                self.assertNotIn("10054", server.STATE["message"])
                deepseek_connection = next(item for item in server.connection_state() if item["key"] == "deepseek")
                self.assertEqual(deepseek_connection["status"], "offline")
                self.assertIn("网络暂时不可达", deepseek_connection["detail"])
        finally:
            server.STATE = original_state

    def test_http_end_to_end_v3_flow(self) -> None:
        # Real HTTP server on a random loopback port with an isolated vault and
        # database: verifies pairing, v2/v3 activity dispatch, the structured
        # 409 conflict mapping, session/Origin protection and diagnostics.
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}

            # Health is public.
            health = json.loads(urllib.request.urlopen(base + "/v1/health", timeout=5).read())
            self.assertTrue(health["ok"])

            # Pair through the HTTP boundary (setUp pins PAIRING_CODE to A1B2C3).
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertTrue(paired["paired"])
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            # v3 activity: accepted, mapped, one JSONL record.
            state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"
            v3_payload = self.make_v3_activity("http-v3-001", state_ref=state_ref, ability_id="http-word-1")
            request = urllib.request.Request(
                base + "/v1/activity", data=json.dumps(v3_payload).encode("utf-8"), headers=session_headers, method="POST",
            )
            result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(result["mappingStatus"], "mapped")
            self.assertTrue(result["stateHandle"])

            # Idempotent retry over HTTP: duplicate, still one JSONL record.
            request = urllib.request.Request(
                base + "/v1/activity", data=json.dumps(v3_payload).encode("utf-8"), headers=session_headers, method="POST",
            )
            duplicate = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(duplicate["status"], "duplicate")
            self.assertEqual(self.count_jsonl_event("http-v3-001"), 1)

            # Conflicting reuse over HTTP: structured 409, original preserved.
            conflicting = self.make_v3_activity("http-v3-001", rating="again")
            request = urllib.request.Request(
                base + "/v1/activity", data=json.dumps(conflicting).encode("utf-8"), headers=session_headers, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 409)
            conflict_body = json.loads(context.exception.read())
            self.assertEqual(conflict_body["status"], "conflict")
            self.assertEqual(conflict_body["eventId"], "http-v3-001")

            # Diagnostics: session-protected, Origin-protected, account-scoped.
            request = urllib.request.Request(base + "/v1/diagnostics", headers=session_headers, method="GET")
            diagnostics = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(diagnostics["eventCount"], 1)
            self.assertEqual(diagnostics["conflictCount"], 1)
            self.assertEqual(diagnostics["duplicateCount"], 1)
            for forbidden in ("sourceNote", "stateRef", "vaultPath", "localPath", "apiKey", "token"):
                self.assertNotIn(forbidden, json.dumps(diagnostics))

            request = urllib.request.Request(base + "/v1/diagnostics", headers=headers, method="GET")
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 401)

            request = urllib.request.Request(
                base + "/v1/diagnostics",
                headers={**session_headers, "Origin": "https://evil.example"},
                method="GET",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 403)

            # v2 activity branch stays byte-compatible over the same endpoint.
            v2_payload = {
                "eventId": "http-v2-0001",
                "occurredAt": "2026-08-25T09:00:00+08:00",
                "domain": "python",
                "activityType": "practice",
                "title": "HTTP v2 回归",
                "outcome": "completed",
                "durationMin": 3,
                "correct": 1,
                "total": 1,
            }
            request = urllib.request.Request(
                base + "/v1/activity", data=json.dumps(v2_payload).encode("utf-8"), headers=session_headers, method="POST",
            )
            v2_result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(v2_result["event"]["schemaVersion"], 2)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_sources_init_endpoint_creates_three_subfolders(self) -> None:
        # POST /v1/sources/init ensures sources/{approved,pending,rejected}
        # exist under the vault and reports their relative paths.
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}

            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            request = urllib.request.Request(
                base + "/v1/sources/init", data=b"{}", headers=session_headers, method="POST",
            )
            result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(result["root"], "sources")
            for name in ("approved", "pending", "rejected"):
                self.assertEqual(result["dirs"][name], f"sources/{name}")
                self.assertTrue((self.vault / f"sources/{name}").is_dir())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_sources_init_requires_configured_vault(self) -> None:
        # Without a configured vault the endpoint must fail closed (400),
        # never create stray directories.
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            missing = self.vault / "missing-vault"
            server.CONFIG["learning_vault_root"] = str(missing)
            request = urllib.request.Request(
                base + "/v1/sources/init", data=b"{}", headers=session_headers, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 400)
            self.assertFalse(missing.exists())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_practice_endpoints_list_grade_and_variant(self) -> None:
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        result_root = self.vault / "01 学习/学习结果"
        result_root.mkdir(parents=True)
        (result_root / "l6-norm.md").write_text("""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2000-01-01
source_note: "[[n.md]]"
state_ref: "[[01 学习/专项课程/Test/学习记录/第01讲 学习状态.md]]"
---

# L6

复习要点：
- 归一化解决信号失控；γ 缩放 β 平移
""", encoding="utf-8")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"), headers=headers, method="POST")
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            request = urllib.request.Request(base + "/v1/practice", headers=session_headers, method="GET")
            payload = json.loads(urllib.request.urlopen(request, timeout=5).read())
            # 渐进迁移保留未匹配的 legacy 到期项；结果卡只覆盖同一能力。
            self.assertGreaterEqual(len(payload["items"]), 1)
            item = next(entry for entry in payload["items"] if entry["itemId"] == "cs231n-l6-norm")

            request = urllib.request.Request(base + "/v1/practice/grade",
                data=json.dumps({"item": item, "answer": 0}).encode("utf-8"), headers=session_headers, method="POST")
            graded = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertIn("correct", graded)

            request = urllib.request.Request(base + "/v1/practice/variant",
                data=json.dumps({"item": item, "attempt": 1}).encode("utf-8"), headers=session_headers, method="POST")
            variant = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertIn("item", variant)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_practice_event_writes_back_to_result_card_queue(self) -> None:
        import review_queue
        result_root = self.vault / "01 学习/学习结果"
        result_root.mkdir(parents=True)
        card = result_root / "l6-norm.md"
        card.write_text("""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2026-08-18
source_note: "[[n.md]]"
state_ref: "[[01 学习/专项课程/Test/学习记录/第01讲 学习状态.md]]"
---

# L6

复习要点：
- 归一化作用
""", encoding="utf-8")
        with server.local_database() as database:
            server.accept_study_event_v3(
                database, self.vault, "account-001",
                self.make_v3_activity(
                    "practice-ev-001",
                    state_ref="01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
                    ability_id="norm-purpose",
                    rating="again",
                    item_key="test-item",
                ),
            )
        text = card.read_text(encoding="utf-8")
        self.assertIn(review_queue.REVIEW_QUEUE_BEGIN, text)
        self.assertIn("归一化作用", text)
        queue = review_queue.read_queue(self.vault, "01 学习/学习结果/l6-norm.md")
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["name"], "归一化作用")

    def test_practice_event_with_prefixed_item_key_writes_back_to_card_queue(self) -> None:
        # Production-realistic: the website sends item.key as "practice:{itemId}"
        # and stateRef WITH a .md suffix, while the card stores item_id bare and
        # state_ref as a wikilink WITHOUT .md. The write-back must still route.
        import review_queue
        result_root = self.vault / "01 学习/学习结果"
        result_root.mkdir(parents=True)
        card = result_root / "l6-norm.md"
        card.write_text("""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2026-08-18
source_note: "[[n.md]]"
state_ref: "[[01 学习/专项课程/Test/学习记录/第01讲 学习状态.md]]"
---

# L6

复习要点：
- 归一化作用
""", encoding="utf-8")
        with server.local_database() as database:
            server.accept_study_event_v3(
                database, self.vault, "account-001",
                self.make_v3_activity(
                    "practice-ev-prefix-001",
                    state_ref="01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
                    ability_id="norm-purpose",
                    rating="again",
                    item_key="practice:cs231n-l6-norm",
                ),
            )
        queue = review_queue.read_queue(self.vault, "01 学习/学习结果/l6-norm.md")
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["name"], "归一化作用")

    def test_stale_card_edit_skips_write_back_but_accepts_event(self) -> None:
        # spec §9：写回前哈希核对，用户同时编辑卡片 → 跳过队列写回并提示；
        # 事件本身仍被接受（已提交、幂等），卡片内容不被覆盖。
        import review_queue
        result_root = self.vault / "01 学习/学习结果"
        result_root.mkdir(parents=True)
        card = result_root / "l6-norm.md"
        card.write_text("""---
type: learning-result
domain: course
item_id: cs231n-l6-norm
ability_id: norm-purpose
review_date: 2026-08-18
source_note: "[[n.md]]"
state_ref: "[[01 学习/专项课程/Test/学习记录/第01讲 学习状态.md]]"
---

# L6

复习要点：
- 归一化作用
""", encoding="utf-8")
        real_apply = review_queue.apply_result

        def concurrent_edit_then_apply(*args: object, **kwargs: object) -> dict:
            # 模拟用户在与事件写回并行的时刻编辑了卡片文件。
            card.write_text(card.read_text(encoding="utf-8") + "\n用户正在编辑…\n", encoding="utf-8")
            return real_apply(*args, **kwargs)

        with mock.patch.object(review_queue, "apply_result", side_effect=concurrent_edit_then_apply):
            with server.local_database() as database:
                result = server.accept_study_event_v3(
                    database, self.vault, "account-001",
                    self.make_v3_activity(
                        "practice-ev-stale-001",
                        state_ref="01 学习/专项课程/Test/学习记录/第01讲 学习状态.md",
                        ability_id="norm-purpose",
                        rating="again",
                        item_key="practice:cs231n-l6-norm",
                    ),
                )
        self.assertEqual(result["status"], "accepted")
        text = card.read_text(encoding="utf-8")
        self.assertIn("用户正在编辑…", text)
        self.assertNotIn(review_queue.REVIEW_QUEUE_BEGIN, text)
        with server.local_database() as database:
            count = database.execute(
                "SELECT count(*) FROM study_events_v3 WHERE account_id = 'account-001' AND event_id = 'practice-ev-stale-001'"
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_capture_endpoint_routes_by_evidence(self) -> None:
        # POST /v1/capture stores and routes: explicit+stateRef -> review
        # (plan managed block), speculative -> candidate (sources/pending),
        # explicit without stateRef -> unmapped; invalid evidence -> 400.
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        plan_path = self.vault / "01 学习/学习计划/00 学习计划总览.md"
        plan_authority.apply_current_plan(self.vault, {
            "day": "2026-08-25", "planHash": "a" * 64,
            "items": [], "totalMinutes": 0, "overloaded": False, "skipped": [],
        }, revision=1)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            def post_capture(capture: dict) -> dict:
                request = urllib.request.Request(
                    base + "/v1/capture", data=json.dumps(capture).encode("utf-8"), headers=session_headers, method="POST",
                )
                return json.loads(urllib.request.urlopen(request, timeout=5).read())

            explicit = {
                "captureId": "http-cap-001", "itemId": "zhx-word-pooling", "domain": "ielts",
                "sourceNote": "P2.md", "stateRef": "L16.md", "abilityId": "pooling-layer",
                "contentFingerprint": "abc", "pluginType": "three-stage", "planRevision": 0,
                "evidence": "explicit", "summary": "pooling layer 释义",
            }
            first = post_capture(explicit)
            self.assertEqual(first["status"], "review")
            self.assertGreaterEqual(first["revision"], 2)
            self.assertTrue(plan_path.read_text(encoding="utf-8").count("zhx-word-pooling") >= 1)

            # Idempotent retry: same captureId replays its route, no duplicate entry.
            retry = post_capture(explicit)
            self.assertEqual(retry["status"], "review")
            with server.local_database() as database:
                self.assertEqual(len(server.capture_store.pending_captures(database)), 0)

            # Speculative capture -> candidate in sources/pending, still pending.
            speculative = {**explicit, "captureId": "http-cap-002", "evidence": "speculative"}
            candidate_result = post_capture(speculative)
            self.assertEqual(candidate_result["status"], "candidate")
            self.assertTrue((self.vault / "sources/pending/http-cap-002.json").exists())

            # Explicit but unmapped (no stateRef) -> unmapped, no plan write.
            unmapped = {**explicit, "captureId": "http-cap-003", "stateRef": ""}
            self.assertEqual(post_capture(unmapped)["status"], "unmapped")

            # Invalid evidence is rejected with 400.
            bad = {**explicit, "captureId": "http-cap-004", "evidence": "maybe"}
            request = urllib.request.Request(
                base + "/v1/capture", data=json.dumps(bad).encode("utf-8"), headers=session_headers, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 400)

            # GET /v1/capture lists pending captures only (review is processed).
            request = urllib.request.Request(base + "/v1/capture", headers=session_headers, method="GET")
            capture_list = json.loads(urllib.request.urlopen(request, timeout=5).read())
            pending_ids = {item["captureId"] for item in capture_list["pendingCaptures"]}
            self.assertNotIn("http-cap-001", pending_ids)
            self.assertIn("http-cap-002", pending_ids)
            self.assertIn("http-cap-003", pending_ids)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_approved_snapshots_drive_subjects_with_stable_item_id(self) -> None:
        # v1.0: the learning pool is driven by approved snapshots; current_source
        # no longer decides content. merge_approved_snapshots only reads
        # sources/approved, never current_source/next_source.
        server.CONFIG["current_source"] = str(self.vault / "current-source.md")
        (self.vault / "current-source.md").write_text("无关内容", encoding="utf-8")
        server.snapshot_schema.write_approved_snapshot(self.vault, server.snapshot_schema.build_snapshot({
            "captureId": "cap-a1", "itemId": "zhx-word-pooling", "domain": "ielts",
            "sourceNote": "P2.md", "stateRef": "L16.md", "abilityId": "pooling-layer",
            "contentFingerprint": "abc", "pluginType": "three-stage", "planRevision": 1,
            "summary": "pooling layer 释义",
        }))
        merged = server.merge_approved_snapshots({"subjects": []}, self.vault)
        approved = next(subject for subject in merged["subjects"] if subject["id"] == "approved-snapshots")
        item = approved["items"][0]
        self.assertEqual(item["itemId"], "zhx-word-pooling")
        self.assertEqual(item["abilityId"], "pooling-layer")
        self.assertEqual(item["sourceRef"], "snapshot:cap-a1")
        self.assertEqual(approved["items"][0]["word"], "pooling layer 释义")

        self.assertEqual(item["pluginType"], "flashcard")
        self.assertEqual(item["front"], "pooling layer 释义")
        self.assertIn("P2.md", item["back"])

        # current_source content is never read: changing it cannot change subjects.
        (self.vault / "current-source.md").write_text("完全不同的内容", encoding="utf-8")
        unchanged = server.merge_approved_snapshots({"subjects": []}, self.vault)
        self.assertEqual(unchanged["subjects"][0]["items"][0]["itemId"], "zhx-word-pooling")

        # Without approved snapshots the payload passes through untouched.
        empty = server.merge_approved_snapshots({"subjects": []}, Path(self.temp_dir.name) / "empty-vault")
        self.assertEqual(empty, {"subjects": []})

    def test_complete_quiz_snapshot_keeps_quiz_payload(self) -> None:
        server.snapshot_schema.write_approved_snapshot(self.vault, server.snapshot_schema.build_snapshot({
            "captureId": "cap-quiz", "itemId": "quiz-item", "domain": "course",
            "sourceNote": "Quiz.md", "stateRef": "State.md", "abilityId": "quiz-ability",
            "contentFingerprint": "quiz", "pluginType": "quiz", "planRevision": 1,
            "summary": "完整选择题", "prompt": "2 + 2?", "options": ["3", "4"],
            "answer": "4", "explanation": "基础加法",
        }))

        merged = server.merge_approved_snapshots({"subjects": []}, self.vault)
        item = merged["subjects"][0]["items"][0]
        self.assertEqual(item["pluginType"], "quiz")
        self.assertEqual(item["answer"], "4")

    def test_attach_state_handles_injects_mapped_handles(self) -> None:
        # attach_state_handles reads the same local_database() file the handler
        # writes through, so the mapping must be stored there.
        with server.local_database() as connection:
            server.accept_study_event_v3(
                connection,
                self.vault,
                "account-001",
                self.make_v3_activity("handle-inject-001", state_ref="01 学习/专项课程/Test/学习记录/第01讲 学习状态.md", ability_id="word-inject"),
            )
        payload = {
            "subjects": [
                {"id": "ielts", "items": [{"word": "alpha", "stateRef": "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md", "abilityId": "word-inject"}]},
                {"id": "python", "items": [{"word": "beta", "stateRef": "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md", "abilityId": "word-other"}]},
            ]
        }
        enriched = server.attach_state_handles(payload, "account-001")
        self.assertTrue(enriched["subjects"][0]["items"][0]["stateHandle"])
        self.assertNotIn("stateHandle", enriched["subjects"][1]["items"][0])

    def test_study_data_only_merges_source_area_items_after_approval(self) -> None:
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        sources = self.vault / "_System/Integrations/Study Loop/sources"
        sources.mkdir(parents=True)
        (sources / "知学资料.md").write_text(
            """---
type: study-loop-source
status: active
---

# 知学资料

## 词汇

| 单词/词组 | 释义 | 原文语境 | 来源笔记 |
|---|---|---|---|
| pooling layer | 池化层 | Pooling layers in CNNs ... | [[P2]] |

## Python 代码题

| 条目ID | 主题 | 题干 | 初始代码 | 测试代码 | 能力ID | 来源笔记 | 状态记录 |
|---|---|---|---|---|---|---|---|
| py:approved | Python sum | 实现 add | def add(a, b):\\n    pass | assert add(1, 2) == 3 | python-add | [[P2]] | [[state]] |
""",
            encoding="utf-8",
        )
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            # A new source file is only a candidate and cannot change the
            # learning flow before the user approves it.
            request = urllib.request.Request(base + "/v1/study-data", headers=session_headers, method="GET")
            payload = json.loads(urllib.request.urlopen(request, timeout=5).read())
            subjects = payload.get("subjects", [])
            self.assertFalse(any(subject["id"] == "study-loop-sources" for subject in subjects))

            self.assertFalse(any(subject["id"] == "python-practice" for subject in subjects))

            request = urllib.request.Request(base + "/v1/changes", headers=session_headers, method="GET")
            changes = json.loads(urllib.request.urlopen(request, timeout=5).read())["changes"]
            self.assertEqual(len(changes), 1)
            request = urllib.request.Request(
                base + "/v1/changes/decide",
                data=json.dumps({"changeId": changes[0]["changeId"], "decision": "approved", "operator": "site-user-001"}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            urllib.request.urlopen(request, timeout=5).read()

            request = urllib.request.Request(base + "/v1/study-data", headers=session_headers, method="GET")
            payload = json.loads(urllib.request.urlopen(request, timeout=5).read())
            subjects = payload.get("subjects", [])
            self.assertFalse(any(subject["id"] == "study-loop-sources" for subject in subjects))
            # 来源词条并入唯一背词科目，不再出现独立侧边栏。
            vocab_subject = next(subject for subject in subjects if subject["id"] == "ielts-vocabulary")
            words = [item["word"] for item in vocab_subject["items"]]
            self.assertIn("pooling layer", words)
            code_subject = next(subject for subject in subjects if subject["id"] == "python-practice")
            self.assertEqual(code_subject["items"][0]["itemId"], "py:approved")
            self.assertEqual(code_subject["items"][0]["stateRef"], "state.md")
            self.assertEqual(code_subject["items"][0]["testCode"], "assert add(1, 2) == 3")
            self.assertFalse(any(subject["id"] == "study-loop-sources-quiz" for subject in subjects))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_merge_source_area_exposes_python_code_subject(self) -> None:
        document = {
            "path": "Python Day 001.md",
            "content": """---
type: study-loop-source
status: active
domain: python
---

## Python 代码题

| 主题 | 题干 | 初始代码 | 测试代码 | 参考代码 | 能力ID | 来源笔记 | 状态记录 |
|---|---|---|---|---|---|---|---|
| 统计函数 | 实现 summarize_scores | def summarize_scores(scores):\\n    raise NotImplementedError | assert summarize_scores([2, 4])[\"mean\"] == 3 | def summarize_scores(scores):\\n    return {\"mean\": sum(scores) / len(scores)} | PYN-BAS-01 | [[02 项目与研究/项目/PY100/Day 001]] | [[02 项目与研究/项目/PY100/00 项目导航]] |
""",
        }

        payload = server.merge_source_area({"subjects": []}, self.vault, [document])

        self.assertIn("python-practice", [subject["id"] for subject in payload["subjects"]])
        subject = next(subject for subject in payload["subjects"] if subject["id"] == "python-practice")
        self.assertEqual(subject["name"], "Python 练习")
        self.assertEqual(subject["pluginType"], "code")
        self.assertEqual(subject["domain"], "python")
        self.assertEqual(subject["items"][0]["abilityId"], "PYN-BAS-01")
        self.assertEqual(subject["items"][0]["pluginType"], "code")

    def test_merge_source_area_replaces_positional_vocabulary_identity(self) -> None:
        document = {
            "path": "词库.md",
            "content": """---
type: study-loop-source
status: active
---

## 词汇

| 单词/词组 | 释义 | 原文语境 | 来源笔记 |
|---|---|---|---|
| prohibitively | 高得令人望而却步地 | The computational cost is prohibitively high. | [[01 学习/学术英语词库/00 学术阅读词卡库]] |
""",
        }
        payload = {
            "subjects": [{
                "id": "ielts-vocabulary",
                "name": "IELTS 核心词汇",
                "pluginType": "three-stage",
                "domain": "ielts",
                "items": [{"id": "item-1-2", "word": "prohibitively", "meaning": "旧释义"}],
            }],
        }

        merged = server.merge_source_area(payload, self.vault, [document])

        item = merged["subjects"][0]["items"][0]
        self.assertEqual(item["abilityId"], "word:prohibitively")
        self.assertEqual(item["sourceNote"], "01 学习/学术英语词库/00 学术阅读词卡库.md")

    def test_plan_apply_endpoint_writes_revision(self) -> None:
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}
            candidate = {
                "day": "2026-08-25",
                "planHash": "c" * 64,
                "items": [{"kind": "study", "itemKey": "p1", "domain": "ielts", "estimatedMinutes": 10, "reasons": ["当前学习主线"]}],
                "totalMinutes": 10,
                "overloaded": False,
                "skipped": [],
            }
            request = urllib.request.Request(
                base + "/v1/plan/apply",
                data=json.dumps({"candidate": candidate, "operator": "site-user-001", "expectedRevision": 0}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(result["revision"]["revision"], 1)
            plan_file = self.vault / "01 学习/学习计划/00 学习计划总览.md"
            self.assertTrue(plan_file.exists())
            self.assertIn("c" * 64, plan_file.read_text(encoding="utf-8"))

            current_request = urllib.request.Request(base + "/v1/plan/current", headers=session_headers, method="GET")
            current = json.loads(urllib.request.urlopen(current_request, timeout=5).read())
            self.assertEqual(current["revision"], 1)
            self.assertEqual(current["candidate"]["planHash"], "c" * 64)

            stale_request = urllib.request.Request(
                base + "/v1/plan/apply",
                data=json.dumps({"candidate": {**candidate, "planHash": "d" * 64}, "expectedRevision": 0}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as stale:
                urllib.request.urlopen(stale_request, timeout=5)
            self.assertEqual(stale.exception.code, 409)

            reject_request = urllib.request.Request(
                base + "/v1/plan/reject",
                data=json.dumps({"candidateHash": "e" * 64, "reason": "稍后处理"}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            rejected = json.loads(urllib.request.urlopen(reject_request, timeout=5).read())
            self.assertEqual(rejected["decision"]["decision"], "rejected")
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_constraint_and_immediate_scan_endpoints(self) -> None:
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        source = self.vault / "_System/Integrations/Study Loop/sources/new.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("# 新资料", encoding="utf-8")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            pair = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            token = json.loads(urllib.request.urlopen(pair, timeout=5).read())["sessionToken"]
            session_headers = {**headers, "X-Study-Loop-Session": token}

            get_constraints = urllib.request.Request(base + "/v1/constraints", headers=session_headers, method="GET")
            constraints = json.loads(urllib.request.urlopen(get_constraints, timeout=5).read())
            self.assertEqual(constraints["mode"], "auto")
            self.assertIn("explanation", constraints)

            constraints["mode"] = "locked"
            constraints["override"] = {"dailyMinutes": {"min": 40, "max": 70}}
            save = urllib.request.Request(
                base + "/v1/constraints",
                data=json.dumps({"constraints": constraints}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            saved = json.loads(urllib.request.urlopen(save, timeout=5).read())
            self.assertEqual(saved["effective"]["dailyMinutes"], {"min": 40, "max": 70})

            scan = urllib.request.Request(base + "/v1/changes/scan", data=b"{}", headers=session_headers, method="POST")
            scanned = json.loads(urllib.request.urlopen(scan, timeout=5).read())
            self.assertEqual(scanned["pendingCount"], 1)
            self.assertNotIn(str(self.vault), json.dumps(scanned))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_change_scan_loop_runs_once_then_waits_for_900_seconds(self) -> None:
        class StopAfterWait:
            def __init__(self) -> None:
                self.waited = None

            def is_set(self) -> bool:
                return False

            def wait(self, seconds: int) -> bool:
                self.waited = seconds
                return True

        stop = StopAfterWait()
        with mock.patch.object(server, "run_change_scan_once") as scan:
            server.change_scan_loop(stop, interval_seconds=900)
        scan.assert_called_once()
        self.assertEqual(stop.waited, 900)

    def test_changes_endpoint_lists_and_decides_pending_changes(self) -> None:
        server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        sources = self.vault / "_System/Integrations/Study Loop/sources"
        sources.mkdir(parents=True)
        (sources / "知学资料.md").write_text("# 词卡\n", encoding="utf-8")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}
            request = urllib.request.Request(
                base + "/v1/pair",
                data=json.dumps({"code": "A1B2C3", "userId": "site-user-001"}).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            paired = json.loads(urllib.request.urlopen(request, timeout=5).read())
            session_headers = {**headers, "X-Study-Loop-Session": paired["sessionToken"]}

            # First scan without a baseline: everything is pending "added".
            request = urllib.request.Request(base + "/v1/changes", headers=session_headers, method="GET")
            payload = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertTrue(payload["scanInitialized"])
            self.assertEqual(len(payload["changes"]), 1)
            change = payload["changes"][0]
            self.assertEqual(change["kind"], "added")

            # Decide and confirm the change disappears from the pending list.
            request = urllib.request.Request(
                base + "/v1/changes/decide",
                data=json.dumps({"changeId": change["changeId"], "decision": "approved", "operator": "site-user-001"}).encode("utf-8"),
                headers=session_headers,
                method="POST",
            )
            result = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(result["decision"], "approved")
            self.assertEqual(result["log"][-1]["operator"], "site-user-001")
            request = urllib.request.Request(base + "/v1/changes", headers=session_headers, method="GET")
            after = json.loads(urllib.request.urlopen(request, timeout=5).read())
            self.assertEqual(after["changes"], [])

            # The old bulk apply endpoint bypassed per-change approval and must
            # not remain callable from the website.
            request = urllib.request.Request(base + "/v1/changes/apply-scan", data=b"{}", headers=session_headers, method="POST")
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_schema_v2_activity_branch_stays_compatible(self) -> None:
        payload = {
            "eventId": "v2-regression-0001",
            "occurredAt": "2026-08-24T09:00:00+08:00",
            "domain": "python",
            "activityType": "practice",
            "title": "v2 回归",
            "outcome": "completed",
            "durationMin": 5,
            "correct": 1,
            "total": 1,
        }
        first = server.accept_activity(payload)
        second = server.accept_activity(payload)
        self.assertEqual(first["event"]["schemaVersion"], 2)
        self.assertTrue(second["duplicate"])

    def test_cross_runtime_core_hash_fixed_vector(self) -> None:
        # Fixed vectors shared with app/study-event-v3.ts (see
        # tests/study-event-v3.test.mjs). If either runtime changes its
        # canonical encoding, both vectors must be regenerated together.
        practice_attempt = {
            "schemaVersion": 3,
            "eventId": "evt-cross-check-001",
            "coreHash": "",
            "occurredAt": "2026-08-24T10:00:00.000Z",
            "domain": "ielts",
            "eventType": "practice-attempt",
            "item": {"kind": "word", "key": "word:alpha", "stateHandle": "opaque-abc"},
            "attempt": {"rating": "good", "correct": True, "stageBefore": 2, "stageAfter": 3},
            "scheduling": {
                "reviewedAt": "2026-08-24T10:00:00.000Z",
                "schedulerVersion": server.SCHEDULER_VERSION,
                "clientStateAfter": {"due": "2030-01-01T00:00:00.000Z", "stability": 999},
            },
        }
        self.assertEqual(
            server.compute_study_event_core_hash(practice_attempt),
            "927607d9f11df9e8f0fcc4b48f52f3fe421a04c9ecbd874b34dc79b2543c314d",
        )
        review_baseline = {
            "schemaVersion": 3,
            "eventId": "baseline:fixed-vector-001",
            "coreHash": "",
            "occurredAt": "2026-08-24T10:00:00.000Z",
            "domain": "ielts",
            "eventType": "review-baseline",
            "item": {"kind": "word", "key": "word:alpha"},
            "schedulerVersion": server.SCHEDULER_VERSION,
            "baselineState": {
                "due": "2026-08-24T10:00:00.000Z",
                "stability": "2.3",
                "difficulty": "4.7",
                "elapsedDays": 0,
                "scheduledDays": 2,
                "learningSteps": 0,
                "reps": 1,
                "lapses": 0,
                "state": 2,
                "lastReview": "2026-08-20T10:00:00.000Z",
            },
        }
        self.assertEqual(
            server.compute_study_event_core_hash(review_baseline),
            "931f82dada2a79bc06604ea60ed917638f24477cae43dc53aa117d1317ed1851",
        )


class ConfigMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.local.json"
        self.original_config = server.CONFIG
        self.original_config_path = server.CONFIG_PATH
        server.CONFIG = {}
        server.CONFIG_PATH = self.config_path

    def tearDown(self) -> None:
        server.CONFIG = self.original_config
        server.CONFIG_PATH = self.original_config_path
        self.temp_dir.cleanup()

    def test_migrates_legacy_model_and_persists_marker(self) -> None:
        self.config_path.write_text('{"deepseek_model": "deepseek-chat"}', encoding="utf-8")
        server.CONFIG = {"deepseek_model": "deepseek-chat"}
        server.migrate_legacy_config()
        self.assertEqual(server.CONFIG["deepseek_model"], "deepseek-v4-flash")
        self.assertTrue(server.CONFIG["deepseek_model_migrated"])
        self.assertEqual(server.load_json(server.CONFIG_PATH)["deepseek_model"], "deepseek-v4-flash")

    def test_marker_preserves_later_explicit_choice(self) -> None:
        server.CONFIG = {"deepseek_model": "deepseek-chat", "deepseek_model_migrated": True}
        server.migrate_legacy_config()
        self.assertEqual(server.CONFIG["deepseek_model"], "deepseek-chat")

    def test_non_legacy_model_is_untouched(self) -> None:
        server.CONFIG = {"deepseek_model": "deepseek-reasoner"}
        server.migrate_legacy_config()
        self.assertEqual(server.CONFIG["deepseek_model"], "deepseek-reasoner")
        self.assertFalse(server.CONFIG_PATH.exists())

    def test_fresh_install_updates_memory_without_writing_file(self) -> None:
        server.CONFIG = {"deepseek_model": "deepseek-chat"}
        server.migrate_legacy_config()
        self.assertEqual(server.CONFIG["deepseek_model"], "deepseek-v4-flash")
        self.assertFalse(server.CONFIG_PATH.exists())


if __name__ == "__main__":
    unittest.main()

