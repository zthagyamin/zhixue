import sys,json,copy
from pathlib import Path
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'tests'));sys.path.insert(0,str(root/'companion'))
import test_native_course_event_proof as proof
import planning_evidence,index_gateway,planning_catalog
fixture=proof.NativeCourseEventProofTests();fixture.setUp()
try:
    now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    fixture.request['submission']['submittedAt']=now
    fixture.claim()
    event=fixture.event()
    receipt=fixture.accept(event,write=True)
    before_gateway=fixture.catalog(fixture.vault)
    before=planning_evidence.build_context(fixture.vault,before_gateway,fixture.owner,proof.native_fixture.source_fixture.validate_study_event_v3 if hasattr(proof.native_fixture.source_fixture,'validate_study_event_v3') else __import__('study_event_schema').validate_study_event_v3,catalog_loader=fixture.catalog)
    rows=planning_evidence.read_records(fixture.vault,before_gateway,fixture.owner,__import__('study_event_schema').validate_study_event_v3)
    old_rows=copy.deepcopy(rows)
    fixture.h.source.support['criteria'][0]['text']+=' Changed concept condition.'
    fixture.h.source.support['task']['sources'][0]['excerpt']+=' The changed task has a new condition.'
    fixture.h.source.source()
    current_gateway=fixture.catalog(fixture.vault)
    after=planning_evidence.build_context(fixture.vault,current_gateway,fixture.owner,__import__('study_event_schema').validate_study_event_v3,catalog_loader=fixture.catalog)
    records=planning_evidence.read_records(fixture.vault,current_gateway,fixture.owner,__import__('study_event_schema').validate_study_event_v3)
    packet=planning_evidence.evidence_page(fixture.vault,current_gateway,fixture.owner,__import__('study_event_schema').validate_study_event_v3,source_hash=after['catalog']['sourceHash'],plan_revision=after['planRevision'])
    source_key=event['item']['key']
    old_hash=old_rows[0]['planningEvidence']['itemSource']['sourceHash']
    current_source=next(item for item in after['catalog']['practiceSources'] if item['itemKey']==source_key)
    unit=next(unit for subject in after['catalog']['subjects'] for unit in subject['units'] if unit['action'].get('itemKeys')==[source_key])
    # Source assertion can use exactly the gateway's public subject projection.
    subjects=current_gateway['subjects']
    result={'schemaVersion':1,'synthetic':True,'realNativeWriter':True,'modelTransport':'in-process synthetic provider',
      'receiptStatus':receipt['status'],'event':event,'context':after,'beforeContext':before,'records':records,'page':packet,
      'subjects':subjects,'oldHash':old_hash,'newHash':current_source['sourceHash'],'sameItemId':source_key,
      'sourceChanged':old_hash!=current_source['sourceHash'],'backendTaskComplete':unit.get('taskComplete'),
      'immutableRecordsPreserved':records==old_rows,'formalEventCount':fixture.event_count(),
      'day':now[:10],'authority':{'schemaVersion':2,'revision':after['planRevision'],'candidate':None,'constraints':{},'history':[]}}
    print(json.dumps(result,ensure_ascii=False))
finally:
    fixture.doCleanups()
