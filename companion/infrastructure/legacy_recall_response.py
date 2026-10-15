"""Reject incomplete or coercible legacy recall replies before normalization."""
from __future__ import annotations

import re
from application.source_recall_review import validate_source_recall_reply
from infrastructure.code_review_provider import _parse


def parse_legacy_recall_response(raw: bytes, *, secret: str):
    if not isinstance(raw, bytes) or len(raw) > 100000:
        raise ValueError("recall-review-output-limit")
    envelope = _parse(raw)
    choices = envelope.get("choices") if type(envelope) is dict else None
    if type(choices) is not list or len(choices) != 1 or type(choices[0]) is not dict:
        raise ValueError("recall-review-invalid-envelope")
    choice = choices[0]
    message = choice.get("message")
    if (choice.get("finish_reason") != "stop" or type(message) is not dict
            or type(message.get("content")) is not str or message.get("tool_calls")
            or message.get("refusal") or message.get("role", "assistant") != "assistant"):
        raise ValueError("recall-review-incomplete-response")
    content = message["content"].strip()
    if not content or secret and secret in content:
        raise ValueError("recall-review-invalid-content")
    # Preserve fenced JSON compatibility; reject duplicates before coercion.
    content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE)
    content = re.sub(r"\s*```$", "", content)
    return validate_source_recall_reply(_parse(content))
