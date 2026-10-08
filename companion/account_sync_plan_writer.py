"""Materialize one approved cloud plan into the existing authoritative plan."""
from __future__ import annotations

import copy
import re

import plan_area
import task_plan_schema
from account_sync_schema import study_count, study_digest, study_hash, study_id, study_iso, study_object, study_size


def _cloud_action(action):
    if type(action) is not dict or action.get('kind') not in ('practice','open-material','manual'): raise ValueError('invalid-cloud-plan-action')
    if action['kind']=='practice': study_object(action,['kind','itemKeys'])
    elif action['kind']=='open-material': study_object(action,['kind','materialId']);study_id(action['materialId'])
    else: study_object(action,['kind'])
    return action


def validate_cloud_plan(raw):
    value=copy.deepcopy(study_object(raw,['schemaVersion','day','catalogHash','factsHash','eventThrough','taskThrough','nativeBaseRevision','enginePlanHash','inputHash','sourceHash','draftVersion','tasks','vocabulary','manual','baseRevision','cloudPlanHash'],['optionalMinutes','longTermAllocation']))
    if value['schemaVersion']!=1: raise ValueError('unsupported-cloud-plan-version')
    for key in ('catalogHash','factsHash','enginePlanHash','inputHash','sourceHash','cloudPlanHash'): study_digest(value[key])
    for key in ('eventThrough','taskThrough','nativeBaseRevision','draftVersion','baseRevision'): study_count(value[key])
    if type(value['tasks']) is not list: raise ValueError('invalid-cloud-plan')
    engine_tasks=[]
    for task in value['tasks']:
        task=copy.deepcopy(task);action=_cloud_action(task.get('action'));task['action']={'kind':'open-note','contentRef':action['materialId']} if action['kind']=='open-material' else action;engine_tasks.append(task)
    engine={'schemaVersion':2,'day':value['day'],'planHash':value['enginePlanHash'],'inputHash':value['inputHash'],'sourceHash':value['sourceHash'],'draftVersion':value['draftVersion'],
            'tasks':engine_tasks,'vocabulary':value['vocabulary'],'manual':value['manual'],**({'longTermAllocation':copy.deepcopy(value['longTermAllocation'])} if 'longTermAllocation' in value else {}),**({'optionalMinutes':value['optionalMinutes']} if 'optionalMinutes' in value else {})}
    task_plan_schema.validate_task_plan_integrity(engine);study_size(value,2*1024*1024)
    if study_hash({key:child for key,child in value.items() if key!='cloudPlanHash'})!=value['cloudPlanHash']: raise ValueError('cloud-plan-integrity')
    return value


def _same(left,right): return left==right


def validate_plan_source_bindings(plan, old_catalog, old_materials, old_routes, current_catalog, current_materials, current_routes):
    """Revalidate only the approved tasks; unrelated registered sources may grow."""
    if (old_catalog['catalogHash'] != plan['catalogHash'] or old_catalog['sourceHash'] != plan['sourceHash']
            or old_catalog['libraryId'] != current_catalog['libraryId']):
        raise ValueError('source-changed')
    for task in plan['tasks']:
        subject = task['subjectId']
        old = next((s for s in old_catalog['subjects'] if s['subjectId'] == subject), None)
        current = next((s for s in current_catalog['subjects'] if s['subjectId'] == subject), None)
        if not old or not current or subject not in old_routes or old_routes[subject] != current_routes.get(subject):
            raise ValueError('source-changed')
        for unit_id in task['unitIds']:
            old_unit = next((u for u in old['units'] if u['unitId'] == unit_id), None)
            current_unit = next((u for u in current['units'] if u['unitId'] == unit_id), None)
            if not old_unit or not current_unit or any(old_unit.get(k) != current_unit.get(k) for k in ('subjectId', 'sourceHash', 'action', 'completionRule')):
                raise ValueError('source-changed')
        action = task['action']
        if action['kind'] == 'practice':
            for key in action['itemKeys']:
                if key not in old_catalog['contentRefs'] or old_catalog['contentRefs'][key] != current_catalog['contentRefs'].get(key):
                    raise ValueError('source-changed')
        elif action['kind'] == 'open-material':
            material = action['materialId']
            if material not in old_materials or old_materials[material] != current_materials.get(material):
                raise ValueError('source-changed')


