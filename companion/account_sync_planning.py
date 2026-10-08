"""Cloud-safe planning catalog export; all Vault references remain local."""
from __future__ import annotations
from study_day import source_review_due_at

import copy
from datetime import datetime, timezone
from pathlib import Path

import index_gateway
import planning_catalog
import task_events
from account_sync_schema import _practice_core
from account_sync_schema import study_count, study_digest, study_hash, study_id, study_object, study_size, study_text


def _strings(value, label):
    if type(value) is not list or len(set(value)) != len(value):
        raise ValueError(f'invalid-{label}')
    for child in value: study_text(child, label)
    return value


def _action(value):
    if type(value) is not dict or value.get('kind') not in ('practice', 'open-material', 'manual'):
        raise ValueError('invalid-cloud-action')
    if value['kind'] == 'practice':
        study_object(value, ['kind', 'itemKeys']); _strings(value['itemKeys'], 'item-keys')
        if not value['itemKeys']: raise ValueError('invalid-item-keys')
    elif value['kind'] == 'open-material':
        study_object(value, ['kind', 'materialId']); study_id(value['materialId'])
    else: study_object(value, ['kind'])
    return value


def validate_planning_catalog(raw):
    value = copy.deepcopy(study_object(raw, ['schemaVersion', 'libraryId', 'snapshotId', 'sourceHash', 'subjects', 'practiceSources', 'diagnostics', 'contentRefs', 'catalogHash']))
    if study_count(value['schemaVersion']) != 1: raise ValueError('unsupported-cloud-catalog-version')
    study_id(value['libraryId']); study_id(value['snapshotId']); study_digest(value['sourceHash']); study_digest(value['catalogHash'])
    if type(value['subjects']) is not list or type(value['practiceSources']) is not list or type(value['diagnostics']) is not list or type(value['contentRefs']) is not dict: raise ValueError('invalid-cloud-catalog')
    subjects = set()
    for subject in value['subjects']:
        study_object(subject, ['subjectId', 'name', 'priority', 'words', 'units', 'goals'], ['lastProgressAt', 'planningStatus'])
        study_id(subject['subjectId']); study_text(subject['name']); priority = study_count(subject['priority'], minimum=1)
        if priority > 5 or subject['subjectId'] in subjects: raise ValueError('invalid-cloud-subject')
        subjects.add(subject['subjectId'])
        if subject.get('planningStatus') not in (None, 'none', 'ready', 'invalid'): raise ValueError('invalid-planning-status')
        if type(subject['words']) is not list or type(subject['units']) is not list or type(subject['goals']) is not list: raise ValueError('invalid-cloud-subject')
        for word in subject['words']:
            study_object(word, ['itemKey', 'subjectId', 'word', 'language', 'sourceHash', 'completionRule'], ['legacyKeys'])
            study_id(word['itemKey']); study_id(word['subjectId']); study_text(word['word']); study_text(word['language']); study_digest(word['sourceHash'])
            if word['completionRule'] not in ('three-stage', 'graded-practice'): raise ValueError('invalid-word-rule')
            if 'legacyKeys' in word: _strings(word['legacyKeys'], 'legacy-keys')
        for unit in subject['units']:
            study_object(unit, ['unitId', 'subjectId', 'title', 'order', 'sourceHash', 'prerequisites', 'action', 'completionRule', 'formalComplete'], ['estimatedMinutes', 'stateHandle', 'abilityId', 'planningLabel', 'taskComplete'])
            study_id(unit['unitId']); study_id(unit['subjectId']); study_text(unit['title']); study_count(unit['order']); study_digest(unit['sourceHash']); _strings(unit['prerequisites'], 'prerequisites'); _action(unit['action'])
            if type(unit['formalComplete']) is not bool or unit['completionRule'] not in ('three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'): raise ValueError('invalid-cloud-unit')
            for key in ('stateHandle', 'abilityId', 'planningLabel'):
                if key in unit: study_text(unit[key])
            if 'estimatedMinutes' in unit: study_count(unit['estimatedMinutes'])
            if 'taskComplete' in unit and type(unit['taskComplete']) is not bool: raise ValueError('invalid-task-complete')
        for goal in subject['goals']:
            study_object(goal, ['goalId', 'subjectId', 'title', 'kind', 'targetCount', 'unitIds', 'startOn', 'priority', 'required', 'completionBasis'], ['dueOn'])
            study_id(goal['goalId']); study_id(goal['subjectId']); study_text(goal['title']); study_count(goal['targetCount'], minimum=1); _strings(goal['unitIds'], 'unit-ids')
            if goal['kind'] not in ('daily','weekly','deadline') or type(goal['required']) is not bool or goal['completionBasis'] not in ('practice-round','self-report','formal-state'): raise ValueError('invalid-cloud-goal')
            if study_count(goal['priority'], minimum=1) > 5: raise ValueError('invalid-priority')
            study_text(goal['startOn'])
            if 'dueOn' in goal: study_text(goal['dueOn'])
    for source in value['practiceSources']:
        study_object(source, ['itemKey', 'subjectId', 'title', 'sourceHash', 'completionRule']);study_id(source['itemKey']);study_id(source['subjectId']);study_text(source['title']);study_digest(source['sourceHash'])
    for diagnostic in value['diagnostics']:
        study_object(diagnostic, ['code'], ['subjectId']); study_text(diagnostic['code'])
        if 'subjectId' in diagnostic: study_id(diagnostic['subjectId'])
    for key, digest in value['contentRefs'].items(): study_id(key); study_digest(digest)
    study_size(value, 2 * 1024 * 1024)
    if study_hash({key: child for key, child in value.items() if key != 'catalogHash'}) != value['catalogHash']: raise ValueError('cloud-catalog-integrity')
    return value


