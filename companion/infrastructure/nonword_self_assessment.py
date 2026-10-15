"""Immutable oral self-assessments; original source authority stays in the capture."""
from __future__ import annotations

import copy
import json
import sqlite3
from application.source_admission import parse_self_assessment
from infrastructure.source_protocol_hash import fingerprint

SCHEMA = '''CREATE TABLE IF NOT EXISTS nonword_source_self_assessments (
    owner TEXT,library TEXT,root TEXT,attempt_id TEXT,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,
    PRIMARY KEY(owner,library,root,attempt_id))'''


def _bound(request, submission):
    return all(request[key] == submission[key]
               for key in ('attemptId', 'binding', 'answerRevision', 'submittedAt'))


def read(db, scope, submission):
    if db is None:
        return None
    try:
        row = db.execute('SELECT payload,payload_hash FROM nonword_source_self_assessments '
            'WHERE owner=? AND library=? AND root=? AND attempt_id=?',
            (*scope, submission['attemptId'])).fetchone()
    except sqlite3.OperationalError as error:
        if 'no such table' in str(error):
            return None
        raise
    if row is None:
        return None
    try:
        value = parse_self_assessment(json.loads(row[0]), scope[0], scope[1])
        if fingerprint(value) != row[1] or not _bound(value, submission):
            raise ValueError('source-admission-integrity')
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError('source-admission-integrity') from error
    return value


def record(store, raw):
    request = parse_self_assessment(raw, store.owner, store.library)
    with store._db(True) as db:
        attempt = store._attempt(db, request['attemptId'])
        if not attempt:
            raise ValueError('source-admission-submission-required')
        if not _bound(request, attempt['submission']):
            raise ValueError('source-admission-self-assessment-binding')
        previous = attempt['selfAssessment']
        if previous and previous != request:
            raise ValueError('source-admission-self-assessment-conflict')
        if not previous:
            if store._claim(db, request['attemptId']):
                raise ValueError('source-admission-claim-conflict')
            capture = attempt['capture']
            if capture['status'] == 'confirmed' and capture['descriptor']['item'].get('questionType') != 'flashcard':
                raise ValueError('source-admission-self-assessment-kind')
            db.execute('INSERT INTO nonword_source_self_assessments VALUES (?,?,?,?,?,?)',
                (*store.scope, request['attemptId'], json.dumps(request, ensure_ascii=False), fingerprint(request)))
            # Explicit evidence cannot silently reuse an older pending/model result.
            # Input hashes and the cleared active request also fence old workers.
            db.execute('UPDATE nonword_source_attempts SET evaluation=NULL,evaluation_request=NULL '
                'WHERE owner=? AND library=? AND root=? AND attempt_id=?', (*store.scope, request['attemptId']))
    return {'schemaVersion': 1, 'durable': True, 'selfAssessment': request,
            'selfAssessmentHash': fingerprint(request)}


def evaluation_input_hash(attempt):
    original = [attempt['submission'], attempt['capture']['binding']['captureId'], attempt['sourceBinding']]
    if attempt.get('selfAssessment') is not None:
        original.append(attempt['selfAssessment'])
    return fingerprint(original)


def evaluation(attempt):
    assessment = attempt.get('selfAssessment')
    mode = attempt['capture']['descriptor']['item'].get('questionType')
    if assessment is not None and mode != 'flashcard':
        return {'status': 'pending', 'reason': 'self-assessment-source-type'}
    if mode != 'flashcard':
        return None
    if assessment is None:
        return {'status': 'pending', 'reason': 'self-assessment-required'}
    rating = assessment['rating']
    return {'status': 'resolved', 'selfAssessment': copy.deepcopy(assessment),
            'correct': rating in ('good', 'easy'),
            'outcome': 'incorrect' if rating == 'again' else 'partial' if rating == 'hard' else 'correct',
            'explanation': '用户主动自评为' + {'again': '忘记', 'hard': '困难', 'good': '良好', 'easy': '极易'}[rating] + '。'}


def original_rating(attempt, result):
    expected = evaluation(attempt)
    if expected is None:
        if result.get('selfAssessment') is not None:
            raise ValueError('source-admission-integrity')
        return None
    if expected['status'] != 'resolved' or any(result.get(key) != value for key, value in expected.items()):
        raise ValueError('source-admission-self-assessment-required')
    return expected['selfAssessment']['rating']
