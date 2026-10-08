"""QA-only limits authorized for this batch; no installed settings are written.

The caller must hold the original exclusive batch lock throughout reservation
and transport, verify the original artifact/profile/scope, and never auto-retry.
"""
import copy
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

MAXIMUM_ATTEMPTS = 10
MAXIMUM_TOKENS = 60000


def verify_ledger(path, expected_paid):
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        rows = db.execute('SELECT owner,library,root,request_id,reserved,budget_day,state '
                          'FROM native_course_requests WHERE reserved>0').fetchall()
        claims = db.execute('SELECT count(*) FROM native_course_claims').fetchone()[0]
    if (len({row[:3] for row in rows}) != 1 or claims != 0
            or len(rows) != len(expected_paid)
            or any(row[6] not in ('pending', 'resolved') for row in rows)
            or {row[3]: (row[4], row[5]) for row in rows} != expected_paid):
        raise ValueError('frozen-followup-ledger-changed')
    return sum(row[4] for row in rows)


def qa_settings(base):
    required = dict(dailyTokenLimit=20000, dailyRequestLimit=10, concurrentLimit=1,
                    maxOutputTokens=2000, revision=0)
    if any(type(base.get(key)) is not int or base[key] != value
           for key, value in required.items()):
        raise ValueError('frozen-followup-profile-changed')
    result = copy.deepcopy(base)
    result['dailyTokenLimit'] = MAXIMUM_TOKENS
    return result


def reserve_cumulative(total, estimate, reserve):
    if (type(total) is not int or total < 0 or type(estimate) is not int
            or estimate < 1 or total + estimate > MAXIMUM_TOKENS):
        raise ValueError('frozen-followup-cumulative-budget')
    actual = reserve()
    if actual != estimate:
        raise ValueError('frozen-followup-reservation-changed')
    return actual


def spend_attempt(path):
    path = Path(path)
    value = json.loads(path.read_text(encoding='utf-8'))
    count = value.get('attempts') if type(value) is dict else None
    if type(count) is not int or count < 0 or count >= MAXIMUM_ATTEMPTS:
        raise ValueError('frozen-followup-call-limit')
    temporary = path.with_suffix('.pending')
    # Unknown interrupted writes must be inspected, never overwritten/reset.
    with temporary.open('x', encoding='utf-8') as output:
        json.dump({'attempts': count + 1}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    return count + 1
