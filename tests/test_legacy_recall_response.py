"""Real legacy HTTP grading with controlled provider bytes, no model calls."""
import copy
import io
import json
import unittest
from unittest import mock

import test_pm_route_compatibility as http_fixture


class LegacyRecallResponseTests(unittest.TestCase):
    def setUp(self):
        self.http = http_fixture.RouteCompatibilityTests()
        self.http.setUp()
        self.addCleanup(self.http.tearDown)
        self.item = {"questionType": "recall", "prompt": "Explain the separation of interface and implementation.",
                     "answer": "The interface states the contract; implementation fulfills it."}
        self.reply = {"verdict": "correct", "feedback": "The required distinction is present.",
                      "matched_points": ["Interface contract"], "missed_points": [], "confidence": 0.8}

    def grade(self, diagnostic=None, *, finish="stop", raw=None):
        import test_companion
        envelope = {"choices": [{"finish_reason": finish,
                                "message": {"role": "assistant", "content": json.dumps(
                                    self.reply if diagnostic is None else diagnostic)}}]}
        stream = io.BytesIO(raw if raw is not None else json.dumps(envelope).encode("utf-8"))
        with mock.patch.object(test_companion.server, "deepseek_key", return_value="synthetic-response-key"), \
                mock.patch.object(test_companion.server, "open_deepseek", return_value=stream):
            status, _, result = self.http.request("POST", "/v1/practice/grade",
                                                {"item": self.item, "answer": "The contract is separate."})
        self.assertEqual(status, 200)
        self.assertTrue(stream.closed)
        return result

    def assert_ungraded(self, result):
        self.assertIsNone(result["correct"])
        self.assertNotIn("rating", result)
        self.assertNotIn(result["verdict"], ("correct", "partial", "wrong"))

    def test_malformed_model_fields_never_become_a_correct_grade(self):
        for changes in ({"feedback": {"text": "Correct"}},
                        {"matched_points": "Interface contract"},
                        {"missed_points": [False]},
                        {"confidence": "0.9"}, {"confidence": True},
                        {"confidence": 1.2}, {"confidence": float("nan")},
                        {"feedback": "Correct", "explanation": "Contradictory alias"}):
            with self.subTest(changes=changes):
                self.assert_ungraded(self.grade({**self.reply, **changes}))

    def test_incomplete_provider_reply_never_becomes_a_grade(self):
        for finish in ("length", "content_filter", "tool_calls", None):
            with self.subTest(finish=finish):
                self.assert_ungraded(self.grade(finish=finish))

    def test_duplicate_response_fields_never_select_the_last_verdict(self):
        content = '{"verdict":"wrong","verdict":"correct","feedback":"Conflict","matched_points":[],"missed_points":[]}'
        raw = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": content}}]}).encode()
        self.assert_ungraded(self.grade(raw=raw))

    def test_reliable_correct_partial_and_wrong_keep_the_legacy_wire_contract(self):
        for verdict, correct, rating in (("correct", True, "good"), ("partial", False, "hard"),
                                         ("wrong", False, "again")):
            with self.subTest(verdict=verdict):
                result = self.grade({**self.reply, "verdict": verdict})
                self.assertEqual((result["correct"], result["verdict"], result["rating"]),
                                 (correct, verdict, rating))
                self.assertEqual(result["matchedPoints"], self.reply["matched_points"])
                self.assertEqual(result["confidence"], 0.8)

    def test_reliable_camel_aliases_keep_the_legacy_wire_contract(self):
        diagnostic = copy.deepcopy(self.reply)
        diagnostic["matchedPoints"] = diagnostic.pop("matched_points")
        diagnostic["missedPoints"] = diagnostic.pop("missed_points")
        diagnostic["explanation"] = diagnostic.pop("feedback")
        self.assertTrue(self.grade(diagnostic)["correct"])

    def test_multiple_choices_tools_refusal_and_secret_echo_remain_ungraded(self):
        good = {"finish_reason": "stop", "message": {"content": json.dumps(self.reply)}}
        envelopes = ({"choices": [good, good]},
                     {"choices": [{**good, "message": {**good["message"], "tool_calls": [{"id": "tool"}]}}]},
                     {"choices": [{**good, "message": {**good["message"], "refusal": "Refused"}}]},
                     {"choices": [{**good, "message": {"content": json.dumps(
                         {**self.reply, "feedback": "synthetic-response-key"})}}]})
        for envelope in envelopes:
            with self.subTest(envelope=envelope):
                self.assert_ungraded(self.grade(raw=json.dumps(envelope).encode()))

    def test_oversized_response_is_refused_without_a_grade(self):
        reply = {**self.reply, "feedback": "x" * 100000}
        self.assert_ungraded(self.grade(reply))

    def test_fenced_json_still_preserves_reliable_legacy_feedback(self):
        content = "```json\n" + json.dumps(self.reply) + "\n```"
        raw = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": content}}]}).encode()
        self.assertTrue(self.grade(raw=raw)["correct"])