def _source_hash(task,catalog):
    subject=next((subject for subject in catalog['subjects'] if subject['subjectId']==task['subjectId']),None)
    if not subject: raise ValueError('unknown-task-subject')
    if task['unitIds']:
        if len(task['unitIds'])!=1 or task['quantity']!=1: raise ValueError('task-units-must-be-independent')
        unit=next((unit for unit in subject['units'] if unit['unitId']==task['unitIds'][0]),None)
        if not unit or not _same(unit['action'],task['action']) or unit['completionRule']!=task['completionRule']: raise ValueError('local-material-binding')
        return unit['sourceHash']
    if task['action']['kind']=='manual':
        if task['category']!='subject' or task['completionRule']!='self-report': raise ValueError('invalid-manual-action')
        return catalog['sourceHash']
    if task['action']['kind']!='practice': raise ValueError('unmapped-task-action')
    if task['category']=='subject':
        keys=task['action']['itemKeys']
        source=next((s for s in catalog.get('practiceSources',[]) if s['subjectId']==task['subjectId'] and len(keys)==1 and s['itemKey']==keys[0]),None)
        if not source or task['quantity']!=1 or source['completionRule'] not in ('three-stage','graded-practice') or task['completionRule']!=source['completionRule']: raise ValueError('task-unit-reference-required')
        return source['sourceHash']
    if len(task['action']['itemKeys'])!=task['quantity']: raise ValueError('task-quantity-mismatch')
    hashes=[]
    for key in task['action']['itemKeys']:
        word=next((word for word in subject['words'] if key==word['itemKey'] or key in word.get('legacyKeys',[])),None)
        source=next((source for source in catalog.get('practiceSources',[]) if source['subjectId']==task['subjectId'] and source['itemKey']==key),None)
        unit=next((unit for unit in subject['units'] if unit['action']['kind']=='practice' and key in unit['action']['itemKeys']),None)
        if not any((word,source,unit)): raise ValueError('unknown-practice-reference')
        rule=(word or source or unit)['completionRule']
        if rule!=task['completionRule']: raise ValueError('task-completion-rule-mismatch')
        hashes.append([(word or {}).get('itemKey',key),(word or source or unit)['sourceHash']])
    return hashes[0][1] if task['category']=='review' and len(hashes)==1 else study_hash(hashes)


def materialize_cloud_plan(raw,native_catalog,materials):
    plan=validate_cloud_plan(raw)
    if type(materials) is not dict: raise ValueError('invalid-local-materials')
    tasks=[]
    for cloud_task in plan['tasks']:
        task=copy.deepcopy(cloud_task);action=_cloud_action(task['action'])
        if action['kind']=='open-material':
            material=materials.get(action['materialId'])
            if not material or len(task['unitIds'])!=1 or material.get('unitId')!=task['unitIds'][0] or material.get('subjectId')!=task['subjectId']: raise ValueError('local-material-binding')
            task['action']={'kind':'open-note','contentRef':material['contentRef']}
        task['sourceHash']=_source_hash(task,native_catalog);tasks.append(task)
    vocabulary=copy.deepcopy(plan['vocabulary']);words={word['itemKey']:word for subject in native_catalog['subjects'] for word in subject['words']}
    if 'snapshot' in vocabulary: vocabulary['snapshot']=[copy.deepcopy(words.get(word['itemKey'],word)) for word in vocabulary['snapshot']]
    native={'schemaVersion':2,'day':plan['day'],'inputHash':plan['inputHash'],'sourceHash':native_catalog['sourceHash'],'draftVersion':plan['draftVersion'],'tasks':tasks,
            'vocabulary':vocabulary,'manual':copy.deepcopy(plan['manual']),**({'longTermAllocation':copy.deepcopy(plan['longTermAllocation'])} if 'longTermAllocation' in plan else {}),**({'optionalMinutes':plan['optionalMinutes']} if 'optionalMinutes' in plan else {})}
    native['planHash']=task_plan_schema.hash_task_plan(native)
    return task_plan_schema.validate_task_plan_integrity(native)


