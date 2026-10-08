"""Stable Companion operation failures, independent of response encoding."""
from __future__ import annotations


class CompanionFailure(Exception):
    def __init__(self, status: int, payload: dict):
        super().__init__(str(payload.get('message', payload.get('error', 'operation-failed'))))
        self.status = status
        self.payload = payload


class SourceStorageFailure(Exception):
    def __init__(self, message: str, no_write: bool = False):
        super().__init__(message)
        self.no_write = no_write
