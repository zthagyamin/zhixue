import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createHooks,loader,nodes,deferred,tick,button,text,waitForObservation} from './helpers/causal-harness.mjs';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import * as content from '../app/account-study-content.ts';
import * as routing from '../app/plugin-routing.ts';
import * as submission from '../app/study-submission.ts';
import * as journalApi from '../app/study-submission-journal.ts';
import * as localEvents from '../app/local-study-events.ts';
import * as localDb from '../app/local-study-db.ts';
import * as localAccount from '../app/local-account-study.ts';
import * as assistance from '../app/assistance-observer.ts';
import * as assessment from '../src/domain/assessment/index.ts';
import * as domainContent from '../src/domain/content/index.ts';
import * as application from '../src/application/nonword-study/index.ts';
import * as planning from '../src/domain/planning/index.ts';
import * as runtime from '../src/infrastructure/nonword-study/index.ts';
import * as attemptInfrastructure from '../src/infrastructure/learning-attempt/index.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
import {snapshotBody,SOURCE_HASH} from './fixtures/account-study-fixtures.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
let serial=0;
const AT='2026-10-01T08:00:00.000Z';
async function settle(hooks){for(let i=0;i<14;i++){hooks.flush();await tick();hooks.render();for(const node of nodes(hooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function')node.type(node.props);}}
async function fixture(t,{cloud=true,nativeFrame,claimed=false,serverCore=false,persistGate,unsubmitted=false,guided=false,freshDevice=false,laterAutosave=false,legacyStartedAt=false}={}) {
  const db=await openD1();t.after(()=>db.sqlite.close());const owner=`recovered-${serial++}`,workspaceId=`account:${owner}`,libraryId='library-a';
  db.sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(owner);
  const store=new AccountStudyStore(db.binding),attempts=new attemptInfrastructure.D1LearningAttemptStore(db.binding);
  const body={schemaVersion:1,kind:'practice',itemKey:'original-question',eventKind:'due',subjectId:'course',title:'Original evaluation condition',sourceHash:SOURCE_HASH,completionRule:'graded-practice',practice:{itemId:'original-question',abilityId:'evaluation',domain:'course',questionType:'recall',prompt:'为什么验证集必须独立于训练集？',answer:'独立采样避免训练记忆污染泛化评估。',explanation:'原参考：独立采样，防止训练数据污染。',sourceLabel:'Old original source'}};
  const item=await content.sealStudyItem(body),oldItems=[item];for(let i=1;i<21;i++)oldItems.push(await content.sealStudyItem({...body,itemKey:`neighbor-${i}`,practice:{...body.practice,itemId:`neighbor-${i}`,prompt:`Old neighboring question ${i}.`}}));
  const snapshot=await content.sealStudySnapshot(snapshotBody(oldItems,{snapshotId:'old-snapshot',generatedAt:AT}));
  await store.beginSnapshot({userId:owner,libraryId},snapshot);
  for(let offset=0;offset<oldItems.length;offset+=20)await store.stageSnapshotItems({userId:owner,libraryId},snapshot.snapshotId,oldItems.slice(offset,offset+20).map((item,index)=>({position:offset+index,item})));
  await store.completeSnapshot({userId:owner,libraryId},snapshot.snapshotId,0);
  const newer=await content.sealStudyItem({...body,practice:{...body.practice,answer:'CHANGED CURRENT ANSWER',explanation:'New current reference.'}}),head=await content.sealStudySnapshot(snapshotBody([newer],{snapshotId:'new-current-snapshot',revision:2,generatedAt:'2026-10-06T00:00:00.000Z'}));
  await store.putSnapshot({userId:owner,libraryId},{snapshot:head,items:[newer]},1);
  await localAccount.putLocalStudySnapshot(workspaceId,{snapshot:head,items:[newer]},0);
  const binding={ownerId:owner,libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:await attemptInfrastructure.attemptFingerprint('original-old-day-group'),roundId:await attemptInfrastructure.attemptFingerprint('original-old-day-round')};
  const attemptId=`nw:${await attemptInfrastructure.attemptFingerprint([binding,'recall','first',null,null])}`,eventId=`nw:${await attemptInfrastructure.attemptFingerprint([binding,'formal-first'])}`;
  const repository=attemptInfrastructure.createLocalAttemptRepository({userId:owner,libraryId});
  const first=application.createNonWordSession({repository,binding,attemptId,formalEventId:eventId,mode:'recall',now:()=>AT,newId:()=>crypto.randomUUID(),fingerprint:attemptInfrastructure.attemptFingerprint,evaluationFingerprint:attemptInfrastructure.evaluationFingerprint});
  await first.open();await first.save('独立采样，避免训练记忆污染。',{answer:'独立采样，避免训练记忆污染。'});
  let guidedId;
  if(unsubmitted){
    await first.updateView({intent:guided?'lesson':'practice',view:{purpose:guided?'guided':'first',...(guided?{instanceId:'old-paused-guided'}:{}),lessonStep:guided?'guided':'independent',paused:true,referenceSeen:guided}});
    if(guided){guidedId=`nw:${await attemptInfrastructure.attemptFingerprint([binding,'recall','guided',null,'old-paused-guided'])}`;const child=application.createNonWordSession({repository,binding,attemptId:guidedId,formalEventId:eventId,mode:'recall',purpose:'guided',intent:'learn',now:()=>AT,newId:()=>crypto.randomUUID(),fingerprint:attemptInfrastructure.attemptFingerprint,evaluationFingerprint:attemptInfrastructure.evaluationFingerprint});await child.open();await child.save('OLD GUIDED UNFINISHED WORK',{answer:'OLD GUIDED UNFINISHED WORK'});}
  } else {await first.submit('独立采样，避免训练记忆污染。','unknown',{maxPreHintLevel:0,answerRevealed:false});await first.pending('offline');}
  if(laterAutosave){for(let i=0;i<3;i++){const row=first.snapshot();const saved=await repository.mutate({schemaVersion:1,kind:'checkpoint',operationId:`later-autosave-${i}`,attemptId,binding,expectedRevision:row.revision,updatedAt:`2026-10-06T00:0${i}:00.000Z`,answer:row.answer,parentAttemptId:null,checkpoint:{...row.checkpoint,activeSeconds:30+i}});assert.equal(saved.durable,true);await first.open();}}
  if(legacyStartedAt){
    assert.equal(cloud,false,'legacy local aggregate fixture must not recreate a new cloud first operation');
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-learning-attempts-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('attempts','readwrite'),store=tx.objectStore('attempts'),request=store.get([owner,libraryId,attemptId]);request.onsuccess=()=>{const row=request.result;delete row.attempt.startedAt;store.put(row);};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();await first.open();
  }
  if(claimed){await first.assess({status:'correct',source:'model',rating:'good',explanation:'Original verified semantic result.'});await first.reserve('good');}
  const frames=[],written=[],records=[],requests=[],closed=[];let current=true;
  const services={workspaceId,ownerId:owner,libraryId,cloud,current:()=>current,records:()=>records,
    questionAi:async packet=>{requests.push(structuredClone(packet));return {result:{...packet.request,text:'Original independent sampling reference.',verdict:'correct',rating:'good'}};},
    async persist(record,frame,observation){frames.push(structuredClone(frame));written.push(record);await persistGate?.promise;const journal=journalApi.createSubmissionJournal(),payload=await submission.prepareStudySubmission(record,frame,observation,journal);await journal.put(payload);await submission.persistOriginalSubmission(payload);await journal.markCoreStored(workspaceId,record.eventId);return payload;},
    async sendCloud(payload){if(payload.route.kind==='account'){const result=await store.appendRecord({userId:owner,libraryId},payload.route.record);if(result.durable&&!records.some(row=>row.event.eventId===payload.eventId))records.push(payload.route.record);return result;}},sendCompanion:async()=>({durable:true,status:'saved'}),changed(){},
    ...(nativeFrame?{nativeFrame:()=>({kind:'local',practiceMode:'recall',contentHash:item.contentHash,localBindingHash:nativeFrame})}:{}),
  };
  if(serverCore){const prepared=await recordStudyAttempt({identity:{eventId,reviewedAt:AT},workspaceId,domain:'differential-review',item:{kind:'due',key:item.itemKey},rating:'good',correct:true,stageBefore:0,stageAfter:3,reviewedAt:AT,isThreeStage:false,delivery:{cloud:'pending',companion:'not-required'}},{persistEvent:async()=>{},persistProgress:async()=>{},sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{}});
    const {prepareAccountStudyRecord}=await import('../app/account-study-record-client.ts');const record=await prepareAccountStudyRecord({workspaceId,bundle:{snapshot,items:[item]},event:prepared.event,originDeviceId:'old-other-device',practiceMode:'recall'});await store.appendRecord({userId:owner,libraryId},record);records.push(record);
  }
  const handlers=createAccountStudyHttpHandlers({enabled:true,getBrowserUser:async()=>({userId:owner}),getAccessStore:async()=>({profile:async()=>({libraryId,revision:1})}),getStudyStore:async()=>store,getAttemptStore:async()=>attempts});
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url,init={})=>{const headers=new Headers(init.headers);headers.set('Origin','https://recover.invalid');const request=new Request(new URL(url,'https://recover.invalid'),{...init,headers});return request.method==='GET'?handlers.GET(request):handlers.POST(request);};t.after(()=>{globalThis.fetch=originalFetch;});
  const original={attempt:first.snapshot(),item,snapshot,referenceVerified:true,resumable:true,capability:'complete',notice:''};
  const PluginUI=()=>null,common={
    'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-recall',renderUI:PluginUI})}},'app/account-study-content.ts':content,'app/plugin-routing.ts':routing,
    'app/study-submission-journal.ts':journalApi,'app/local-study-events.ts':localEvents,'app/local-study-db.ts':localDb,'app/local-account-study.ts':localAccount,'app/assistance-observer.ts':assistance,
    'app/study-event-controller.ts':{recordStudyAttempt},'src/features/study-attempt/index.ts':{createSubjectGradeHandler},'src/domain/assessment/index.ts':assessment,'src/domain/content/index.ts':domainContent,
    'src/application/nonword-study/index.ts':application,'src/infrastructure/nonword-study/index.ts':runtime,'src/infrastructure/learning-attempt/index.ts':attemptInfrastructure,
    'app/components/ai-sidebar/study-ai-workspace.tsx':{StudyAIOfflineContext:()=>null},'app/math-text.tsx':{MathText:()=>null},'app/learning-draft.tsx':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},'app/calculation-client.ts':{gradeCalculationInWorker:()=>{throw Error('No calculation requested');}},
  };
  let workspaceHooks,workspaceProps,pageProps={original,deviceId:'new-recovered-device',services,onClose:()=>closed.push('close')};
  if(cloud){await repository.sync(attemptInfrastructure.createAccountAttemptClient({ownerId:owner,libraryId}));
    if(freshDevice){globalThis.indexedDB=new IDBFactory();assert.equal(await repository.read(attemptId),null);await localAccount.putLocalStudySnapshot(workspaceId,{snapshot:head,items:[newer]},0);}
    await localDb.saveWorkspaceRecord(workspaceId,'account-study-device','new-recovered-device');
    workspaceHooks=createHooks();const workspaceLoad=loader(workspaceHooks.api,common);workspaceProps={...services,records,ready:true};workspaceHooks.mount(workspaceLoad('app/study-dashboard/pending-workspace.tsx').PendingAnswerWorkspace,workspaceProps);workspaceHooks.flush();
    const queue=nodes(workspaceHooks.view()).find(node=>node.props.port);if(unsubmitted)assert.deepEqual((await queue.props.port.list()).map(row=>row.attemptId),[attemptId]);await queue.props.port.onResume(original.attempt);workspaceHooks.render();const review=nodes(workspaceHooks.view()).find(node=>node.props.original);
    assert.ok(review,'Real pending workspace restores the old bundle before opening review');pageProps={...review.props,onClose:()=>{closed.push('close');review.props.onClose();}};
  }
  const pageHooks=createHooks(),pageLoad=loader(pageHooks.api,common);pageHooks.mount(pageLoad('app/study-dashboard/pending-review.tsx').PendingAttemptReview,pageProps);pageHooks.flush();
  const seam=nodes(pageHooks.view()).find(node=>node.props.recovered);assert.ok(seam,'Original review renders its actual recovery seam');
  const boundHooks=createHooks(),boundLoad=loader(boundHooks.api,common),Host=boundLoad('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost;
  boundHooks.mount(props=>{const node=Host(props);return node.type(node.props);},seam.props);boundHooks.flush();const hostProps=boundHooks.view().props;
  let handles;const drivers=[],createDriver=hostProps.createDriver;
  const hostHooks=createHooks(),hostLoad=loader(hostHooks.api,common),controlledProps={...hostProps,createDriver:async(...args)=>{const value=await createDriver(...args);drivers.push(value);return value;},renderPlugin(draft,lifecycle,grade){handles={draft,lifecycle,grade};return hostProps.renderPlugin(draft,lifecycle,grade);}};
  hostHooks.mount(hostLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,controlledProps);await settle(hostHooks);
  let pausedView;
  try {
    if(unsubmitted)await waitForObservation(()=>settle(hostHooks),()=>Boolean(button(hostHooks.view(),'继续学习')&&!button(hostHooks.view(),'继续学习').props.disabled),{label:'recovered paused host ready'});
    pausedView=text(hostHooks.view());
    if(unsubmitted){const resume=button(hostHooks.view(),'继续学习');assert.ok(resume);resume.props.onClick();}
    await waitForObservation(()=>settle(hostHooks),()=>Boolean(handles?.lifecycle.ready)&&!button(hostHooks.view(),'继续学习'),{label:'recovered original or guided instance ready'});
  }catch(error){hostHooks.unmount();boundHooks.unmount();pageHooks.unmount();workspaceHooks?.unmount();throw error;}
  assert.ok(handles,'Recovered source finishes opening before learner action');
  return {...db,owner,workspaceId,libraryId,original,item,snapshot,oldItems,newer,head,repository,first,frames,written,records,requests,closed,services,drivers,pageHooks,boundHooks,hostHooks,seam,hostProps,guidedId,pausedView,
    get handles(){return handles;},setCurrent(value){current=value;if(workspaceHooks&&!value){workspaceHooks.render({...workspaceProps,ownerId:'changed-owner',workspaceId:'account:changed-owner'});workspaceHooks.flush();}},
    async returnToIndependent(){
      const independent=button(hostHooks.view(),'收起讲解，独立尝试');
      assert.ok(independent&&!independent.props.disabled);
      independent.props.onClick();
      // The UI action returns void; fixed pump turns cannot acknowledge the guided flush
      // and the subsequent first-attempt independent checkpoint under a slower runtime.
      await waitForObservation(()=>settle(hostHooks),()=>{
        const saved=drivers[0].runtime.session.snapshot(),pause=button(hostHooks.view(),'暂停并保存');
        return Boolean(handles?.lifecycle.ready&&handles.lifecycle.purpose==='first'
          &&handles.lifecycle.attemptId===attemptId&&pause&&!pause.props.disabled
          &&!button(hostHooks.view(),'收起讲解，独立尝试')
          &&saved?.checkpoint.view?.purpose==='first'&&saved.checkpoint.view.lessonStep==='independent');
      },{label:'recovered original independent view durable and actionable'});
    },
    async pauseAndResume(){
      const pause=button(hostHooks.view(),'暂停并保存');assert.ok(pause&&!pause.props.disabled);
      pause.props.onClick();
      await waitForObservation(()=>settle(hostHooks),()=>{
        const resume=button(hostHooks.view(),'继续学习');return Boolean(resume&&!resume.props.disabled);
      },{label:'recovered pause checkpoint completed'});
      assert.equal((await repository.read(attemptId)).startedAt,AT);
      assert.equal((await repository.read(attemptId)).checkpoint.view.paused,true);
      button(hostHooks.view(),'继续学习').props.onClick();
      await waitForObservation(()=>settle(hostHooks),()=>{
        const pause=button(hostHooks.view(),'暂停并保存');return Boolean(pause&&!pause.props.disabled&&handles?.lifecycle.ready);
      },{label:'recovered resume checkpoint completed'});
    },
    async dispose(){hostHooks.unmount();boundHooks.unmount();pageHooks.unmount();workspaceHooks?.unmount();for(let i=0;i<14;i++)await tick();await Promise.all(drivers.map(driver=>driver.runtime.session.flush()));},
  };
}
test('old-day recovery keeps normalized identity and original snapshot through the real V3 writer',async t=>{
  const f=await fixture(t);try {
    const restored=f.drivers[0].runtime.session.snapshot();assert.equal(restored.attemptId,f.original.attempt.attemptId);assert.deepEqual(restored.binding,f.original.attempt.binding);assert.equal(restored.submitted.submittedAt,AT);
    const result=await f.seam.props.context.gradeRecall({},restored.submitted.answer);assert.equal(result.feedback,'Original independent sampling reference.');assert.equal(f.requests[0].request.snapshotId,'old-snapshot');assert.equal(f.requests[0].request.contentHash,f.item.contentHash);
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Recovered old reference confirmed.'});await f.handles.grade('good',{deferAdvance:true});
    assert.equal(f.written.length,1);assert.equal(f.frames[0].kind,'account');assert.equal(f.frames[0].bundle.snapshot.snapshotId,'old-snapshot');assert.equal(f.frames[0].bundle.snapshot.snapshotHash,f.snapshot.snapshotHash);assert.equal(f.frames[0].bundle.items[0].contentHash,f.item.contentHash);assert.notEqual(f.frames[0].bundle.items[0].contentHash,f.newer.contentHash);
    assert.equal(f.written[0].event.scheduling.reviewedAt,AT);assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');assert.equal(f.records.length,1);assert.equal(f.records[0].snapshotId,'old-snapshot');assert.equal((await localAccount.getLocalStudySnapshot(f.workspaceId,f.libraryId,'old-snapshot')).items.length,21);assert.equal((await localAccount.getLocalStudySnapshot(f.workspaceId,f.libraryId)).snapshot.snapshotId,'new-current-snapshot');
  } finally {await f.dispose();}
});