def _gateway_identity(catalog):
    return {key: catalog.get(key) for key in ('schemaVersion', 'active', 'mode', 'subjects', 'bindings', 'planningDefinitions', 'diagnostics')}


def export_planning(vault_root, gateway_catalog, bundle, context=None, *, catalog_loader=None):
    vault = Path(vault_root).resolve(); snapshot = bundle['snapshot']
    with index_gateway.LOCK:
        current = (catalog_loader or index_gateway.load_gateway)(vault, refresh=False)
        if study_hash(_gateway_identity(current)) != study_hash(_gateway_identity(gateway_catalog)): raise ValueError('account-planning-capture-conflict')
        native = planning_catalog.load_planning_catalog(vault, current)
        after = (catalog_loader or index_gateway.load_gateway)(vault, refresh=False)
        if study_hash(_gateway_identity(current)) != study_hash(_gateway_identity(after)): raise ValueError('account-planning-capture-conflict')
    if native.get('diagnostics') or any(subject.get('planningStatus') == 'invalid' for subject in native['subjects']): raise ValueError('account-planning-incomplete')
    if context is not None:
        supplied=context.get('catalog') if type(context) is dict else None
        if type(supplied) is not dict or supplied.get('sourceHash')!=native.get('sourceHash'): raise ValueError('account-planning-context-conflict')
        native=copy.deepcopy(supplied)
    refs = {item['itemKey']: item['contentHash'] for item in bundle['items']}; materials, subjects = {}, []
    for subject in native['subjects']:
        words = []
        for word in subject['words']:
            if word['itemKey'] not in refs: raise ValueError('planning-content-membership')
            words.append({**copy.deepcopy(word), 'sourceHash': refs[word['itemKey']]})
        units = []
        for unit in subject['units']:
            own = copy.deepcopy(unit); own.pop('stateRef', None)
            if unit['action']['kind'] == 'open-note':
                material_id = 'material:' + study_hash([unit['unitId'], unit['sourceHash'], 'material'])
                material = {'materialId': material_id, 'subjectId': unit['subjectId'], 'unitId': unit['unitId'], 'contentRef': unit['action']['contentRef'], 'sourceHash': unit['sourceHash']}
                for key in ('stateRef', 'abilityId'):
                    if key in unit: material[key] = unit[key]
                materials[material_id] = material; own['action'] = {'kind': 'open-material', 'materialId': material_id}
                if 'stateRef' in unit: own['stateHandle'] = 'state:' + study_hash([unit['unitId'], unit['sourceHash'], unit['stateRef'], unit.get('abilityId', '')])
            elif unit['action']['kind'] == 'practice' and any(key not in refs for key in unit['action']['itemKeys']): raise ValueError('planning-content-membership')
            units.append(own)
        subjects.append({**copy.deepcopy(subject), 'words': words, 'units': units})
    practice = []
    for source in native.get('practiceSources', []):
        if source['itemKey'] not in refs: raise ValueError('planning-content-membership')
        practice.append({**copy.deepcopy(source), 'sourceHash': refs[source['itemKey']]})
    partial = {'schemaVersion': 1, 'libraryId': snapshot['libraryId'], 'snapshotId': snapshot['snapshotId'], 'subjects': subjects, 'practiceSources': practice, 'diagnostics': [], 'contentRefs': refs}
    body = {**partial, 'sourceHash': study_hash({'subjects': subjects, 'practiceSources': practice, 'diagnostics': [], 'contentRefs': refs})}; catalog = {**body, 'catalogHash': study_hash(body)}
    sources = copy.deepcopy(context.get('sourceReviews', [])) if context else []
    if context is None:
        for card in gateway_catalog.get('resultCards', []):
            key = f"practice:{card['itemId']}"; binding = index_gateway.lookup_binding(gateway_catalog, key)
            if binding:
                day = card.get('reviewDate', '')
                sources.append({'itemKey': key, 'subjectId': binding['subjectId'], 'completionRule': 'graded-practice',
                                'sourceHash': refs[key], 'state': {'enabled': bool(card.get('reviewEnabled')), 'dueAt': source_review_due_at(f'{day}T00:00:00+08:00') if day else None}})
    for source in sources:
        if source['itemKey'] not in refs: raise ValueError('planning-content-membership')
        source['sourceHash']=refs[source['itemKey']]
    facts_body = {'schemaVersion': 1, 'libraryId': snapshot['libraryId'], 'snapshotId': snapshot['snapshotId'], 'catalogHash': catalog['catalogHash'],
                  'observedAt': context.get('observedAt') if context else datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                  'nativePlanRevision': context.get('planRevision',0) if context else 0,'sourceReviews': sources,
                  'captureReviews': copy.deepcopy(context.get('captureReviews', [])) if context else [],
                  'legacyEvents': copy.deepcopy(context.get('legacyEvents', [])) if context else [],
                  'legacyTaskEvents': copy.deepcopy(context.get('legacyTaskEvents', [])) if context else [],
                  'contentCandidates':copy.deepcopy(context.get('contentCandidates',[])) if context else [],
                  'historyComplete': bool(context.get('historyComplete', False)) if context else True}
    facts = {**facts_body, 'factsHash': study_hash(facts_body)}
    routes={definition['id']:{key:definition[key] for key in ('id','contentRoot','recordsRoot','progressRef')} for definition in gateway_catalog.get('planningDefinitions',[])}
    return validate_planning_catalog(catalog), materials, validate_planning_facts(facts), routes


