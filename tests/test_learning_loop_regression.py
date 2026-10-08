"""End-to-end evidence/queue regressions against disposable learning vaults."""
import json
import unittest
import subprocess
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import test_companion as fixtures
import review_queue
import state_projection
import practice_engine


class LearningLoopRegressionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompanionSyncTests()
        self.fixture.setUp()
        self.vault = self.fixture.vault
        self.state_ref = "01 学习/专项课程/Test/学习记录/第01讲 学习状态.md"

    def tearDown(self):
        self.fixture.tearDown()

    def card(self, name, ability, state_ref=None, domain="course"):
        ref = state_ref or self.state_ref
        return self.fixture.write(
            f"01 学习/学习结果/{name}.md",
            f'---\ntype: learning-result\ndomain: {domain}\nitem_id: {name}\nability_id: {ability}\n'
            f'review_enabled: true\nreview_date: 2026-08-01\nsource_note: "[[{ref}]]"\nstate_ref: "[[{ref}]]"\n'
            f'---\n# {name}\n\n复习要点：\n- point-{ability}\n',
        )

    def accept(self, payload):
        with fixtures.server.local_database() as db:
            return fixtures.server.accept_study_event_v3(db, self.vault, "test-account", payload)

    def test_each_learning_domain_retains_evidence_without_promoting_mastery(self):
        for index, note_type in enumerate(["paper-note", "project", "review", "learning-state"]):
            with self.subTest(note_type=note_type):
                ref = f"state-{note_type}.md"
                original = f"---\ntype: {note_type}\nstatus: active\nmastery: developing\n---\n# State\n\n- ability-a\n"
                path = self.fixture.write(ref, original)
                payload = self.fixture.make_v3_activity(f"domain-regression-{index}", state_ref=ref, ability_id="ability-a")
                result = self.accept(payload)
                self.assertEqual(result["status"], "accepted")
                self.assertTrue(result["companionReceipt"]["durable"])
                self.assertEqual(self.fixture.count_jsonl_event(payload["event"]["eventId"]), 1)
                text = path.read_text(encoding="utf-8")
                self.assertTrue(text.startswith(original.split('# State')[0]))
                self.assertIn('- ability-a', text)
                self.assertIn(state_projection.EVIDENCE_BEGIN, text)
                self.assertNotIn("mastered", text)

    def test_generated_question_updates_only_its_exact_state_and_ability_card(self):
        self.card("card-a", "ability-a")
        self.card("card-b", "ability-b")
        result = self.accept(self.fixture.make_v3_activity(
            "precise-card-regression", rating="again", state_ref=self.state_ref,
            ability_id="ability-b", item_key="practice:new-question-b"))
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(review_queue.read_queue(self.vault, "01 学习/学习结果/card-a.md"), [])
        self.assertEqual(len(review_queue.read_queue(self.vault, "01 学习/学习结果/card-b.md")), 1)

    def test_state_only_lookup_does_not_choose_an_arbitrary_ability(self):
        self.card("card-a", "ability-a")
        self.card("card-b", "ability-b")
        self.assertIsNone(state_projection.result_card_for_state(self.vault, self.state_ref, "unknown-question"))

    def test_explicit_card_id_cannot_override_a_conflicting_state_target(self):
        self.card('card-a','ability-a')
        self.assertIsNone(state_projection.result_card_for_state(self.vault,'different-state.md','card-a','ability-a'))

    def test_practice_payload_resolves_wikilink_paths_for_every_frontend_entry(self):
        self.fixture.write('paper.md','---\ntype: paper-note\n---\n# Paper\n')
        self.card('paper-q','paper-ability','paper',domain='paper')
        item=practice_engine.practice_items(self.vault)[0]
        self.assertEqual(item['sourceNote'],'paper.md')
        self.assertEqual(item['stateRef'],'paper.md')

    def test_card_conflict_remains_pending_and_retry_applies_exactly_once(self):
        self.card("card-a", "ability-a")
        payload = self.fixture.make_v3_activity(
            "retry-card-regression", state_ref=self.state_ref, ability_id="ability-a", item_key="practice:card-a")
        with mock.patch.object(review_queue, "apply_result", side_effect=ValueError("stale-vault-edit")):
            first = self.accept(payload)
        self.assertEqual(first.get("projectionStatus"), "pending")
        self.assertTrue(first["companionReceipt"]["durable"])
        second = self.accept(payload)
        self.assertEqual(second.get("projectionStatus"), "applied")
        third = self.accept(payload)
        self.assertEqual(third["status"], "duplicate")
        queue = review_queue.read_queue(self.vault, "01 学习/学习结果/card-a.md")
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["attempts"], 1)
        self.assertEqual(self.fixture.count_jsonl_event(payload["event"]["eventId"]), 1)

    def test_queue_replay_is_idempotent_even_before_database_receipt_is_saved(self):
        self.card("card-a", "ability-a")
        kwargs = dict(vault_root=self.vault, card_path="01 学习/学习结果/card-a.md",
                      item={"name": "point-ability-a"}, rating="good", event_id="replay-regression")
        review_queue.apply_result(**kwargs)
        review_queue.apply_result(**kwargs)
        queue = review_queue.read_queue(self.vault, "01 学习/学习结果/card-a.md")
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["attempts"], 1)

    def test_companion_preserves_unspecified_python_quiz_family(self):
        subject = {"id": "python", "name": "Python 基础知识", "pluginType": "quiz",
                   "items": [{"itemId": "py-1", "topic": "变量", "prompt": "What is a variable?"}]}
        actual = fixtures.server.normalize_question_subjects({"subjects": [subject]})
        self.assertEqual(actual["subjects"], [subject])

    def test_companion_keeps_different_questions_with_the_same_ability(self):
        subjects = [{"id": "reading-comprehension", "name": "Reading", "domain": "ielts", "pluginType": "quiz",
                     "items": [{"itemId": "q1", "abilityId": "shared", "prompt": "First?"},
                               {"itemId": "q2", "abilityId": "shared", "prompt": "Second?"}]}]
        actual = fixtures.server.normalize_question_subjects({"subjects": subjects})
        self.assertEqual([i["itemId"] for i in actual["subjects"][0]["items"]], ["q1", "q2"])

    def test_http_snapshot_to_frontend_plan_to_paper_writeback_roundtrip(self):
        paper = self.fixture.write("paper.md", "---\ntype: paper-note\nstatus: active\n---\n# Paper\n\n- paper-ability\n")
        self.card("paper-q1", "paper-ability", "paper.md", domain="paper")
        fixtures.server.CONFIG["allowed_origins"] = ["http://127.0.0.1:3080"]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), fixtures.server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        headers = {"Origin": "http://127.0.0.1:3080", "Content-Type": "application/json"}

        def request(path, payload=None):
            req = urllib.request.Request(base + path, headers=headers,
                data=None if payload is None else json.dumps(payload).encode("utf-8"))
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read())

        try:
            headers["X-Study-Loop-Session"] = request("/v1/pair", {"code": "A1B2C3", "userId": "isolated-test-user"})["sessionToken"]
            state = {"status": "key_missing", "contentMode": "demo", "subjects": [{"id":"demo-only","name":"Demo","pluginType":"quiz","items":[{"topic":"demo"}]}], "source": {"title": "Test"}}
            with mock.patch.object(fixtures.server, "STATE", state), mock.patch.object(fixtures.server, "connection_state", return_value=[]):
                snapshot = request("/v1/study-data")
            self.assertEqual([item["itemId"] for item in snapshot["practiceItems"]], ["paper-q1", "due:TEST:1:1", "due:TEST:1:2"])
            self.assertEqual(snapshot["contentMode"], "personal")
            self.assertNotIn("demo-only", [subject["id"] for subject in snapshot["subjects"]])
            js = r"""
import {buildPlanInput} from './app/plan-input-builder.ts';
import {generateDailyPlan} from './app/daily-plan.ts';
import {studySubjectsWithPractice,selectPlannedPractice} from './app/plan-runtime.ts';
let raw=''; for await (const part of process.stdin) raw+=part;
const snapshot=JSON.parse(raw);
const subjects=studySubjectsWithPractice(snapshot.subjects,snapshot.practiceItems);
const candidate=await generateDailyPlan(buildPlanInput({day:'2026-08-31',subjects,duePractice:snapshot.practiceItems}));
const item=selectPlannedPractice(candidate.items.find(entry=>entry.itemKey==='practice:paper-q1'),subjects,snapshot.practiceItems)[0];
console.log(JSON.stringify({candidate,item}));
"""
            run = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", js],
                input=json.dumps(snapshot), text=True, encoding="utf-8", capture_output=True,
                cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
            frontend = json.loads(run.stdout)
            applied = request("/v1/plan/apply", {"candidate": frontend["candidate"], "expectedRevision": 0, "operator": "test"})
            self.assertEqual(applied["revision"]["revision"], 1)
            item = frontend["item"]
            payload = self.fixture.make_v3_activity("http-paper-loop", state_ref="paper.md",
                ability_id=item["abilityId"], item_key="practice:" + item["itemId"], rating="again")
            payload["event"]["domain"] = "differential-review"
            payload["event"]["item"]["kind"] = "due"
            payload["event"]["coreHash"] = fixtures.server.compute_study_event_core_hash(payload["event"])
            result = request("/v1/activity", payload)
            self.assertEqual(result["projectionStatus"], "applied")
            self.assertEqual(request("/v1/activity", payload)["status"], "duplicate")
            self.assertEqual(len(review_queue.read_queue(self.vault, "01 学习/学习结果/paper-q1.md")), 1)
            self.assertEqual(self.fixture.count_jsonl_event("http-paper-loop"), 1)
            self.assertIn("status: active", paper.read_text(encoding="utf-8"))
            current = request("/v1/plan/current")["candidate"]
            self.assertEqual(current["items"][0]["practice"]["itemIds"], ["paper-q1"])
        finally:
            httpd.shutdown()
            httpd.server_close()
