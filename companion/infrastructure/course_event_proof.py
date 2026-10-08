"""Native V3 admission reads a trusted original course claim; it never grades."""
from __future__ import annotations

from account_sync_schema import study_hash
from course_study_domain import resolve_course_task, validate_course_diagnostic
from infrastructure.course_grade_ledger import CourseGradeLedger
from infrastructure.course_source_capture import NativeCourseSources
from vault_identity import local_vault_library_id


def _is_current_course(catalog, key):
    for subject in catalog.get('subjects', []):
        for item in subject.get('items', []):
            if 'practice:' + str(item.get('itemId')) != key:
                continue
            support = item.get('learningSupport') or (item.get('practiceItem') or {}).get('learningSupport')
            return (not item.get('word') and item.get('kind') != 'word'
                    and item.get('eventKind') != 'word' and isinstance(support, dict)
                    and support.get('schemaVersion') == 2 and support.get('type') in ('recall', 'quiz'))
    return False


def native_course_event_guard(database, vault_root, owner, event, catalog, *, catalog_loader,
                              store_path):
    """Return a read-only recheck for the existing journal/projection transaction.

    Historical exact V3 duplicates keep their prior meaning. New course events
    require a durable first-attempt claim; all scheduling/writes remain in V3.
    """
    prior = database.execute('SELECT core_hash FROM study_events_v3 WHERE account_id=? AND event_id=?',
                             (owner, event['eventId'])).fetchone()
    if prior:
        # The old writer owns exact duplicates and conflicting-core diagnostics.
        # This new interlock must not bypass its counters or frozen replay route.
        return None
    current_course = _is_current_course(catalog, event['item']['key'])
    claims_exist = database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_course_claims'").fetchone()
    has_claim = claims_exist and database.execute('SELECT 1 FROM native_course_claims WHERE owner=? AND event_id=?',
                                                  (owner, event['eventId'])).fetchone()
    if not current_course and not has_claim:
        return None
    library = local_vault_library_id(vault_root)
    if not library:
        if current_course:
            raise ValueError('native-course-formal-source-unavailable')
        return None
    ledger = CourseGradeLedger(store_path, owner, library, vault_root)
    aggregate = ledger.read_claim_by_event(event['eventId'])
    if aggregate is None:
        if current_course or has_claim:
            raise ValueError('native-course-formal-claim-required')
        return None
    request, receipt, claim = aggregate['request'], aggregate['receipt'], aggregate['claim']
    if (event.get('eventType') != 'practice-attempt' or event['item'].get('kind') == 'word' or request['purpose'] != 'first'
            or request['parentAttemptId'] is not None or request['attemptId'] != claim['attemptId']
            or request['binding'] != claim['binding'] or request['identity'] != claim['identity']
            or request['captureId'] != claim['captureId']
            or event['item']['key'] != request['binding']['itemKey']
            or event['attempt']['rating'] != claim['rating']
            or event['occurredAt'] != claim['occurredAt']
            or (event.get('scheduling') or {}).get('reviewedAt', event['occurredAt']) != claim['occurredAt']
            or claim['occurredAt'] != request['submission']['submittedAt']
            or receipt['diagnostic']['status'] == 'undetermined'
            or claim['diagnosticHash'] != receipt['diagnosticHash']
            or claim['attemptEvaluationHash'] != receipt['attemptEvaluationHash']
            or aggregate['claimReceipt']['claimHash'] != study_hash(claim)):
        raise ValueError('native-course-formal-evidence-conflict')
    if event['attempt']['correct'] and (receipt['diagnostic']['status'] != 'correct'
                                       or claim['rating'] not in ('good', 'easy')):
        raise ValueError('native-course-formal-outcome-conflict')
    scheduling = event.get('scheduling') or {}
    if scheduling.get('rating', claim['rating']) != claim['rating']:
        raise ValueError('native-course-formal-scheduling-conflict')
    sources = NativeCourseSources(vault_root, owner, catalog_loader, store_path)
    capture = sources.read(request['identity'], request['captureId'])
    task = resolve_course_task(capture['item'], request['taskId'])
    validate_course_diagnostic(receipt['diagnostic'], task, request['submission']['answer'])

    def recheck():
        sources.verify_current(request['identity'], request['captureId'])
        current = ledger.read_claim_by_event(event['eventId'])
        if current != aggregate:
            raise ValueError('native-course-formal-evidence-conflict')

    recheck()
    return recheck
