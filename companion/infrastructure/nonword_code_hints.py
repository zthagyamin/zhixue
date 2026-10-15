"""Read immutable original/report data; never update evaluation or formal claims."""
from __future__ import annotations

from application.source_code_hint import SourceCodeHintApplication
from infrastructure.nonword_code_reports import evaluation_input_hash
from infrastructure.source_protocol_hash import fingerprint


class SourceCodeHintService(SourceCodeHintApplication):
    def __init__(self, store, review):
        self.store, self.review = store, review
        super().__init__(store.read_attempt, lambda attempt, request: self.review.evaluate(attempt, request), fingerprint)

    def current(self, attempt, request_id):
        latest = self.store.read_attempt(attempt["submission"]["attemptId"])
        return bool(latest and latest["capture"]["status"] == "confirmed"
                    and evaluation_input_hash(latest) == evaluation_input_hash(attempt)
                    and fingerprint(latest["capture"]) == fingerprint(attempt["capture"])
                    and self.store._current(latest["capture"]))
