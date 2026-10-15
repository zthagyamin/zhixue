"""Formal admission interlock; caller labels and paths are not source proof."""
from __future__ import annotations

import os
from pathlib import Path
from vault_identity import local_vault_library_id


def source_event_guard(database, root, owner, event, catalog, *, source_store,
                       original_word, course_check=None, math_check=None):
    prior = database.execute(
        'SELECT core_hash FROM study_events_v3 WHERE account_id=? AND event_id=?',
        (owner, event['eventId'])).fetchone()
    if prior:
        # The owning writer retains immutable duplicate/conflict handling.
        return None, None
    if math_check:
        check, route = math_check()
        if check:
            return check, route
    if event['item'].get('kind') == 'word' and original_word(event['item']['key'], catalog):
        return None, None
    # Existing specialized course evidence has already been verified from its
    # stored submission/capture, not from a provider flag or the current mode.
    if course_check is not None:
        return None, None
    try:
        store = source_store(root, owner)
        aggregate = store.read_claim_by_event(event['eventId'])
        if aggregate is None:
            raise ValueError('source-unverified')
        recheck, route = store.admit(event)
        claim = aggregate['claim']
        route['sourceScope'] = {'ownerId': owner, 'libraryId': local_vault_library_id(root),
                                'vaultRoot': os.path.normcase(str(Path(root).resolve()))}
        route['sourceAssociationV1'] = {
            'schemaVersion': 1, 'itemKey': claim['sourceBinding']['itemKey'],
            'contentHash': (route.get('binding') or {}).get('signature'),
            'originalItemKey': event['item']['key'],
            'originalContentHash': claim['binding']['contentHash'],
            'claimHash': aggregate['claimHash'], 'sourceCaptureId': claim['sourceCaptureId'],
        }
        return recheck, route
    except (OSError, KeyError) as error:
        raise ValueError('source-unverified') from error


def catalog_word(key, catalog):
    """Vocabulary eligibility belongs to independently parsed original content."""
    matches = [item for subject in catalog.get('subjects', [])
               for item in subject.get('items', [])
               if (item.get('abilityId') if item.get('kind') == 'vocabulary'
                   else 'practice:' + str(item.get('itemId'))) == key]
    return (len(matches) == 1 and matches[0].get('kind') == 'vocabulary'
            and bool(matches[0].get('word') and matches[0].get('meaning')))


def verify_frozen_scope(route, root, owner):
    """New accepted routes never move to another configured library on replay."""
    scope = route.get('sourceScope')
    if scope is not None and scope != {
        'ownerId': owner, 'libraryId': local_vault_library_id(root),
        'vaultRoot': os.path.normcase(str(Path(root).resolve())),
    }:
        raise ValueError('source-admission-scope')