test('old paused account draft resumes exact identity and a new submission publishes using current durable state',async t=>{
  const f=await fixture(t,{unsubmitted:true,freshDevice:true});try {
    assert.equal(f.original.attempt.submitted,null);assert.match(f.pausedView,/本次已暂停/);assert.equal(f.written.length,0);assert.equal(f.requests.length,0);assert.equal(f.drivers[0].runtime.session.snapshot().attemptId,f.original.attempt.attemptId);assert.equal(f.handles.draft.read('answer',''),'独立采样，避免训练记忆污染。');
    await f.handles.lifecycle.submit('独立采样，避免训练记忆污染。');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original old-source reference.'});await f.handles.grade('good',{deferAdvance:true});
    assert.equal(f.written.length,1);assert.equal(f.records.length,1);assert.equal(f.frames[0].bundle.snapshot.snapshotId,'old-snapshot');assert.equal(f.frames[0].bundle.items[0].contentHash,f.item.contentHash);assert.equal(f.original.attempt.submitted,null,'initial prop remains a draft and cannot be the publication assertion');assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');assert.equal((await localAccount.getLocalStudySnapshot(f.workspaceId,f.libraryId,'old-snapshot')).items.length,21);
  }finally{await f.dispose();}
});

test('paused guided parent restores its original instance and assisted child without grading the parent',async t=>{
  const f=await fixture(t,{unsubmitted:true,guided:true,freshDevice:true});try {
    assert.match(f.pausedView,/本次已暂停/);assert.equal(f.handles.lifecycle.purpose,'guided');assert.equal(f.handles.draft.read('answer',''),'OLD GUIDED UNFINISHED WORK');assert.equal(f.drivers[1].runtime.session.snapshot().attemptId,f.guidedId);assert.deepEqual(f.drivers[1].runtime.session.snapshot().binding,f.original.attempt.binding);assert.equal(f.written.length,0);assert.equal(f.original.attempt.submitted,null);
    await f.returnToIndependent();assert.equal(f.handles.lifecycle.purpose,'first');assert.equal(f.drivers.length,2,'returning to first reuses the original driver');assert.equal(f.handles.draft.read('answer',''),'独立采样，避免训练记忆污染。');assert.equal((await f.repository.read(f.guidedId)).answer,'OLD GUIDED UNFINISHED WORK');assert.equal(f.written.length,0);
  }finally{await f.dispose();}
});

