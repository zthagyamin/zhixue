"""QA-only execution gate. Profile/source checks and grading remain in the caller."""
import json
import os
import copy
from datetime import datetime, timezone
from pathlib import Path


def read_verified_profile(read_profile, expected_owner, expected_library, expected_settings_hash, fingerprint):
    owner, library, settings, key, tables = read_profile()
    if (owner != expected_owner or library != expected_library
            or fingerprint(settings) != expected_settings_hash
            or 'native_course_requests' in tables or not key):
        raise ValueError('frozen-profile-or-budget-context-changed')
    return copy.deepcopy(settings), key


def run_resume(preflight, execute, lock_path, *, execute_requested=False):
    state = preflight()
    if not execute_requested or state['status'] != 'ready-for-profile-check':
        return state
    path = Path(lock_path)
    with path.open('x', encoding='utf-8') as lock:
        lock.write(json.dumps({'pid': os.getpid(), 'createdAt': datetime.now(timezone.utc).isoformat()}))
    try:
        current = preflight()
        if current != state:
            raise ValueError('batch-resume-preflight-changed')
        return execute()
    finally:
        path.unlink()
