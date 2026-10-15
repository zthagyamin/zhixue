"""Join immutable native math evidence to the existing formal writer; never grade."""
from __future__ import annotations

import os
from pathlib import Path
from infrastructure.math_grade_ledger import MathGradeLedger
from infrastructure.math_source_capture import NativeMathSources
from vault_identity import local_vault_library_id


def native_math_event_guard(database, root, owner, event, catalog, *, catalog_loader, store_path):
    table = database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_math_formal'").fetchone()
    if not table:
        return None, None
    existing = database.execute('SELECT 1 FROM native_math_formal WHERE owner=? AND event_id=?',
                                (owner, event['eventId'])).fetchone()
    if not existing:
        return None, None
    library = local_vault_library_id(root)
    if not library:
        raise ValueError('native-math-formal-source-unavailable')
    ledger = MathGradeLedger(store_path, owner, library, root)
    evidence = ledger.formal_evidence(event['eventId'], database)
    if not evidence:
        raise ValueError('native-math-formal-claim-required')
    claim, formal = evidence['claim'], evidence['formal']
    attempt = claim['attempt']
    submitted, binding, identity = attempt['submitted'], attempt['binding'], claim['identity']
    if (event['eventType'] != 'practice-attempt' or event['item']['kind'] != 'due'
            or event['item']['key'] != binding['itemKey'] or binding['itemKey'] != identity['itemKey']
            or attempt['parentAttemptId'] is not None or attempt['checkpoint'].get('purpose', 'first') != 'first'
            or 'variant' in claim or formal['attemptId'] != attempt['attemptId']
            or formal['answerRevision'] != submitted['answerRevision']
            or formal['sourceVersion'] != binding['contentHash'] or binding['contentHash'] != identity['contentHash']
            or formal['occurredAt'] != submitted['submittedAt'] or event['occurredAt'] != formal['occurredAt']
            or (event.get('scheduling') or {}).get('reviewedAt', event['occurredAt']) != formal['occurredAt']
            or formal.get('coreHash', event['coreHash']) != event['coreHash']):
        raise ValueError('native-math-formal-binding-conflict')
    finals = []
    for request in evidence['requests']:
        row, result = request['request'], request['result']
        if row['mode'] != 'final' or not result:
            continue
        if (row['attemptId'] != attempt['attemptId'] or row['answerRevision'] != submitted['answerRevision']
                or row['sourceVersion'] != identity['contentHash']):
            raise ValueError('native-math-formal-evaluation-conflict')
        final = result.get('final') or {}
        if final.get('status') in ('correct', 'incorrect') and final.get('source') == 'deterministic':
            finals.append(final['status'])
    if not finals or len(set(finals)) != 1:
        raise ValueError('native-math-formal-evaluation-required')
    rating = event['attempt']['rating']
    correct = finals[0] == 'correct'
    if (event['attempt']['correct'] != (correct and rating in ('good', 'easy'))
            or not correct and rating in ('good', 'easy')
            or (event.get('scheduling') or {}).get('rating', rating) != rating):
        raise ValueError('native-math-formal-outcome-conflict')
    sources = NativeMathSources(root, owner, catalog_loader, store_path)
    capture = sources.read(identity, claim['captureId'])
    if capture['item']['itemKey'] != event['item']['key']:
        raise ValueError('native-math-formal-binding-conflict')
    private = sources.read_binding(identity, claim['captureId'])
    native_binding = private['binding']
    route = {'mode': 'indexed', 'binding': native_binding,
             'context': {key: native_binding[key] for key in ('sourceNote', 'stateRef', 'abilityId') if native_binding.get(key)},
             'reviewCardPath': None, 'reviewEntryName': '',
             'sourceScope': {'ownerId': owner, 'libraryId': library,
                             'vaultRoot': os.path.normcase(str(Path(root).resolve()))}}

    def recheck():
        sources.verify_current(identity, claim['captureId'])
        if ledger.formal_evidence(event['eventId'], database) != evidence:
            raise ValueError('native-math-formal-evaluation-conflict')

    recheck()
    return recheck, route