test('guided-to-first fixture waits for both the guided flush and independent view receipt without grading',async t=>{
  const f=await fixture(t,{unsubmitted:true,guided:true,freshDevice:true});
  const guided=f.drivers[1].runtime.session,first=f.drivers[0].runtime.session;
  const save=guided.save,updateView=first.updateView,flushGate=deferred(),viewGate=deferred();
  let flushStarted=false,viewStarted=false,transition,finished=false;
  guided.save=async(...args)=>{flushStarted=true;await flushGate.promise;return save(...args);};
  first.updateView=async(...args)=>{
    if(args[0]?.view?.purpose==='first'&&args[0].view.lessonStep==='independent'){
      viewStarted=true;await viewGate.promise;
    }
    return updateView(...args);
  };
  try {
    transition=f.returnToIndependent().then(()=>{finished=true;});
    await waitForObservation(()=>settle(f.hostHooks),()=>flushStarted,{label:'recovered guided flush started'});
    await settle(f.hostHooks);
    assert.equal(finished,false,'independent entry cannot finish before the guided flush receipt');
    assert.equal(f.handles.lifecycle.purpose,'guided');
    assert.equal(f.handles.lifecycle.attemptId,f.guidedId);
    assert.equal(f.handles.draft.read('answer',''),'OLD GUIDED UNFINISHED WORK');
    assert.equal(f.written.length,0);assert.equal(f.records.length,0);
    flushGate.resolve();
    await waitForObservation(()=>settle(f.hostHooks),()=>viewStarted,{label:'recovered independent checkpoint started'});
    await settle(f.hostHooks);
    assert.equal(f.handles.lifecycle.purpose,'first');
    assert.equal(finished,false,'first driver alone does not prove the independent view is durable');
    assert.ok(button(f.hostHooks.view(),'收起讲解，独立尝试'));
    assert.equal((await f.repository.read(f.original.attempt.attemptId)).checkpoint.view.lessonStep,'guided');
    assert.equal(f.written.length,0);assert.equal(f.records.length,0);
    viewGate.resolve();await transition;
    assert.equal(f.handles.lifecycle.purpose,'first');
    assert.equal(f.handles.lifecycle.attemptId,f.original.attempt.attemptId);
    assert.equal(f.drivers.length,2,'returning to first reuses the original driver');
    assert.equal(button(f.hostHooks.view(),'收起讲解，独立尝试'),undefined);
    assert.equal(f.handles.draft.read('answer',''),'独立采样，避免训练记忆污染。');
    const parent=await f.repository.read(f.original.attempt.attemptId),child=await f.repository.read(f.guidedId);
    assert.equal(parent.checkpoint.view.purpose,'first');assert.equal(parent.checkpoint.view.lessonStep,'independent');
    assert.equal(parent.checkpoint.view.referenceSeen,true,'independent entry retains previously observed assistance');
    assert.equal(parent.submitted,null);assert.equal(parent.formal,null);
    assert.equal(child.answer,'OLD GUIDED UNFINISHED WORK');assert.equal(child.submitted,null);assert.equal(child.formal,null);
    assert.deepEqual(child.binding,parent.binding);
    assert.equal(f.written.length,0);assert.equal(f.records.length,0);assert.equal(f.requests.length,0);
  }finally{
    flushGate.resolve();viewGate.resolve();await transition;
    await waitForObservation(()=>settle(f.hostHooks),()=>f.handles.lifecycle.purpose==='first'
      &&!button(f.hostHooks.view(),'收起讲解，独立尝试'),{label:'released independent transition cleanup'});
    guided.save=save;first.updateView=updateView;await f.dispose();
  }
});

