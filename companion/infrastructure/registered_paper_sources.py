"""Bounded, short-lived source locations; never content or authorization facts."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from time import monotonic


@dataclass
class _Snapshot:
    paths: dict[str, str]
    may_extend: bool
    expires_at: float = 0.0


class RegisteredPaperSources:
    """A runtime-owned cache, partitioned by the caller's verified library scope.

    The first lookup stops at its match, preserving early-source lookup cost.
    One later miss may finish a bounded snapshot. Further misses share that
    snapshot until its original expiry, including failures and truncated scans.
    """
    def __init__(self, *, max_scopes=4, max_entries=15000, ttl_seconds=5, clock=monotonic):
        if (type(max_scopes) is not int or max_scopes < 1
                or type(max_entries) is not int or max_entries < 1 or ttl_seconds <= 0):
            raise ValueError("paper-source-lookup-config")
        self._max_scopes = max_scopes
        self._max_entries = max_entries
        self._ttl = ttl_seconds
        self._clock = clock
        self._snapshots = OrderedDict()
        self._lock = RLock()

    def clear(self):
        with self._lock:
            self._snapshots.clear()

    def resolve(self, scope, key, scan):
        with self._lock:
            snapshot = self._snapshots.get(scope)
            if snapshot is None or self._clock() >= snapshot.expires_at:
                snapshot = self._collect(key, scan, stop_at_match=True)
                snapshot.expires_at = self._clock() + self._ttl
                self._snapshots[scope] = snapshot
            elif key not in snapshot.paths and snapshot.may_extend:
                refreshed = self._collect(key, scan, stop_at_match=False)
                refreshed.expires_at = snapshot.expires_at
                snapshot = refreshed
                self._snapshots[scope] = snapshot
            self._snapshots.move_to_end(scope)
            while len(self._snapshots) > self._max_scopes:
                self._snapshots.popitem(last=False)
            result = snapshot.paths.get(key)
            if result is None:
                raise ValueError("paper-source-unavailable")
            return result

    def _collect(self, key, scan, *, stop_at_match):
        paths = {}
        iterator = None
        may_extend = False
        try:
            iterator = iter(scan())
            for _ in range(self._max_entries):
                try:
                    identity, relative_path = next(iterator)
                except StopIteration:
                    break
                paths[identity] = relative_path
                if stop_at_match and identity == key:
                    may_extend = True
                    break
        except (OSError, ValueError):
            # Retain a discovered prefix, but do not retry each miss in this TTL.
            # Every returned path must still pass the consumer's current checks.
            pass
        finally:
            if iterator is not None:
                close = getattr(iterator, "close", None)
                if close is not None:
                    close()
        return _Snapshot(paths, may_extend)
