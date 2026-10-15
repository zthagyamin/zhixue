"""Durable local hint calls against actual captured code and saved reports."""
import copy
import io
import json
import sqlite3
import sys
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "companion"), str(Path(__file__).parent)]
import test_nonword_code_reports as fixtures
from infrastructure.source_code_hint_adapter import create_source_code_hint


class SourceCodeHintTests(unittest.TestCase):
    def setUp(self):
        self.h = fixtures.CodeReportStoreTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        from infrastructure.nonword_source_store import SourceAdmissionStore
        from vault_identity import local_vault_library_id
        original = self.h.h.store
        self.store = SourceAdmissionStore(original.path, original.owner, local_vault_library_id(original.root_reference),
                                         original.root_reference, original.resolver, original.grade, original.now)
        capture = self.store.capture(self.h.h.query)
        self.h.submission = {**self.h.submission, "binding": capture["binding"]}
        self.store.submit(self.h.submission)
        self.report = self.store.record_code_report(self.h.request())
        self.settings = {"enabled": True, "configured": True, "provider": "deepseek", "model": "synthetic",
                         "baseUrl": "https://api.deepseek.com", "revision": 0, "maxOutputTokens": 1000,
                         "dailyTokenLimit": 30000, "dailyRequestLimit": 10, "concurrentLimit": 1}
        self.database = self.store.path.with_name("shared-hint.db")
        self.calls = []
        self.error = None
        self.diagnostic = {"text": "Check how the return value relates to both arguments.",
                           "sourceQuote": "Implement add.", "codeQuote": "return 4",
                           "reason": "The saved public case expects the sum of the arguments."}
        self.services = SimpleNamespace(LOCAL_DATABASE_PATH=self.database,
            ai_store=lambda db: SimpleNamespace(snapshot=lambda owner, library: (copy.deepcopy(self.settings), "synthetic-hint-key")),
            source_path=lambda name: self.store.root_reference)
        self.app = self.create()
        self.request = {"attemptId": "code-original", "requestId": "hint-original", "reportId": self.report["reportId"]}

    def create(self):
        return create_source_code_hint(self.services, self.store.owner, self.store.library,
                                       self.store.root_reference, self.store, transport=self.transport)

    def transport(self, request, timeout):
        self.calls.append(json.loads(request.data))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT state FROM nonword_hint_jobs WHERE job_id=?",
                                       (request.get_header("Idempotency-key"),)).fetchone()[0], "dispatched")
        if self.error:
            raise self.error
        return io.BytesIO(json.dumps({"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps(self.diagnostic)}}], "usage": {"total_tokens": 20}}).encode())

    def hint(self, **updates):
        return self.app.request({**self.request, **updates})

    def test_saved_original_known_reply_replays_without_grade_or_second_dispatch(self):
        before = self.store.read_attempt("code-original")
        first = self.hint()
        self.assertEqual(first["status"], "ready")
        self.assertEqual(first["hint"], self.diagnostic)
        self.assertEqual(first["binding"], self.h.submission["binding"])
        self.assertEqual(self.hint(), first)
        self.app = self.create()
        self.assertEqual(self.hint(requestId="after-reopen")["hint"], first["hint"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.store.read_attempt("code-original"), before)
        with self.assertRaises(ValueError):
            self.store.claim({"attemptId": "code-original", "eventId": "no-grade"})
        self.assertIn(self.h.submission["answer"], self.calls[0]["messages"][1]["content"])

    def test_unknown_dispatch_is_not_repeated_under_new_request_id_or_restart(self):
        self.error = TimeoutError("Synthetic lost reply")
        self.assertEqual(self.hint()["status"], "pending")
        self.app = self.create()
        self.assertEqual(self.hint(requestId="after-reopen")["status"], "pending")
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(self.store.read_attempt("code-original")["evaluation"])

    def test_wrong_report_or_changed_source_cannot_call_a_model(self):
        with self.assertRaises(ValueError):
            self.hint(reportId="code-report:" + "0" * 64)
        self.h.h.source.write_text(self.h.h.source.read_text() + "\nChanged source.")
        self.assertEqual(self.hint()["status"], "pending")
        self.assertEqual(self.calls, [])

    def test_malformed_or_ungrounded_hint_is_pending_and_not_retried(self):
        for changes in ({"sourceQuote": "Invented reference"}, {"codeQuote": "Invented code"},
                        {"text": "```def add(a,b): return a+b```"}, {"text": {"hint": "Check"}}):
            with self.subTest(changes=changes):
                self.diagnostic.update(changes)
                self.assertEqual(self.hint()["status"], "pending")
                self.assertEqual(self.hint(requestId="another")["status"], "pending")
        self.assertEqual(len(self.calls), 1)

    def test_shared_daily_limit_blocks_hint_before_transport(self):
        from infrastructure.code_review_ledger import CodeReviewLedger
        from test_code_review_provider import prepare_code_review
        ledger = CodeReviewLedger(self.database, self.store.owner, self.store.library, self.store.root_reference)
        settings = {**self.settings, "dailyRequestLimit": 1}
        ticket = ledger.begin("prior-code", prepare_code_review(self.store.read_attempt("code-original")), settings)
        ledger.reserve(ticket)
        ledger.dispatch(ticket)
        self.settings["dailyRequestLimit"] = 1
        result = self.hint()
        self.assertEqual(result["status"], "pending")
        self.assertIn("budget", result["reason"])
        self.assertEqual(self.calls, [])

    def test_foreign_scope_request_cannot_read_or_dispatch_original(self):
        from infrastructure.nonword_source_store import SourceAdmissionStore
        foreign = SourceAdmissionStore(self.store.path, "foreign-owner", self.store.library, self.store.root_reference,
                                       self.store.resolver, self.store.grade, self.store.now)
        app = create_source_code_hint(self.services, foreign.owner, foreign.library,
                                      foreign.root_reference, foreign, transport=self.transport)
        with self.assertRaises(ValueError):
            app.request(self.request)
        self.assertEqual(self.calls, [])

    def test_unconfigured_preflight_can_recover_after_explicit_new_request(self):
        self.settings["enabled"] = False
        self.assertEqual(self.hint()["status"], "pending")
        self.assertEqual(self.calls, [])
        self.settings["enabled"] = True
        self.assertEqual(self.hint(requestId="explicit-configured-retry")["status"], "ready")
        self.assertEqual(len(self.calls), 1)

    def test_known_provider_rejection_can_recover_after_explicit_new_request(self):
        from urllib.error import HTTPError
        self.error = HTTPError("https://synthetic.example", 429, "Synthetic rejection", {}, None)
        self.assertEqual(self.hint()["reason"], "hint-review-provider-rejected")
        self.error = None
        self.assertEqual(self.hint(requestId="explicit-known-rejection-retry")["status"], "ready")
        self.assertEqual(len(self.calls), 2)

    def test_shared_request_and_receipt_fixture_has_identical_python_acceptance(self):
        from application.source_code_hint import parse_hint_request, parse_hint_receipt
        fixture = json.loads((Path(__file__).parent / "fixtures/source-code-hint-v1.json").read_text())
        for key, parser in (("requestCases", parse_hint_request), ("receiptCases", parse_hint_receipt)):
            for row in fixture[key]:
                with self.subTest(name=row["name"]):
                    if row["valid"]:
                        self.assertEqual(parser(row["input"]), row["input"])
                    else:
                        with self.assertRaises(ValueError):
                            parser(row["input"])

    def test_changed_source_during_known_reply_keeps_hint_private(self):
        original = self.transport
        def changed(request, timeout):
            response = original(request, timeout)
            self.h.h.source.write_text(self.h.h.source.read_text() + "\nChanged while waiting.")
            return response
        self.app = create_source_code_hint(self.services, self.store.owner, self.store.library,
                                          self.store.root_reference, self.store, transport=changed)
        result = self.hint()
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("hint", result)
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(self.store.read_attempt("code-original")["evaluation"])

    def test_new_report_after_known_hint_is_a_separate_explicit_request(self):
        self.assertEqual(self.hint()["status"], "ready")
        newer = self.store.record_code_report(self.h.request(self.h.report(run=2)))
        self.assertEqual(self.hint(requestId="new-report-hint", reportId=newer["reportId"])["status"], "ready")
        self.assertEqual(len(self.calls), 2)
        with self.assertRaises(ValueError):
            self.hint()

    def test_hint_reservation_counts_against_other_review_families_and_libraries(self):
        from infrastructure.code_review_ledger import ReviewJobLedger
        from test_code_review_provider import prepare_code_review
        self.assertEqual(self.hint()["status"], "ready")
        data = prepare_code_review(self.store.read_attempt("code-original"))
        for binding in ("binding", "sourceBinding"):
            data[binding]["libraryId"] = "another-library"
        ledger = ReviewJobLedger(self.database, self.store.owner, "another-library",
                                 self.store.root_reference, family="recall")
        ticket = ledger.begin("another-review", data, {**self.settings, "dailyRequestLimit": 1})
        with self.assertRaisesRegex(ValueError, "daily-budget"):
            ledger.reserve(ticket)

    def test_complete_assignment_implementation_never_becomes_a_saved_hint(self):
        self.diagnostic["text"] = "add = lambda a, b: a + b"
        result = self.hint()
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("hint", result)
        self.assertIsNone(self.store.read_attempt("code-original")["evaluation"])
