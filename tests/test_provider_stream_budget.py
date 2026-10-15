"""Ignored SSE data must still consume a finite response budget."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import study_ai_provider as ai


class ProviderStreamBudgetTests(unittest.TestCase):
    def test_shared_byte_budget_and_cases_match_the_real_decoder(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/provider-stream-budget-v1.json").read_text(encoding="utf-8"))
        self.assertEqual(ai.MAX_STREAM_RESPONSE_BYTES, fixture["maxResponseBytes"])
        ending = b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        for row in fixture["cases"]:
            with self.subTest(name=row["name"]):
                if row["kind"] == "comment":
                    frame = (":" + "x" * row["size"] + "\n\n").encode()
                else:
                    delta = {"reasoning_content": "x" * row["size"]} if row["kind"] == "hidden" else {"content": row["text"]}
                    frame = ("data: " + json.dumps({"choices": [{"delta": delta}]}, ensure_ascii=False,
                                                   separators=(",", ":")) + "\n\n").encode()
                raw = frame * row["repeat"] + ending
                if row["reject"]:
                    with self.assertRaisesRegex(ValueError, "ai-stream-limit"):
                        self.stream(raw)
                else:
                    self.assertEqual(self.stream(raw)[0], {"type": "delta", "text": row["text"]})
    def stream(self, raw):
        settings = {"provider": "deepseek", "model": "synthetic", "baseUrl": ai.DEFAULT_BASES["deepseek"],
                    "revision": 0, "maxOutputTokens": 500}
        request = {"provider": "deepseek", "model": "synthetic", "settingsRevision": 0,
                   "context": {"id": "synthetic", "title": "Synthetic task"},
                   "messages": [{"role": "user", "content": "Explain the task."}]}
        response = io.BytesIO(raw)
        with mock.patch.object(ai, "open_request", return_value=response):
            try:
                return list(ai.stream_chat(settings, "synthetic-stream-key", request))
            finally:
                self.assertTrue(response.closed)

    def test_hidden_reasoning_bytes_cannot_bypass_response_budget(self):
        frame = ("data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "x" * 240000}}]}) + "\n\n").encode()
        ending = b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        with self.assertRaisesRegex(ValueError, "ai-stream-limit"):
            self.stream(frame * 36 + ending)

    def test_nondata_heartbeats_cannot_bypass_response_budget(self):
        with self.assertRaisesRegex(ValueError, "ai-stream-limit"):
            self.stream((b":" + b"x" * 240000 + b"\n\n") * 36 +
                        b'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

    def test_normal_unicode_content_and_finish_remain_unchanged(self):
        raw = ("data: " + json.dumps({"model": "synthetic", "choices": [{"delta": {"content": "你好，world。"}}]},
                                     ensure_ascii=False) + "\n\n").encode()
        raw += b'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n'
        self.assertEqual(self.stream(raw), [{"type": "delta", "text": "你好，world。"},
            {"type": "done", "model": "synthetic", "provider": "deepseek", "usageTokens": 12}])
