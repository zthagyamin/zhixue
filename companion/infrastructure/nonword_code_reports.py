"""Append-only client declarations, not independent server execution evidence."""
from __future__ import annotations

import json
import sqlite3
from application.source_code_report import parse_request, validate_source as validate_declaration_source
from learning_support import parse_code_learning_support_v1
from infrastructure.nonword_self_assessment import evaluation_input_hash as original_input_hash
from infrastructure.source_protocol_hash import fingerprint

MAX_PUBLIC_BYTES = 350000
def validate_source(request,capture):
    return validate_declaration_source(request,capture,parse_code_learning_support_v1)

SCHEMA = '''CREATE TABLE IF NOT EXISTS nonword_source_code_reports (
    owner TEXT,library TEXT,root TEXT,report_id TEXT,attempt_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(owner,library,root,report_id),
    UNIQUE(owner,library,root,attempt_id,ordinal))'''


def _bound(request, submission):
    return all(request[key] == submission[key] for key in ('attemptId', 'binding', 'answerRevision', 'submittedAt'))


def _receipt(request):
    digest = fingerprint(request)
    return {'schemaVersion': 1, 'durable': True, 'reportId': 'code-report:' + digest,
            'evidence': request, 'evidenceHash': digest, 'provenance': 'client-public-tests'}


def read(db, scope, submission):
    if db is None:
        return []
    try:
        rows = db.execute('SELECT report_id,ordinal,payload,payload_hash FROM nonword_source_code_reports '
            'WHERE owner=? AND library=? AND root=? AND attempt_id=? ORDER BY ordinal',
            (*scope, submission['attemptId'])).fetchall()
    except sqlite3.OperationalError as error:
        if 'no such table' in str(error):
            return []
        raise
    reports = []
    for ordinal, row in enumerate(rows, 1):
        try:
            receipt = json.loads(row[2])
            request = parse_request(receipt['evidence'], scope)
            if (row[1] != ordinal or row[0] != receipt['reportId'] or not _bound(request, submission)
                    or receipt != _receipt(request) or fingerprint(receipt) != row[3]):
                raise ValueError('source-admission-integrity')
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError('source-admission-integrity') from error
        reports.append(receipt)
    return reports


def record(store, raw):
    request = parse_request(raw, store.scope)
    receipt = _receipt(request)
    with store._db(True) as db:
        attempt = store._attempt(db, request['attemptId'])
        if not attempt:
            raise ValueError('source-admission-submission-required')
        if not _bound(request, attempt['submission']):
            raise ValueError('source-admission-code-report-binding')
        previous = attempt['codeReports']
        same = next((row for row in previous if row['reportId'] == receipt['reportId']), None)
        if same:
            return same
        if store._claim(db, request['attemptId']) or attempt['evaluation'] and attempt['evaluation']['status'] == 'resolved':
            raise ValueError('source-admission-code-report-fixed')
        validate_source(request, attempt['capture'])
        total = sum(len(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
                    for row in [*previous, receipt])
        if total > MAX_PUBLIC_BYTES:
            raise ValueError('source-admission-code-report-limit')
        db.execute('INSERT INTO nonword_source_code_reports VALUES (?,?,?,?,?,?,?,?)',
            (*store.scope, receipt['reportId'], request['attemptId'], len(previous) + 1,
             json.dumps(receipt, ensure_ascii=False), fingerprint(receipt)))
        db.execute('UPDATE nonword_source_attempts SET evaluation=NULL,evaluation_request=NULL '
            'WHERE owner=? AND library=? AND root=? AND attempt_id=?', (*store.scope, request['attemptId']))
    return receipt


def evaluation_input_hash(attempt):
    original = original_input_hash(attempt)
    return fingerprint([original, attempt['codeReports']]) if attempt.get('codeReports') else original


def review_current(store, attempt, request_id):
    with store._db() as db:
        latest = store._attempt(db,attempt['submission']['attemptId'])
        return bool(latest and latest['evaluationRequest']==request_id
                    and evaluation_input_hash(latest)==evaluation_input_hash(attempt)
                    and store._current(latest['capture']))


def evaluation(attempt, review=None, request_id=None):
    if attempt['capture']['descriptor']['item'].get('questionType') == 'code':
        if callable(review):
            try: return review(attempt,request_id)
            except Exception: return {'status':'pending','reason':'code-review-unavailable'}
        return {'status': 'pending', 'reason': 'specialist-evaluation-required'}
    if attempt.get('codeReports'):
        return {'status': 'pending', 'reason': 'code-report-source-type'}
    return None