test('a paused draft cannot overwrite official evidence created before its resumed submission',async t=>{
  const f=await fixture(t,{unsubmitted:true});try {
    const {attempt}=await import('./fixtures/task-event-fixtures.mjs'),{sealStudyRecord}=await import('../app/account-study-record.ts');
    const event=await attempt('official-after-pause','2026-10-05T08:00:00Z',0,3,true,{domain:'differential-review',item:{kind:'due',key:f.item.itemKey}}),record=await sealStudyRecord({schemaVersion:1,libraryId:f.libraryId,snapshotId:f.head.snapshotId,contentHash:f.newer.contentHash,originDeviceId:'other',provenanceMode:'verified-round',practiceMode:'recall',roundId:'later-round',attemptId:'later-attempt',parentEventId:null,event});f.records.push(record);
    await f.handles.lifecycle.submit('独立采样，避免训练记忆污染。');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original reference.'});await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|回执|暂停后/);assert.equal(f.written.length,0);assert.equal(f.closed.length,0);assert.ok((await f.repository.read(f.original.attempt.attemptId)).submitted);
  }finally{await f.dispose();}
});

test('repeated autosaves and pauses cannot move the original first-start boundary past later official evidence',async t=>{
  const f=await fixture(t,{unsubmitted:true,laterAutosave:true});try {
    assert.equal(f.original.attempt.startedAt,AT);assert.ok(Date.parse(f.original.attempt.updatedAt)>Date.parse('2026-10-05T08:00:00Z'));
    for(let i=0;i<2;i++)await f.pauseAndResume();
    const {attempt}=await import('./fixtures/task-event-fixtures.mjs'),{sealStudyRecord}=await import('../app/account-study-record.ts');
    const event=await attempt('later-than-immutable-first','2026-10-05T08:00:00Z',0,3,true,{domain:'differential-review',item:{kind:'due',key:f.item.itemKey}});f.records.push(await sealStudyRecord({schemaVersion:1,libraryId:f.libraryId,snapshotId:f.head.snapshotId,contentHash:f.newer.contentHash,originDeviceId:'other',provenanceMode:'verified-round',practiceMode:'recall',roundId:'later-round',attemptId:'later-attempt',parentEventId:null,event}));
    await f.handles.lifecycle.submit('独立采样，避免训练记忆污染。');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original reference.'});await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|回执|暂停后/);assert.equal(f.written.length,0);assert.equal(f.closed.length,0);assert.equal((await f.repository.read(f.original.attempt.attemptId)).startedAt,AT);
  }finally{await f.dispose();}
});

