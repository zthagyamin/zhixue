"""Owned normal source HTTP lifecycle; real copied handlers/storage, no providers."""
from __future__ import annotations
import argparse
import contextlib
import copy
import hashlib
import io
import inspect
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import types
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out',required=True)
parser.add_argument('--scenario',choices=('lifecycle','library-switch','source-update','source-inflight'),default='lifecycle')
options=parser.parse_args()
out=Path(options.out).resolve()
out.parent.mkdir(parents=True,exist_ok=True)
report = {'scenario':options.scenario,'complete':False,'phase':'setup','calls':[],'modelsAttempted':0,'productionWrites':0}
out.write_text(json.dumps(report),encoding='utf-8')
failure = None
try:
    with tempfile.TemporaryDirectory(prefix='zhixue-source-http-') as temp:
        root=Path(temp);candidate=root/'companion';candidate.mkdir();vault=root/'vault';vault.mkdir()
        manifest=json.loads((repo/'companion/program-files.json').read_text(encoding='utf-8'))
        assert manifest['schemaVersion']==1 and isinstance(manifest['files'],list)
        report['sourceManifestSha256']=hashlib.sha256((repo/'companion/program-files.json').read_bytes()).hexdigest()
        copied=[]
        for name in manifest['files']:
            parts=Path(name).parts
            assert type(name) is str and '\\' not in name and ':' not in name and not name.startswith('/') and all(x not in ('.','..') for x in parts)
            if not (name.endswith('.py') or name in ('version.json','data/seed.json')):continue
            target=candidate/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/'companion'/name,target)
            assert target.read_bytes()==(repo/'companion'/name).read_bytes()
            copied.append(name)
        (candidate/'config.json').write_text(json.dumps({'learning_vault_root':str(vault),'allowed_origins':[],
                'study_loop_integration_root':'_System/Integrations/Study Loop','deepseek_model':'deepseek-v4-flash','deepseek_model_migrated':True}),encoding='utf-8')
        sys.path.insert(0,str(candidate))
        sys.modules['keyring']=types.SimpleNamespace(get_password=lambda *_:None,set_password=lambda *_:None,delete_password=lambda *_:None)
        import server
        assert Path(server.__file__).resolve().is_relative_to(candidate)
        server.LOCAL_DATABASE_PATH=root/'source-http.sqlite'
        def denied(*args,**kwargs):
            report['modelsAttempted']+=1;raise AssertionError('provider-dispatch-forbidden')
        server.open_deepseek=denied;server.study_ai_provider.open_request=denied
        server.PAIRING_CODE='A1B2C3'
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        report['httpTransport']=type(httpd).__name__
        origin='http://127.0.0.1:'+str(httpd.server_port);server.CONFIG['allowed_origins']=[origin]
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        session=None
        def post(path,body,expected=200):
            headers={'Origin':origin,'Content-Type':'application/json'}
            if session:headers['X-Study-Loop-Session']=session
            request=urllib.request.Request(origin+path,data=json.dumps(body,ensure_ascii=False).encode('utf-8'),headers=headers,method='POST')
            try:
                with urllib.request.urlopen(request,timeout=10) as response:status=response.status;value=json.load(response)
            except urllib.error.HTTPError as error:status=error.code;value=json.load(error)
            report['calls'].append({'path':path,'action':body.get('action'),'status':status})
            assert status==expected,(path,body.get('action'),status,value)
            return value
        def source(action,body,expected=200):return post('/v1/nonword/source',{'schemaVersion':1,'action':action,'request':body},expected)
        def write(path,text):
            p=vault/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(inspect.cleandoc(text)+'\n',encoding='utf-8');return p
        def subject(name,plugin,table):
            write('subjects/'+name+'/state.md','---\ntype: zhixue-practice-state\n---\n# State\n')
            write('_System/Integrations/Study Loop/gateway/subjects/'+name+'.md',f'''---
    type: zhixue-subject-index
    schema_version: 1
    subject_id: {name}
    name: Synthetic {name}
    domain: course
    plugin: {plugin}
    content_root: "subjects/{name}"
    progress_ref: "[[subjects/{name}/state]]"
    records_root: "subjects/{name}/records"
    identity: scoped
    enabled: true
    auto: true
    ---
    # Index
    ''')
            return write('subjects/'+name+'/material.md',f'---\ntype: zhixue-content\nzhixue: true\nzhixue_id: {name}\nzhixue_format: {plugin}\nstatus: ready\n---\n'+table)
        def items():return [item for subject in server.effective_gateway(vault)['subjects'] for item in subject['items']]
        def query(item):
            from infrastructure.nonword_source_resolver import exercise_presentation
            return {'itemKey':'practice:'+item['itemId'],'contentHash':item['contentHash'],'presentation':exercise_presentation(item)}
        def submit(attempt,capture,answer,purpose='first',parent=None):
            body={'attemptId':attempt,'binding':capture['binding'],'answerRevision':1,'answer':answer,
                    'submittedAt':stamp,'purpose':purpose,'parentAttemptId':parent,'assistance':'observed'}
            receipt=source('submit',body);assert receipt['durable'] is True
            assert source('submit',copy.deepcopy(body))==receipt
            return body,receipt
        def read(attempt):return source('read',{'attemptId':attempt})
        def formal_count():
            with contextlib.closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as db:
                if not db.execute("SELECT 1 FROM sqlite_master WHERE name='study_events_v3'").fetchone():return 0
                return db.execute('SELECT COUNT(*) FROM study_events_v3').fetchone()[0]
        def consume(claim):
            event={'schemaVersion':3,'eventId':claim['eventId'],'occurredAt':claim['occurredAt'],'domain':'differential-review',
                    'eventType':'practice-attempt','item':{'kind':claim['eventKind'],'key':claim['binding']['itemKey']},
                    'attempt':{'rating':claim['rating'],'correct':claim['correct'],'stageBefore':0,'stageAfter':3 if claim['correct'] else 0},
                    'scheduling':{'reviewedAt':claim['occurredAt'],'schedulerVersion':server.SCHEDULER_VERSION}}
            event['coreHash']=server.compute_study_event_core_hash(event)
            body={'event':event,'localContext':{'title':'Synthetic source HTTP','activityType':'website-practice','durationMin':1,'weakPoints':[]}}
            before=formal_count();first=post('/v1/activity',body);assert formal_count()==before+1
            assert first['status']=='accepted' and first['companionReceipt']['durable'] is True
            duplicate=post('/v1/activity',body);assert formal_count()==before+1
            assert duplicate['status']=='duplicate' and duplicate['companionReceipt']['durable'] is True
            assert first['event']['coreHash']==duplicate['event']['coreHash']
            return {'eventId':claim['eventId'],'countBefore':before,'countAfter':formal_count(),'first':first,'duplicate':duplicate}
        try:
            report['phase']='pairing'
            with contextlib.redirect_stdout(io.StringIO()):paired=post('/v1/pair',{'code':'A1B2C3','userId':'synthetic-source-http'})
            session=paired['sessionToken'];owner=server.installation_owner_hash()
            stamp=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            write('_System/Integrations/Study Loop/gateway/index.md','---\ntype: zhixue-gateway\nschema_version: 1\n---\n# Gateway\n')
            quiz_path=subject('quiz','quiz','| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q1 | Which planet? | Earth;Mars | Earth | Grounded explanation |\n')
            subject('cards','flashcard','| ID | front | back |\n|---|---|---|\n| q1 | Recall one source fact | Source fact |\n')
            support={'schemaVersion':1,'type':'code','functionNames':['add'],'cases':[{'id':'sum','functionName':'add','args':[1,2],'expected':3}]}
            subject('code','code','| ID | prompt | initialCode | testCode | learningSupport |\n|---|---|---|---|---|\n| q1 | Implement add. | def add(a,b): return 4 | | '+json.dumps(support)+' |\n')
            catalog=items();quiz=next(x for x in catalog if x['pluginType']=='quiz');card=next(x for x in catalog if x['pluginType']=='flashcard');code=next(x for x in catalog if x['pluginType']=='code')
            report['phase']='pending-confirm-quiz'
            raw=quiz_path.read_bytes();quiz_path.rename(quiz_path.with_suffix('.hidden'))
            pending=source('capture',query(quiz));assert pending['status']=='pending'
            original,receipt=submit('quiz-original',pending,quiz['answer'])
            saved=read('quiz-original');assert saved['submission']==original and saved['evaluation'] is None
            assert formal_count()==0
            quiz_path.with_suffix('.hidden').rename(quiz_path);assert quiz_path.read_bytes()==raw
            confirmed=source('capture',query(quiz));assert confirmed['status']=='confirmed'
            proof=source('confirm',{'attemptId':'quiz-original','captureId':confirmed['captureId']});assert proof['durable'] is True
            evaluation=source('evaluate',{'attemptId':'quiz-original','requestId':'quiz-check'});assert evaluation['status']=='resolved' and evaluation['correct'] is True
            assert read('quiz-original')['submission']==original and formal_count()==0
            claim=source('claim',{'attemptId':'quiz-original','eventId':'quiz-official'})
            assert source('claim',{'attemptId':'quiz-original','eventId':'quiz-official'})==claim and formal_count()==0
            report['quiz']=consume(claim['claim'])
            report['phase']='flashcard-first-and-child'
            captured=source('capture',query(card));assert captured['status']=='confirmed'
            first,first_receipt=submit('card-first',captured,'')
            self_body={'schemaVersion':1,'attemptId':'card-first','binding':first['binding'],'answerRevision':1,'submittedAt':stamp,'rating':'again'}
            assessment=source('self-assess',self_body);assert assessment['durable'] is True
            first_eval=source('evaluate',{'attemptId':'card-first','requestId':'card-check'});assert first_eval['status']=='resolved' and first_eval['correct'] is False
            first_saved=read('card-first')
            child,child_receipt=submit('card-child',captured,'','remediation','card-first')
            child_assess={**self_body,'attemptId':'card-child','rating':'good'};source('self-assess',child_assess)
            child_eval=source('evaluate',{'attemptId':'card-child','requestId':'card-child-check'});assert child_eval['status']=='resolved' and child_eval['correct'] is True
            assert read('card-first')==first_saved
            denied_claim=source('claim',{'attemptId':'card-child','eventId':'child-no-official'},409)
            assert denied_claim['error']=='source-admission-purpose' and formal_count()==1
            flash_claim=source('claim',{'attemptId':'card-first','eventId':'card-official','rating':'again'})
            report['flashcard']=consume(flash_claim['claim']);assert read('card-first')['submission']['answer']==''
            report['phase']='code-report-hint-ai-unavailable'
            code_capture=source('capture',query(code));assert code_capture['status']=='confirmed'
            code_submission,code_receipt=submit('code-original',code_capture,'def add(a,b): return 4')
            execution={'schemaVersion':1,'runId':1,'identity':{'attemptId':'code-original','revision':1,'sourceVersion':code_submission['binding']['contentHash'],'testVersion':code_submission['binding']['contentHash']},
                'status':'failed','phase':'tests','outcome':'student-error','assertionsPassed':0,'assertionsExecuted':1,'mapping':{'prefixLineCount':0,'originalLineCount':1},
                'firstFailure':{'caseId':'sum','functionName':'add','args':[1,2],'kwargs':{},'expected':3,'actual':4}}
            report_request={'schemaVersion':1,'attemptId':'code-original','binding':code_submission['binding'],'answerRevision':1,'submittedAt':stamp,'report':execution}
            report_receipt=source('code-report',report_request);assert report_receipt['durable'] is True
            assert source('code-report',report_request)==report_receipt
            hint=source('code-hint',{'attemptId':'code-original','requestId':'code-hint-original','reportId':report_receipt['reportId']});assert hint['status']=='pending' and hint['durable'] is True
            code_eval=source('evaluate',{'attemptId':'code-original','requestId':'code-check'});assert code_eval['status']=='pending'
            original_code=read('code-original');assert original_code['submission']==code_submission
            assert original_code['codeReports']==[report_receipt]
            assert formal_count()==2
            assert source('claim',{'attemptId':'code-original','eventId':'unknown-code-no-official'},409)['error']=='source-admission-evaluation-required'
            # Every route call reconstructs the real store; replay reads the same durable original.
            assert read('quiz-original')['submission']==original
            assert read('card-first')['evaluation']==first_eval
            assert read('card-child')['evaluation']==child_eval
            assert read('code-original')==original_code
            if options.scenario=='library-switch':
                report['phase']='library-switch'
                before_a=read('quiz-original')
                before_code=read('code-original')
                vault_b=root/'vault-b';vault_b.mkdir()
                for name in ['quiz','cards','code']:
                    for relative in ['_System/Integrations/Study Loop/gateway/subjects/'+name+'.md','subjects/'+name+'/material.md']:
                        target=vault_b/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((vault/relative).read_bytes())
                    state=vault_b/'subjects'/name/'state.md';state.write_text('---\ntype: zhixue-practice-state\n---\n# State\n',encoding='utf-8')
                gateway_b=vault_b/'_System/Integrations/Study Loop/gateway/index.md';gateway_b.write_bytes((vault/'_System/Integrations/Study Loop/gateway/index.md').read_bytes())
                server.CONFIG['learning_vault_root']=str(vault_b)
                try:
                    missing=source('read',{'attemptId':'quiz-original'},409)
                    assert missing=={'error':'source-admission-submission-required'}
                    stale=source('submit',original,409)
                    assert stale['error']=='source-admission-scope'
                    b_capture=source('capture',query(quiz));assert b_capture['status']=='confirmed'
                    assert b_capture['binding']['libraryId']!=original['binding']['libraryId']
                    assert b_capture['binding']['contentHash']==original['binding']['contentHash']
                    assert b_capture['binding']['ownerId']==original['binding']['ownerId']==owner
                    b_submission,b_receipt=submit('quiz-original',b_capture,'Mars')
                    b_saved=read('quiz-original');assert b_saved['submission']==b_submission
                    assert b_saved['evaluation'] is None and b_submission['answer']!=original['answer']
                    assert formal_count()==2
                    server.CONFIG['learning_vault_root']=str(vault)
                    assert read('quiz-original')==before_a and read('code-original')==before_code
                    server.CONFIG['learning_vault_root']=str(vault_b)
                    assert read('quiz-original')==b_saved
                    report['librarySwitch']={'controlledConfig':True,'sameLogicalAttempt':True,'sameContentHash':True,'distinctLibrary':True,'originalAUnchanged':True,'newBUngraded':True,'formalRecordsUnchanged':True,'sameOwner':True}
                finally:
                    server.CONFIG['learning_vault_root']=str(vault)
                assert read('quiz-original')==before_a and formal_count()==2
            if options.scenario=='source-update':
                report['phase']='source-version-update'
                original_formal=read('quiz-original')
                existing_records=formal_count()
                queued_capture=source('capture',query(quiz));assert queued_capture['status']=='confirmed'
                queued_submission,queued_receipt=submit('quiz-unclaimed',queued_capture,quiz['answer'])
                queued_eval=source('evaluate',{'attemptId':'quiz-unclaimed','requestId':'unclaimed-evaluate'})
                assert queued_eval['status']=='resolved' and queued_eval['correct'] is True
                queued_saved=read('quiz-unclaimed');assert formal_count()==existing_records
                old_source=quiz_path.read_bytes()
                revised=old_source.decode('utf-8').replace('| Earth | Grounded explanation |','| Mars | Updated source explanation |')
                assert revised.encode('utf-8')!=old_source
                quiz_path.write_bytes(revised.encode('utf-8'))
                updated=next(item for item in items() if item['pluginType']=='quiz')
                assert updated['itemId']==quiz['itemId'] and updated['contentHash']!=quiz['contentHash']
                assert updated['answer']!=quiz['answer']
                stale_capture=source('capture',query(quiz));assert stale_capture['status']=='pending'
                stale_eval=source('evaluate',{'attemptId':'quiz-unclaimed','requestId':'unclaimed-evaluate'})
                assert stale_eval['status']=='pending' and stale_eval['durable'] is False
                assert read('quiz-unclaimed')==queued_saved
                rejected=source('claim',{'attemptId':'quiz-unclaimed','eventId':'stale-unclaimed'},409)
                assert rejected['error']=='source-admission-source-changed'
                updated_capture=source('capture',query(updated));assert updated_capture['status']=='confirmed'
                rejected=source('confirm',{'attemptId':'quiz-unclaimed','captureId':updated_capture['captureId']},409)
                assert rejected['error']=='source-admission-presentation-conflict'
                assert read('quiz-unclaimed')==queued_saved
                current_submission,current_receipt=submit('quiz-new-version',updated_capture,quiz['answer'])
                current_eval=source('evaluate',{'attemptId':'quiz-new-version','requestId':'new-version-evaluate'})
                assert current_eval['status']=='resolved' and current_eval['correct'] is False
                assert current_eval['sourceBinding']['contentHash']!=queued_eval['sourceBinding']['contentHash']
                assert read('quiz-original')==original_formal and formal_count()==existing_records
                replay_claim=source('claim',{'attemptId':'quiz-original','eventId':'quiz-official'})
                event=report['quiz']['first']['event']
                replay=post('/v1/activity',{'event':event,'localContext':{'title':'Synthetic source HTTP','activityType':'website-practice','durationMin':1,'weakPoints':[]}})
                assert replay['status']=='duplicate' and replay['event']==event and replay['companionReceipt']['durable'] is True
                assert formal_count()==existing_records and read('quiz-original')==original_formal
                quiz_path.write_bytes(old_source)
                recovered=source('evaluate',{'attemptId':'quiz-unclaimed','requestId':'unclaimed-evaluate'})
                assert recovered==queued_eval and read('quiz-unclaimed')==queued_saved
                assert source('claim',{'attemptId':'quiz-original','eventId':'quiz-official'})==replay_claim
                assert read('quiz-original')==original_formal and formal_count()==existing_records
                report['sourceUpdate']={'sameItemDistinctVersion':True,'oldPresentationPending':True,'oldEvaluationNotCurrent':True,'unclaimedOldGradeCannotClaim':True,'newReferenceCannotBindOldAnswer':True,'newVersionOldAnswerIncorrect':True,'oldFormalUnchanged':True,'oldFormalReplayDuplicate':True,'restoredExactSourceRecoversOriginalEvaluation':True,'formalRecordsUnchanged':True}
            if options.scenario=='source-inflight':
                import runpy
                check=runpy.run_path(str(repo/'scripts/nonword_source_inflight.py'))['check_source_inflight']
                check(source=source,read=read,submit=submit,query=query,items=items,quiz=quiz,
                      quiz_path=quiz_path,formal_count=formal_count,report=report)
            assert report['modelsAttempted']==0
            report['actions']=sorted({x['action'] for x in report['calls'] if x['path']=='/v1/nonword/source'})
            assert report['actions']==sorted(['capture','submit','read','confirm','evaluate','claim','self-assess','code-report','code-hint'])
            report.update(businessComplete=True,phase='business-completed',formalRecords=formal_count(),hintStatus=hint['status'],codeStatus=code_eval['status'],
                clientReportMeaning='Synthetic declaration, not actual Python or server execution',declaredProgramCount=len(manifest['files']),copiedSourceCount=len(copied))
        except Exception as error:
            failure=error;report['failure']=type(error).__name__+': '+str(error)
        finally:
            httpd.shutdown();thread.join(3);httpd.server_close();assert not thread.is_alive()
            report['httpThreadStopped']=True
    report['cleanupCompleted']=True
except Exception as error:
    failure=error
    report['failure']=type(error).__name__+': '+str(error)
    report['phase']='cleanup-failed' if report.get('businessComplete') else report['phase']
finally:
    report['complete']=failure is None and report.get('businessComplete') is True and report.get('cleanupCompleted') is True
    if report['complete']:report['phase']='completed'
    out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

print(json.dumps({'complete':report['complete'],'phase':report['phase'],'calls':len(report['calls']),'failure':report.get('failure')},ensure_ascii=False))
if failure:sys.exit(1)