def _legacy_event(raw):
    event = copy.deepcopy(raw)
    if type(event) is not dict: raise ValueError('invalid-planning-event')
    if event.get('eventType') == 'practice-attempt':
        if type(event.get('scheduling')) is dict: event['scheduling'].pop('clientStateAfter', None)
        _practice_core(event)
        return event
    study_object(event, ['schemaVersion','eventId','coreHash','occurredAt','domain','eventType','item','schedulerVersion','baselineState'])
    if event['schemaVersion'] != 3 or event['eventType'] != 'review-baseline': raise ValueError('invalid-planning-event')
    study_id(event['eventId']); study_digest(event['coreHash']); study_text(event['occurredAt']);
    if event['domain'] not in ('ielts','python','differential-review'): raise ValueError('invalid-planning-event')
    study_object(event['item'], ['kind','key'], ['stateHandle']); study_id(event['item']['key'])
    if event['item']['kind'] not in ('word','python','due'): raise ValueError('invalid-planning-event')
    state=study_object(event['baselineState'], ['due','stability','difficulty','elapsedDays','scheduledDays','learningSteps','reps','lapses','state'], ['lastReview'])
    for key in ('due','stability','difficulty'): study_text(state[key])
    for key in ('elapsedDays','scheduledDays','learningSteps','reps','lapses','state'): study_count(state[key])
    if study_hash({key:value for key,value in event.items() if key!='coreHash'}) != event['coreHash']: raise ValueError('invalid-planning-event-hash')
    return event


