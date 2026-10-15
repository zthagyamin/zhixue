"""Test-only genuine source lifecycle; no guard or production permission override.

Only caller-owned temporary vaults/databases from the Companion fixtures are
used. Historical setup is explicitly separate from a new formal submission.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime
import index_gateway
import planning_evidence
from infrastructure.nonword_source_adapter import create_source_admission, _approved_entries
from infrastructure.nonword_source_resolver import exercise_presentation, original_key
from infrastructure.source_protocol_hash import fingerprint
from infrastructure.nonword_code_reports import review_current
from application.source_admission import normalize_evaluation


def bind_fixture_owner(server, owner):
    """Install the synthetic application principal, without bypassing a guard."""
    with server.local_database() as db:
        row = db.execute('SELECT user_hash FROM installation_owner WHERE singleton=1').fetchone()
        if row is not None and row[0] != owner:
            raise ValueError('fixture-owner-conflict')
        if row is None:
            db.execute('INSERT INTO installation_owner VALUES (1,?,?)',
                       (owner, datetime.now(server.LOCAL_TZ).isoformat()))


def registered_item(root, key, catalog=None):
    catalog = index_gateway.load_gateway(root) if catalog is None else catalog
    rows = [item for subject in catalog.get('subjects', []) for item in subject.get('items', [])
            if original_key(item) == key
            or item.get('kind') == 'vocabulary' and key in {
                item.get('abilityId'), 'word:' + str(item.get('word', '')).strip(),
                'word:' + str(item.get('word', '')).strip().lower()}]
    return rows[0] if len(rows) == 1 else None


def logical_payload(server, root, raw):
    """Fixture V3 labels derive from actual material rather than make_v3's word default."""
    payload = copy.deepcopy(raw)
    item = registered_item(root, payload['event']['item']['key'], server.effective_gateway(root))
    if item is None:
        legacy = [item for item, _, _ in _approved_entries(server.route_services(), root)
                  if original_key(item) == payload['event']['item']['key']]
        item = legacy[0] if len(legacy) == 1 else None
    is_word = item and item.get('kind') == 'vocabulary' and item.get('word') and item.get('meaning')
    if not is_word:
        mode = exercise_presentation(item).get('questionType') if item else None
        payload['event']['item']['kind'] = 'python' if mode == 'code' else 'due'
        payload['event']['domain'] = 'python' if mode == 'code' else 'differential-review'
    payload['event']['coreHash'] = server.compute_study_event_core_hash(payload['event'])
    return payload


def _submitted_answer(item, correct):
    mode = item.get('questionType')
    if mode == 'quiz':
        support = item.get('learningSupport')
        if support:
            good = list(support['correctOptionIds'])
            wrong = [option['optionId'] for option in support['options']
                     if option['optionId'] not in good]
            return json.dumps(good if correct else wrong[:1], ensure_ascii=False)
        choices, expected = item['options'], item['answer']
        if type(expected) is str:
            expected = choices.index(expected)
        return expected if correct else next(index for index in range(len(choices)) if index != expected)
    reference = str(item.get('answer') or item.get('explanation') or item.get('reviewPoint') or '')
    return reference if correct else 'An intentionally incorrect synthetic answer.'


