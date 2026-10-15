"""A temporary grounded hint is not a grade or proof of server execution."""
from __future__ import annotations

import re
from application.code_review import prepare_code_review
from application.source_admission import fields, identifier, digest, parse_binding


def parse_hint_request(raw):
    value = fields(raw, ("attemptId", "requestId", "reportId"))
    identifier(value["attemptId"])
    identifier(value["requestId"])
    if type(value["reportId"]) is not str or not re.fullmatch(r"code-report:[0-9a-f]{64}", value["reportId"]):
        raise ValueError("source-admission-code-hint-report")
    return value


def prepare_code_hint(attempt, *, parse_support):
    data = prepare_code_review(attempt, parse_support=parse_support)
    report = data["codeReports"][-1]["evidence"]["report"]
    if report["outcome"] != "student-error" or not report.get("firstFailure"):
        raise ValueError("hint-review-attributable-failure-required")
    return data


def hint_fields(raw):
    hint = fields(raw, ("text", "sourceQuote", "codeQuote", "reason"))
    for field, maximum in (("text", 300), ("sourceQuote", 1000), ("codeQuote", 1000), ("reason", 1000)):
        text = hint[field]
        if type(text) is not str or not text.strip() or text != text.strip() or len(text) > maximum:
            raise ValueError("hint-review-invalid-output")
    if ("```" in hint["text"] or re.search(r"(?m)^\s*(?:async\s+)?(?:def|class)\s+", hint["text"])
            or re.search(r"(?m)^\s*\w+\s*=\s*lambda\b", hint["text"])):
        raise ValueError("hint-review-complete-code")
    return hint


def normalize_code_hint(raw, data):
    hint = hint_fields(raw)
    if (not any(hint["sourceQuote"] in unit for unit in data["referenceUnits"].values())
            or hint["codeQuote"] not in data["answer"]):
        raise ValueError("hint-review-ungrounded-output")
    return {"status": "resolved", "hint": hint}


def parse_hint_receipt(raw):
    status = raw.get("status") if type(raw) is dict else None
    if status not in ("ready", "pending"):
        raise ValueError("source-admission-code-hint-status")
    r = fields(raw, ("schemaVersion", "durable", "requestId", "attemptId", "binding", "sourceBinding",
                     "answerRevision", "answerHash", "reportId", "status", "receiptHash",
                     "hint" if status == "ready" else "reason"))
    if type(r["schemaVersion"]) is not int or r["schemaVersion"] != 1 or r["durable"] is not True:
        raise ValueError("source-admission-code-hint-receipt")
    parse_hint_request({key: r[key] for key in ("attemptId", "requestId", "reportId")})
    if type(r["binding"]) is not dict:
        raise ValueError("source-admission-code-hint-binding")
    scope = r["binding"].get("ownerId"), r["binding"].get("libraryId")
    r["binding"] = parse_binding(r["binding"], *scope)
    r["sourceBinding"] = parse_binding(r["sourceBinding"], *scope)
    digest(r["answerHash"]); digest(r["receiptHash"])
    if type(r["answerRevision"]) is not int or r["answerRevision"] < 0:
        raise ValueError("source-admission-code-hint-revision")
    if status == "ready":
        r["hint"] = hint_fields(r["hint"])
    elif type(r["reason"]) is not str or not r["reason"].strip() or r["reason"] != r["reason"].strip() or len(r["reason"]) > 1000:
        raise ValueError("source-admission-code-hint-reason")
    return r


class SourceCodeHintApplication:
    def __init__(self, read, evaluate, fingerprint):
        self.read, self.evaluate, self.fingerprint = read, evaluate, fingerprint

    def request(self, raw):
        request = parse_hint_request(raw)
        attempt = self.read(request["attemptId"])
        if not attempt:
            raise ValueError("source-admission-submission-required")
        reports = attempt.get("codeReports")
        if not reports or reports[-1]["reportId"] != request["reportId"]:
            raise ValueError("source-admission-code-hint-report")
        if attempt["capture"]["status"] != "confirmed":
            raise ValueError("source-admission-source-unverified")
        outcome = self.evaluate(attempt, request["requestId"])
        ready = outcome.get("status") == "resolved"
        body = {"schemaVersion": 1, "durable": True, **request, "binding": attempt["binding"],
                "sourceBinding": attempt["sourceBinding"],
                "answerRevision": attempt["submission"]["answerRevision"],
                "answerHash": self.fingerprint(attempt["submission"]["answer"]),
                "status": "ready" if ready else "pending"}
        if ready:
            body["hint"] = outcome["hint"]
        else:
            body["reason"] = outcome.get("reason", "hint-review-unavailable")
        return parse_hint_receipt({**body, "receiptHash": self.fingerprint(body)})