def validate_planning_facts(raw):
    value=copy.deepcopy(study_object(raw,['schemaVersion','libraryId','snapshotId','catalogHash','observedAt','nativePlanRevision','sourceReviews','captureReviews','legacyEvents','legacyTaskEvents','contentCandidates','historyComplete','factsHash']))
    if study_count(value['schemaVersion'])!=1: raise ValueError('unsupported-planning-facts-version')
    study_id(value['libraryId']);study_id(value['snapshotId']);study_digest(value['catalogHash']);study_text(value['observedAt']);study_count(value['nativePlanRevision']);study_digest(value['factsHash'])
    if type(value['sourceReviews']) is not list or type(value['captureReviews']) is not list or type(value['legacyEvents']) is not list or type(value['legacyTaskEvents']) is not list or type(value['contentCandidates']) is not list or type(value['historyComplete']) is not bool: raise ValueError('invalid-planning-facts')
    for source in value['sourceReviews']:
        study_object(source,['itemKey','subjectId','completionRule','sourceHash','state']);study_id(source['itemKey']);study_id(source['subjectId']);study_digest(source['sourceHash'])
        state=study_object(source['state'],['enabled','dueAt'])
        if type(state['enabled']) is not bool or state['dueAt'] is not None and type(state['dueAt']) is not str: raise ValueError('invalid-source-review')
    for capture in value['captureReviews']:
        study_object(capture,['roundId','itemKey','subjectId','dueAt','observedAt','completionRule'],['blockedReason'])
        for key in ('roundId','itemKey','subjectId'): study_id(capture[key])
        for key in ('dueAt','observedAt'): study_text(capture[key])
    value['legacyEvents']=[_legacy_event(event) for event in value['legacyEvents']]
    value['legacyTaskEvents']=[task_events.validate_task_event(event) for event in value['legacyTaskEvents']]
    for candidate in value['contentCandidates']:
        study_object(candidate,['candidateId','kind','label','contentHash'],['oldLabel']);study_id(candidate['candidateId']);study_text(candidate['label']);study_digest(candidate['contentHash'])
        if candidate['kind'] not in ('added','modified','removed','renamed'):raise ValueError('invalid-content-candidate')
    if len({event['eventId'] for event in value['legacyEvents']})!=len(value['legacyEvents']) or len({event['eventId'] for event in value['legacyTaskEvents']})!=len(value['legacyTaskEvents']): raise ValueError('duplicate-planning-fact-event')
    study_size(value,2*1024*1024)
    if study_hash({key:child for key,child in value.items() if key!='factsHash'})!=value['factsHash']: raise ValueError('planning-facts-integrity')
    return value


def rebind_planning_facts(raw, catalog):
    facts=validate_planning_facts(raw);catalog=validate_planning_catalog(catalog)
    body={key:value for key,value in facts.items() if key!='factsHash'}
    body.update(libraryId=catalog['libraryId'],snapshotId=catalog['snapshotId'],catalogHash=catalog['catalogHash'])
    return validate_planning_facts({**body,'factsHash':study_hash(body)})