def prepare_source_event(server, root, owner, payload, source_item_key=None):
    """Capture and persist a real original answer before requesting a formal claim.

    Quiz grading uses the production deterministic choice evaluator. Legacy
    recall fixtures use an explicit equality-only controlled recall port over
    the captured reference. This fixture tests writer/source compatibility,
    not provider dispatch or quota; those use the separate recall receipt suite.
    """
    bind_fixture_owner(server, owner)
    store = create_source_admission(server.route_services(), owner, root)
    existing = store.read_claim_by_event(payload['event']['eventId'])
    if existing:
        saved = store.read_attempt(existing['claim']['attemptId'])
        return {'store': store, 'submission': saved['submission'], 'evaluation': saved['evaluation'],
                'claim': existing, 'capture': saved['capture'], 'receipt': saved['receipt']}
    lookup_key = source_item_key or payload['event']['item']['key']
    item = registered_item(root, lookup_key, server.effective_gateway(root))
    if item is None:
        legacy = [item for item, _, _ in _approved_entries(server.route_services(), root)
                  if original_key(item) == lookup_key]
        item = legacy[0] if len(legacy) == 1 else None
    if item and item.get('kind') == 'vocabulary':
        return None
    presentation = exercise_presentation(item) if item else {
        'questionType': 'quiz', 'prompt': 'Unregistered synthetic question.',
        'options': ['yes', 'no'], 'answer': 0}
    query = {'itemKey': payload['event']['item']['key'],
             'contentHash': item.get('contentHash') if item and item.get('contentHash') else fingerprint(presentation),
             'presentation': presentation}
    if source_item_key:
        query['sourceItemKey'] = source_item_key
    capture = store.capture(query)
    answer = _submitted_answer(capture['item'], payload['event']['attempt']['correct']) if capture['status'] == 'confirmed' else 'Temporary original answer.'
    submission = {'attemptId': payload['event']['eventId'] + ':answer', 'binding': capture['binding'],
                  'answerRevision': 1, 'answer': answer, 'submittedAt': payload['event']['occurredAt'],
                  'purpose': 'first', 'parentAttemptId': None, 'assistance': 'unknown'}
    receipt = store.submit(submission)
    if capture['status'] == 'confirmed' and capture['item'].get('questionType') == 'recall':
        reference = str(capture['item'].get('answer') or capture['item'].get('explanation') or '')
        if not reference:
            raise AssertionError('Synthetic recall fixture has no independently captured reference')
        def equality_grade(original, submitted):
            actual = str(original.get('answer') or original.get('explanation') or '')
            if actual != reference:
                raise AssertionError('Synthetic recall source changed')
            correct = submitted == actual
            return {'correct': correct, 'verdict': 'correct' if correct else 'wrong',
                    'explanation': 'Synthetic reference equality only; no model or learning-quality claim.'}
        def equality_review(attempt, request_id):
            if not review_current(store,attempt,request_id):
                return {'status':'pending','reason':'synthetic-source-changed'}
            original=attempt['capture']['descriptor']['item']
            return normalize_evaluation(equality_grade(original,attempt['submission']['answer']),original)
        store.recall_review = equality_review
    evaluation = store.evaluate({'attemptId': submission['attemptId'],
                                 'requestId': payload['event']['eventId'] + ':evaluate'})
    claim = None
    if evaluation['status'] == 'resolved':
        claim = store.claim({'attemptId': submission['attemptId'], 'eventId': payload['event']['eventId'],
                             'rating': payload['event']['attempt']['rating']})
        if claim['claim']['correct'] != payload['event']['attempt']['correct']:
            raise AssertionError('Fixture event verdict is not bound to its saved answer')
    return {'store': store, 'capture': capture, 'submission': submission,
            'receipt': receipt, 'evaluation': evaluation, 'claim': claim}


def install_accepted_history(server, root, owner, payload):
    """Explicit immutable prior history, not a new event receiving a bypass."""
    event = server.validate_study_event_v3(payload['event'])
    catalog = index_gateway.load_gateway(root)
    binding, context = index_gateway.resolve_event_context(root, catalog, event['item']['key'],
                                                           payload.get('localContext'))
    card = next((card for card in catalog.get('resultCards', [])
                 if binding and card['itemId'] == binding['itemId']), None)
    route = {'mode': 'indexed', 'binding': binding, 'context': context,
             'reviewCardPath': card['path'] if card else None,
             'reviewEntryName': str((card.get('reviewPoints') or [''])[0]) if card else ''}
    if binding:
        route['planningEvidence'] = planning_evidence.observe_before(root, catalog, binding, event)
        index_gateway.record_subject_event(root, binding, owner, event, context, route['planningEvidence'])
    with server.local_database() as db:
        server.ensure_study_v3_schema(db)
        db.execute('INSERT INTO study_events_v3 VALUES (?,?,?,?,?,?,?)',
                   (owner, event['eventId'], event['coreHash'], event['occurredAt'],
                    json.dumps(event), json.dumps(context), '2026-08-24T10:00:00.000Z'))
        db.execute('INSERT INTO study_event_bindings VALUES (?,?,?)',
                   (owner, event['eventId'], json.dumps(route)))
        db.execute('INSERT INTO study_event_projections VALUES (?,?,?,?)',
                   (owner, event['eventId'], 'applied', '2026-08-24T10:00:00.000Z'))