def apply_operation(vault_root,owner,operation,native_catalog,materials,predecessor_receipt):
    study_digest(owner);study_object(operation,['sequence','operationId','action','plan','predecessorOperationId'],['day','stateRevision','receivedAt']);study_count(operation['sequence'],minimum=1);study_id(operation['operationId'])
    if operation['action'] not in ('approve','restore') or operation['plan'] is None: raise ValueError('invalid-plan-operation')
    plan=validate_cloud_plan(operation['plan'])
    if 'day' in operation and operation['day'] != plan['day']: raise ValueError('plan-operation-day-mismatch')
    if 'stateRevision' in operation: study_count(operation['stateRevision'], minimum=1)
    if 'receivedAt' in operation:
        received = operation['receivedAt']
        # D1 CURRENT_TIMESTAMP metadata uses SQLite UTC text; event timestamps
        # retain their stricter ISO contract. Do not rewrite either stored value.
        if type(received) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', received):
            received = received.replace(' ', 'T') + '.000Z'
        study_iso(received)
    predecessor=operation['predecessorOperationId']
    if predecessor is not None:
        if not predecessor_receipt or predecessor_receipt.get('operationId')!=predecessor or predecessor_receipt.get('status')!='applied':
            return {'operationId':operation['operationId'],'cloudPlanHash':plan['cloudPlanHash'],'status':'blocked','reason':'predecessor-pending'}
        expected=predecessor_receipt['proof']['localRevision']
    else:
        expected=plan['nativeBaseRevision']
    native=materialize_cloud_plan(plan,native_catalog,materials);area=plan_area.plan_area_root(vault_root)
    with plan_area.PLAN_LOCK:
        current=plan_area.current_revision(area);existing=plan_area.current_plan(area)
        if current==expected:
            record=plan_area.apply_plan_revision(area,native,owner,'cloud-account-approval',expected_revision=expected);revision=record['revision']
        elif current==expected+1 and existing and existing.get('planHash')==native['planHash']:
            revision=current
        else:
            return {'operationId':operation['operationId'],'cloudPlanHash':plan['cloudPlanHash'],'status':'blocked','reason':'local-plan-conflict'}
        if plan_area.current_revision(area)!=revision or plan_area.current_plan(area).get('planHash')!=native['planHash']: raise ValueError('plan-write-readback')
    proof={'cloudPlanHash':plan['cloudPlanHash'],'nativePlanHash':native['planHash'],'localRevision':revision,
           'proofHash':study_hash({'operationId':operation['operationId'],'cloudPlanHash':plan['cloudPlanHash'],'nativePlanHash':native['planHash'],'localRevision':revision}),'targetCount':1}
    return {'operationId':operation['operationId'],'cloudPlanHash':plan['cloudPlanHash'],'status':'applied','proof':proof}


def execution_receipt(result):
    result=copy.deepcopy(result);study_object(result,['operationId','cloudPlanHash','status'],['reason','proof']);study_id(result['operationId']);study_digest(result['cloudPlanHash'])
    body={'schemaVersion':1,'operationId':result['operationId'],'cloudPlanHash':result['cloudPlanHash'],'status':result['status']}
    if result['status']=='applied':
        proof=study_object(result.get('proof'),['cloudPlanHash','nativePlanHash','localRevision','proofHash','targetCount']);study_digest(proof['cloudPlanHash']);study_digest(proof['nativePlanHash']);study_count(proof['localRevision'],minimum=1);study_digest(proof['proofHash'])
        if proof['targetCount']!=1 or proof['cloudPlanHash']!=result['cloudPlanHash']:raise ValueError('invalid-plan-execution-proof')
        body['proof']=proof
    elif result['status']=='blocked' and result.get('reason') in ('source-changed','material-missing','predecessor-pending','local-plan-conflict','storage-unavailable','plan-write-failed'):body['reason']=result['reason']
    else:raise ValueError('invalid-plan-execution-result')
    body['receiptId']='plan-execution:'+study_hash(body)
    return body