test('pause and resume wait for the real delayed checkpoint without moving first-start or writing a grade',async t=>{
  const f=await fixture(t,{unsubmitted:true,laterAutosave:true});
  const session=f.drivers[0].runtime.session,updateView=session.updateView;
  const release=deferred();let checkpointStarted=false;
  session.updateView=async(...args)=>{
    if(args[0]?.view?.paused===true){checkpointStarted=true;await release.promise;}
    return updateView(...args);
  };
  try {
    let settled=false;
    const transition=f.pauseAndResume().then(()=>{settled=true;return {ok:true};},error=>{settled=true;return {ok:false,error};});
    await waitForObservation(()=>settle(f.hostHooks),()=>checkpointStarted,{label:'actual pause checkpoint started'});
    await settle(f.hostHooks);
    assert.equal(button(f.hostHooks.view(),'继续学习'),undefined,'resume is unavailable before the real save returns');
    assert.equal(settled,false,'the fixture must await the durable paused view');
    release.resolve();
    const result=await transition;
    assert.equal(result.ok,true,result.error?.stack);
    const saved=await f.repository.read(f.original.attempt.attemptId);
    assert.equal(saved.startedAt,AT);
    assert.equal(saved.checkpoint.view.paused,false);
    assert.equal(f.handles.lifecycle.attemptId,f.original.attempt.attemptId);
    assert.equal(f.written.length,0);assert.equal(f.records.length,0);
  }finally{release.resolve();session.updateView=updateView;await f.dispose();}
});

