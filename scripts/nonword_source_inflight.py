"""Optional real source-file change while a deterministic HTTP grade is running."""
from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch


def check_source_inflight(*, source, read, submit, query, items, quiz, quiz_path,
                          formal_count, report):
    import routes_nonword_source

    attempt_id, request_id = 'quiz-inflight', 'quiz-inflight-evaluation'
    before_formal = read('quiz-original')
    before_count = formal_count()
    original_bytes = quiz_path.read_bytes()
    capture = source('capture', query(quiz))
    assert capture['status'] == 'confirmed'
    submission, receipt = submit(attempt_id, capture, quiz['answer'])
    started, release = Event(), Event()
    grade_inputs = []
    factory = routes_nonword_source.create_source_admission

    def controlled_factory(*args, **kwargs):
        store = factory(*args, **kwargs)
        grade = store.grade

        def delayed(item, answer):
            # Invoke the real grader with its original immutable input after release.
            grade_inputs.append((copy.deepcopy(item), copy.deepcopy(answer)))
            started.set()
            assert release.wait(5), 'owned-grade-release-not-observed'
            return grade(item, answer)

        store.grade = delayed
        return store

    with patch.object(routes_nonword_source, 'create_source_admission', controlled_factory):
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(source, 'evaluate', {'attemptId': attempt_id, 'requestId': request_id})
            try:
                assert started.wait(5), 'real-grade-entry-not-observed'
                active = read(attempt_id)
                assert active['submission'] == submission and active['evaluation'] is None
                assert active['activeRequestId'] == request_id
                for competing in (request_id, request_id + '-concurrent'):
                    waiting = source('evaluate', {'attemptId': attempt_id, 'requestId': competing})
                    assert waiting['status'] == 'pending' and waiting['durable'] is False
                assert len(grade_inputs) == 1
                revised = original_bytes.decode('utf-8').replace(
                    '| Earth | Grounded explanation |', '| Mars | Updated source explanation |').encode('utf-8')
                assert revised != original_bytes
                quiz_path.write_bytes(revised)
                updated = next(item for item in items() if item['pluginType'] == 'quiz')
                assert updated['itemId'] == quiz['itemId'] and updated['contentHash'] != quiz['contentHash']
            finally:
                release.set()
            result = pending.result(timeout=5)
            assert result['status'] == 'pending' and result['reason'] == 'source-changed' and result['durable'] is True
            assert source('evaluate', {'attemptId': attempt_id, 'requestId': request_id}) == result
            saved = read(attempt_id)
            assert saved['submission'] == submission and saved['receipt'] == receipt
            assert saved['evaluation'] == result and saved['selfAssessment'] is None
            rejected = source('claim', {'attemptId': attempt_id, 'eventId': 'inflight-no-formal'}, 409)
            assert rejected['error'] == 'source-admission-evaluation-required'
            blocked = source('evaluate', {'attemptId': attempt_id, 'requestId': request_id + '-changed'})
            assert blocked['status'] == 'pending' and len(grade_inputs) == 1
            assert read('quiz-original') == before_formal and formal_count() == before_count
            quiz_path.write_bytes(original_bytes)
            assert source('evaluate', {'attemptId': attempt_id, 'requestId': request_id}) == result
            recovered = source('evaluate', {'attemptId': attempt_id, 'requestId': request_id + '-recovered'})
            assert recovered['status'] == 'resolved' and recovered['correct'] is True
            assert len(grade_inputs) == 2 and grade_inputs[0] == grade_inputs[1]
            assert grade_inputs[0][1] == submission['answer']
            assert read(attempt_id)['submission'] == submission
            assert read('quiz-original') == before_formal and formal_count() == before_count
    assert quiz_path.read_bytes() == original_bytes
    report['sourceInflight'] = dict(actualGradeEntry=True, actualMaterialVersionChange=True,
        immutableOriginalInput=True, competingRequestsWait=True, staleGradePending=True,
        originalAnswerSaved=True, noSelfAssessmentFallback=True, pendingCannotClaim=True,
        pendingRequestImmutable=True, exactRestoreExplicitRecovery=True, originalFormalUnchanged=True,
        deterministicGradeCalls=len(grade_inputs), formalRecordsUnchanged=True)