test('legacy draft without startedAt remains unknown: other official evidence blocks, absence permits explicit submit',async t=>{
  for(const existingOfficial of [true,false]){
    const f=await fixture(t,{cloud:false,nativeFrame:'b'.repeat(64),unsubmitted:true,legacyStartedAt:true});try {
      assert.equal(Object.hasOwn(f.original.attempt,'startedAt'),false);assert.equal(Object.hasOwn(await f.repository.read(f.original.attempt.attemptId),'startedAt'),false);assert.equal(f.written.length,0);
      if(existingOfficial){const {attempt}=await import('./fixtures/task-event-fixtures.mjs'),{sealStudyRecord}=await import('../app/account-study-record.ts');const event=await attempt('unknown-prior-boundary','2026-09-30T08:00:00Z',0,3,true,{domain:'differential-review',item:{kind:'due',key:f.item.itemKey}});f.records.push(await sealStudyRecord({schemaVersion:1,libraryId:f.libraryId,snapshotId:f.head.snapshotId,contentHash:f.newer.contentHash,originDeviceId:'other',provenanceMode:'verified-round',practiceMode:'recall',roundId:'prior-round',attemptId:'prior-attempt',parentEventId:null,event}));}
      await f.handles.lifecycle.submit('独立采样，避免训练记忆污染。');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original reference.'});
      if(existingOfficial){await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|回执|暂停后/);assert.equal(f.written.length,0);assert.equal(f.closed.length,0);}else{await f.handles.grade('good',{deferAdvance:true});assert.equal(f.written.length,1);assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');}
      assert.equal(Object.hasOwn(await f.repository.read(f.original.attempt.attemptId),'startedAt'),false,'saving, submission and grading must not backfill a historical start time');
    }finally{await f.dispose();}
  }
});
test('later official evidence for the item blocks historical publication even when its content version differs',async t=>{
  const f=await fixture(t);try {
    const {attempt}=await import('./fixtures/task-event-fixtures.mjs'),{sealStudyRecord}=await import('../app/account-study-record.ts');
    const event=await attempt('later-new-version','2026-10-05T08:00:00Z',0,3,true,{domain:'differential-review',item:{kind:'due',key:f.item.itemKey}}),record=await sealStudyRecord({schemaVersion:1,libraryId:f.libraryId,snapshotId:f.head.snapshotId,contentHash:f.newer.contentHash,originDeviceId:'other',provenanceMode:'verified-round',practiceMode:'recall',roundId:'later-round',attemptId:'later-attempt',parentEventId:null,event});f.records.push(record);
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original old result.'});await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|更新|核对/);
    assert.equal(f.written.length,0);assert.equal(f.frames.length,0);assert.equal((await f.repository.read(f.original.attempt.attemptId)).submitted.answer,f.original.attempt.submitted.answer);
  } finally {await f.dispose();}
});
test('an existing claimed server core links through actual trusted records without invoking the V3 writer again',async t=>{
  const f=await fixture(t,{claimed:true,serverCore:true});try {
    await f.handles.grade('good',{deferAdvance:true});assert.equal(f.written.length,0);assert.equal(f.frames.length,0);assert.equal(f.records.length,1);
    const current=f.drivers[0].runtime.session.snapshot();assert.equal(current.formal.status,'linked');assert.equal(current.formal.coreHash,f.records[0].event.coreHash);assert.equal(current.checkpoint.traversed,false);
    await f.handles.grade('good',{deferAdvance:true});assert.equal(f.written.length,0);assert.equal(f.records.length,1);
  } finally {await f.dispose();}
});
test('missing exact native association blocks before writing any unbound formal event',async t=>{
  const f=await fixture(t,{cloud:false});try {
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original local reference.'});await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|本机|未绑定/);assert.equal(f.written.length,0);assert.equal(f.frames.length,0);assert.equal(await localEvents.getLocalStudyEvent(f.workspaceId,f.drivers[0].runtime.session.snapshot().formal.eventId),undefined);
  } finally {await f.dispose();}
});
test('verified native frame produces a real journal association and links its durable original core',async t=>{
  const f=await fixture(t,{cloud:false,nativeFrame:'b'.repeat(64)});try {
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original native reference.'});await f.handles.grade('good',{deferAdvance:true});assert.equal(f.written.length,1);
    const current=f.drivers[0].runtime.session.snapshot(),journal=await journalApi.createSubmissionJournal().get(f.workspaceId,current.formal.eventId);assert.equal(journal.coreStored,true);assert.equal(journal.payload.route.kind,'local');assert.equal(journal.payload.route.binding.localBindingHash,'b'.repeat(64));assert.equal(journal.payload.route.binding.contentHash,f.item.contentHash);assert.equal(current.formal.status,'linked');
  } finally {await f.dispose();}
});
test('recovered child inherits the exact normalized old binding while using a separate attempt identity',async t=>{
  const f=await fixture(t);try {
    const child=await f.hostProps.createDriver('remediation','review',f.original.attempt.attemptId,'fixed-child-instance');await child.runtime.session.submit('Separate child draft.','observed');
    const state=child.runtime.session.snapshot();assert.deepEqual(state.binding,f.original.attempt.binding);assert.notEqual(state.attemptId,f.original.attempt.attemptId);assert.equal(state.parentAttemptId,f.original.attempt.attemptId);assert.equal(state.formal,null);
  } finally {await f.dispose();}
});
test('source/account cancellation before formal submission cannot publish a recovered result',async t=>{
  const f=await fixture(t);try {
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Old source check.'});f.setCurrent(false);await assert.rejects(f.handles.grade('good',{deferAdvance:true}),/尚未保存|切换|回执/);assert.equal(f.written.length,0);assert.equal(f.closed.length,0);
    for(const changed of [{ownerId:'other'},{libraryId:'other'},{contentHash:f.newer.contentHash},{snapshotId:f.head.snapshotId}])await assert.rejects(runtime.createNonWordRuntime({...f.seam.props.context.nonWordScope,...changed},'recall',{existing:f.original.attempt,binding:f.original.attempt.binding}),/身份|匹配/);
  } finally {await f.dispose();}
});
test('original-question service rejects a later-version reply and retains its retry identity',async t=>{
  const f=await fixture(t);try {
    const hooks=createHooks(),load=loader(hooks.api,{'src/infrastructure/learning-attempt/index.ts':attemptInfrastructure,'app/local-study-db.ts':localDb}),service=load('app/study-dashboard/original-question-service.ts').originalQuestionService;const packets=[];
    const request=service(f.workspaceId,f.original.attempt,async packet=>{packets.push(packet);return {result:{...packet.request,contentHash:f.newer.contentHash,text:'Wrong new reference.'}};});
    await assert.rejects(request('recall-grade',f.original.attempt.submitted.answer),/版本不一致/);await assert.rejects(request('recall-grade',f.original.attempt.submitted.answer),/版本不一致/);assert.equal(packets[0].requestId,packets[1].requestId);assert.equal(f.written.length,0);
  } finally {await f.dispose();}
});
test('complete old bundle recovery rejects substituted pages and an owner switch before caching',async t=>{
  const f=await fixture(t);try {
    const realFetch=globalThis.fetch;let cached=0,current=true;const requests=[];
    const options={binding:f.original.attempt.binding,snapshot:f.snapshot,current:()=>current,parseItem:content.parseStudyItem,validateBundle:content.validateStudyBundle,cache:async bundle=>{cached++;return localAccount.cacheLocalStudySnapshot(f.workspaceId,bundle);}};
    const substituted=async(url,init)=>{requests.push(new URL(url,'https://recover.invalid'));const response=await realFetch(url,init),page=await response.json();if(page.items?.length&&requests.length===1)page.items[0]=f.newer;return Response.json(page,{status:response.status});};
    await assert.rejects(runtime.cacheOriginalPendingBundle({...options,fetcher:substituted}));assert.equal(cached,0);assert.ok(requests.length>=2);for(const request of requests){assert.equal(request.searchParams.get('expectedUserId'),f.owner);assert.equal(request.searchParams.get('snapshotId'),'old-snapshot');}
    await assert.rejects(runtime.cacheOriginalPendingBundle({...options,fetcher:async(url,init)=>{const response=await realFetch(url,init);current=false;return response;}}),/owner-changed/);assert.equal(cached,0);assert.equal((await localAccount.getLocalStudySnapshot(f.workspaceId,f.libraryId)).snapshot.snapshotId,'new-current-snapshot');
  } finally {await f.dispose();}
});
test('two concurrent recovered save clicks publish the canonical old first answer exactly once',async t=>{
  const f=await fixture(t);try {
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original source confirmation.'});await Promise.all([f.handles.grade('good',{deferAdvance:true}),f.handles.grade('good',{deferAdvance:true})]);
    assert.equal(f.written.length,1);assert.equal(f.records.length,1);assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');
    await f.handles.grade('good',{deferAdvance:true});assert.equal(f.written.length,1);assert.equal(f.records.length,1);
  } finally {await f.dispose();}
});
test('an already-started old-owner write can finish durably but a late receipt never advances the replacement workspace',async t=>{
  const gate=deferred(),f=await fixture(t,{persistGate:gate});try {
    await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Original source confirmation.'});const saving=f.handles.grade('good',{deferAdvance:true});
    for(let i=0;i<60&&!f.written.length;i++)await tick();assert.equal(f.written.length,1);f.setCurrent(false);gate.resolve();await assert.rejects(saving,/尚未保存|回执|切换/);
    const stored=await journalApi.createSubmissionJournal().get(f.workspaceId,f.written[0].eventId);assert.equal(stored.coreStored,true);assert.equal(stored.payload.workspaceId,f.workspaceId);assert.equal(stored.payload.route.record.snapshotId,'old-snapshot');assert.equal(f.closed.length,0);assert.equal(f.records.length,0);
  } finally {gate.resolve();await f.dispose();}
});
test('the mounted page shares one source-bound coordinator and rejects a late continuation from a replaced run',async t=>{
  const f=await fixture(t);try {
    const hooks=createHooks(),load=loader(hooks.api,{'src/infrastructure/nonword-study/index.ts':runtime,'src/application/nonword-study/index.ts':application});const cache=load('app/study-dashboard/nonword-round-cache.ts');
    hooks.mount(()=>cache.useNonWordRoundCache(),{});const get=hooks.view(),members=f.oldItems.slice(0,2).map(item=>({itemKey:item.itemKey,snapshotId:f.snapshot.snapshotId,contentHash:item.contentHash,kind:'practice',mode:'recall'}));
    const scope={workspaceId:f.workspaceId,ownerId:f.owner,libraryId:f.libraryId,itemKey:f.item.itemKey,snapshotId:f.snapshot.snapshotId,contentHash:f.item.contentHash,groupId:'normal-managed-group',roundId:'normal-managed-base',day:'2026-10-06',members,cloud:false};
    const empty={correctKeys:[],wrongKeys:[],awaitingReviewKeys:[],skippedKeys:[]},[first,same]=await Promise.all([get(scope,{currentItemKey:f.item.itemKey,traversal:empty}),get({...scope},{currentItemKey:'neighbor-1',traversal:{...empty,wrongKeys:[f.item.itemKey]}})]);
    assert.equal(first,same);assert.equal((await first.read()).currentItemKey,f.item.itemKey);const initial=await first.read();
    await application.continueNonWordRound(first,f.item.itemKey,'pending',initial.runId);assert.equal((await first.read()).currentItemKey,'neighbor-1');assert.deepEqual((await first.read()).traversal.awaitingReviewKeys,[f.item.itemKey]);
    await first.startNewRound({restartConfirmed:true});const newRun=await first.read();await assert.rejects(application.continueNonWordRound(first,'neighbor-1','good',initial.runId),/run-conflict/);assert.deepEqual((await first.read()).traversal,newRun.traversal);hooks.unmount();
  } finally {await f.dispose();}
});
test('actual pending-then-skip UI state is sanitized into a valid truthful cursor projection',async t=>{
  const f=await fixture(t);try {
    const hooks=createHooks(),load=loader(hooks.api,{'src/infrastructure/nonword-study/index.ts':runtime,'src/application/nonword-study/index.ts':application});const cache=load('app/study-dashboard/nonword-round-cache.ts');
    const itemKeys=[f.item.itemKey,'neighbor-1'],pending=planning.awaitSubjectReview(planning.emptySubjectRound(),itemKeys,0).round,skipped=planning.skipSubjectRound(pending,itemKeys,0).round;
    assert.ok(skipped.awaitingReviewKeys.includes(f.item.itemKey));assert.ok(skipped.skippedKeys.includes(f.item.itemKey));
    const members=f.oldItems.slice(0,2).map(item=>({itemKey:item.itemKey,snapshotId:f.snapshot.snapshotId,contentHash:item.contentHash,kind:'practice',mode:'recall'})),scope={workspaceId:f.workspaceId,ownerId:f.owner,libraryId:f.libraryId,itemKey:f.item.itemKey,snapshotId:f.snapshot.snapshotId,contentHash:f.item.contentHash,groupId:'overlap-group',roundId:'overlap-base',day:'2026-10-06',members,cloud:false};
    const seed=cache.cursorSeed(scope,skipped,'neighbor-1'),round=await runtime.createNonWordRoundRuntime({scope:{ownerId:f.owner,libraryId:f.libraryId,groupId:scope.groupId,day:scope.day,cloud:false},members,initialCursor:seed});
    const stored=await round.read();assert.deepEqual(stored.traversal.awaitingReviewKeys,[f.item.itemKey]);assert.deepEqual(stored.traversal.skippedKeys,[]);assert.deepEqual(stored.traversal.correctKeys,[]);hooks.unmount();
  } finally {await f.dispose();}
});
