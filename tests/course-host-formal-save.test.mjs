import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,button,nodes,text,deferred,tick} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {nativeCourseTask,attachNativeCourseDriver} from '../src/infrastructure/course-study/native-host-runtime.ts';
import {createNonWordRuntime,restoredFields,recoveryFields,rawAnswer,evaluationPhase} from '../src/infrastructure/nonword-study/index.ts';
import {evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {resolveCourseTask,courseTaskHash,courseDiagnosticHash,attemptEvaluationForDiagnostic} from '../src/domain/course-study/index.ts';

globalThis.indexedDB=new IDBFactory();
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
let serial=0;

async function nativeFixture(){
  const support=structuredClone(fixtures.cases.find(row=>row.valid&&row.mode==='recall').support);
  support.criteria.push({id:'extra',text:'说明放入次序与取出次序之间的关系。',mandatory:true,sourceIds:['section']});
  const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:'practice:formal-course',contentHash:'b'.repeat(64),learningSupport:support,
    practice:{questionType:'recall',prompt:support.task.prompt,domain:'course'}};
  const identity={schemaVersion:1,libraryId:`local-vault:${'a'.repeat(64)}`,itemKey:item.itemKey,contentHash:item.contentHash,localBindingHash:'c'.repeat(64)};
  const body={schemaVersion:1,identity,item,taskHash:await courseTaskHash(resolveCourseTask(item))};
  const capture={...body,captureId:await studyHash(body)};
  const ownerId=`course-formal-owner-${serial++}`;
  const scope={workspaceId:`local:${ownerId}`,ownerId,libraryId:identity.libraryId,snapshotId:'local',itemKey:item.itemKey,contentHash:item.contentHash,
    groupId:'course-group',roundId:'course-round',cloud:false,nativeCourseIdentity:identity,nativeCoursePresentation:item};
  return {scope,capture};
}
async function gradeReceipt(request,capture,status){
  const task=resolveCourseTask(capture.item,request.taskId),pending=status==='undetermined';
  const matched=pending?[]:status==='partial'?task.criteria.slice(0,1):task.criteria;
  const diagnostic={schemaVersion:1,status,source:pending?'none':'model',feedback:pending?'AI unavailable; original retained.':'Synthetic source-bound comparison.',
    matchedPointIds:matched.map(point=>point.id),missedPointIds:status==='partial'?task.criteria.slice(1).map(point=>point.id):[],
    errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:matched.map(point=>({pointId:point.id,sourceId:point.sourceIds[0],
      sourceQuote:task.sources.find(source=>source.sourceId===point.sourceIds[0]).excerpt,answerQuote:request.submission.answer,reason:'Quoted synthetic comparison.'})),
    ...(pending?{reason:'unavailable'}:{})};
  const trace=pending?null:{modelId:'synthetic',promptVersion:'fixture-v1',ruleVersion:'fixture-v1',requestId:request.requestId};
  const evaluation=attemptEvaluationForDiagnostic(diagnostic,request.binding.contentHash);
  const {action,submission,...echo}=request;assert.equal(action,'evaluate');assert.ok(submission);
  const body={...echo,durable:true,originRequestId:request.requestId,answerRevision:submission.answerRevision,diagnostic,trace,
    diagnosticHash:await courseDiagnosticHash(diagnostic,trace),attemptEvaluationHash:evaluation.status==='resolved'?await evaluationFingerprint(evaluation):null,
    remediationTaskId:null};
  return {...body,receiptHash:await studyHash(body)};
}

/** Mount the current production host. Only its plugin-rendering slot is surfaced to this hooks harness. */
async function mountHost({course=true,status='correct',claimGate,failWriterOnce=false}={}){
  const f=await nativeFixture(),hooks=createHooks(),drivers=[],formal=[],claimEntered=[],claimAccepted=[],requests=[];
  const store=createLearningDraftStore(f.scope.workspaceId),rawDraft=store.adapter(f.scope.itemKey,'recall');
  const policyReads=[],read=rawDraft.read.bind(rawDraft);
  const draft={...rawDraft,read(field,fallback){
    if(field==='recallAttempt'){policyReads.push(field);return null;}
    return read(field,fallback);
  }};
  let handles,core=null,fail=failWriterOnce;
  const transport={supported:()=>true,capture:async identity=>{assert.deepEqual(identity,f.capture.identity);return f.capture;},
    read:async()=>f.capture,grade:async request=>{requests.push(structuredClone(request));return gradeReceipt(request,f.capture,status);},
    claim:async request=>{
      claimEntered.push(structuredClone(request));await claimGate?.promise;
      const receipt={schemaVersion:1,durable:true,status:claimAccepted.length?'duplicate':'accepted',eventId:request.eventId,claimHash:await studyHash(request)};
      claimAccepted.push(structuredClone(request));return receipt;
    }};
  const props={bindingKey:JSON.stringify(f.scope),mode:'recall',draft,reference:'Synthetic original reference',recallConfigured:true,
    async createDriver(purpose,intent,parentAttemptId,instanceId,taskId){
      const prepared=course?await nativeCourseTask(f.scope,purpose,parentAttemptId,taskId,transport):null;
      const runtime=await createNonWordRuntime(f.scope,'recall',{purpose,intent,parentAttemptId,instanceId,
        verifyFormalEvent:async eventId=>core?.eventId===eventId?core:null});
      let driver={runtime,restore:()=>restoredFields(runtime.session.snapshot(),'recall'),fields:values=>recoveryFields('recall',values),
        answer:values=>rawAnswer('recall',values),phase:()=>evaluationPhase(runtime.session.snapshot()),verifiedCore:async()=>core?.coreHash??null};
      if(prepared)driver=await attachNativeCourseDriver(driver,runtime,prepared,transport);
      drivers.push(driver);return driver;
    },
    renderPlugin(current,lifecycle,onGrade){handles={draft:current,lifecycle,onGrade};return 'Learner intent seam';},
    async onGrade(rating,options){
      const original=drivers[0].runtime.session.snapshot();
      if(course){
        assert.ok(claimAccepted.length,'official writer must wait for a validated native claim');
        const claim=claimAccepted.at(-1);
        assert.equal(claim.attemptId,original.attemptId);assert.deepEqual(claim.binding,original.binding);
        assert.equal(claim.eventId,options.identity.eventId);assert.equal(claim.occurredAt,options.identity.reviewedAt);
        assert.equal(claim.rating,rating);assert.equal(claim.attemptEvaluationHash,original.evaluation.evaluationHash);
      }
      formal.push({rating,...structuredClone(options),attemptId:original.attemptId,submission:structuredClone(original.submitted)});
      if(fail){fail=false;throw Error('Synthetic official receipt unavailable');}
      core={eventId:options.identity.eventId,coreHash:'d'.repeat(64),itemKey:f.scope.itemKey,contentHash:f.scope.contentHash,
        reviewedAt:options.identity.reviewedAt,rating};
      return {status:'saved'};
    },
    continuePending(){},resumeFormal(){},renderMath:value=>value,
  };
  function render(){
    hooks.render();hooks.flush();
    for(const node of nodes(hooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function')node.type(node.props);
  }
  async function until(predicate,label){
    const deadline=Date.now()+10000;
    do{render();if(await predicate())return;await tick();}while(Date.now()<deadline);
    assert.fail(`${label}; host view: ${text(hooks.view())}`);
  }
  hooks.mount(loader(hooks.api)('src/features/nonword-study/host.tsx').NonWordStudyHost,props);
  await until(()=>handles?.lifecycle.ready&&drivers.length===1,'actual host did not enter its ready plugin slot');
  return {...f,hooks,drivers,formal,claimEntered,claimAccepted,requests,policyReads,rawDraft,render,until,get handles(){return handles;},
    async answer(value){handles.draft.write('answer',value);await handles.lifecycle.submit(value);render();},
    async close(){hooks.unmount();await drivers[0].runtime.session.flush();},
  };
}

test('actual shared course host saves checkpoint, bypasses absent legacy policy, waits for native claim and retries the same first formal identity',async()=>{
  const gate=deferred(),h=await mountHost({status:'partial',claimGate:gate,failWriterOnce:true});
  try{
    assert.equal(h.handles.draft.read('recallAttempt',null),null);
    await h.answer('最后放入的元素最先取出。');
    const original=h.drivers[0].runtime.session.snapshot();
    assert.equal(original.checkpoint.pluginFields.answer,original.submitted.answer,'real V1 checkpoint accepts the course driver fields');
    const evidence=await h.handles.lifecycle.course.evaluate();assert.equal(evidence.diagnostic.status,'partial');
    const operation=h.handles.onGrade('hard',{deferAdvance:true}),rejected=assert.rejects(operation,/official receipt unavailable/);
    await h.until(()=>h.claimEntered.length===1,'native formal claim was not entered');
    assert.equal(h.claimAccepted.length,0);assert.equal(h.formal.length,0,'official callback cannot race ahead of Companion receipt');
    const reserved=h.drivers[0].runtime.session.snapshot().formal;assert.equal(reserved.status,'claimed');
    gate.resolve();await rejected;
    assert.equal(h.formal[0].rating,'hard');assert.equal(h.formal[0].identity.eventId,reserved.eventId);
    h.render();await h.handles.onGrade('hard',{deferAdvance:true});
    assert.equal(h.formal.length,2);assert.deepEqual(h.formal[0].identity,h.formal[1].identity);
    assert.deepEqual(h.formal[1].submission,original.submitted);
    const saved=await h.drivers[0].runtime.repository.read(original.attemptId);
    assert.equal(saved.attemptId,original.attemptId);assert.deepEqual(saved.binding,original.binding);
    assert.deepEqual(saved.submitted,original.submitted);assert.equal(saved.formal.status,'linked');
    assert.equal(saved.evaluation.source,'model');assert.equal(saved.evaluation.rating,'hard');
  }finally{gate.resolve();await h.close();}
});

test('actual course host retains frozen reference assistance and caps a correct answer at again without legacy policy',async()=>{
  const h=await mountHost();
  try{
    button(h.hooks.view(),'深入学习').props.onClick();
    await h.until(()=>[...nodes(h.hooks.view())].some(node=>node.props['aria-label']==='学习讲解'),'learn reference view did not open');
    button(h.hooks.view(),'日常复习').props.onClick();
    await h.until(()=>h.handles.lifecycle.intent==='review'&&![...nodes(h.hooks.view())].some(node=>node.props['aria-label']==='学习讲解'),'review plugin did not return');
    assert.equal(h.handles.draft.read('recallAttempt',null),null);
    await h.answer('最后放入的元素最先取出。');
    const original=h.drivers[0].runtime.session.snapshot();
    assert.equal(original.submitted.maxPreHintLevel,3);assert.equal(original.submitted.answerRevealed,true);
    await h.handles.lifecycle.course.evaluate();await h.handles.onGrade('good',{deferAdvance:true});
    assert.equal(h.formal.length,1);assert.equal(h.formal[0].rating,'again');assert.equal(h.claimAccepted[0].rating,'again');
    const saved=h.drivers[0].runtime.session.snapshot();assert.deepEqual(saved.submitted,original.submitted);
    assert.equal(saved.evaluation.rating,'good','diagnosis remains correct while scheduling reflects frozen help');
    assert.equal(saved.formal.rating,'again');assert.equal(saved.formal.status,'linked');
    assert.equal(h.requests[0].submission.maxPreHintLevel,3);
  }finally{await h.close();}
});

test('actual shared host refuses unresolved course grade intent before native or official formal writing',async()=>{
  const h=await mountHost({status:'undetermined'});
  try{
    await h.answer('Unresolved original answer.');await h.handles.lifecycle.course.evaluate();
    await assert.rejects(h.handles.onGrade('good',{deferAdvance:true}));
    assert.equal(h.formal.length,0);assert.equal(h.claimEntered.length,0);assert.equal(h.claimAccepted.length,0);
    const saved=h.drivers[0].runtime.session.snapshot();
    assert.equal(saved.submitted.answer,'Unresolved original answer.');assert.equal(saved.evaluation.status,'pending');assert.equal(saved.formal,null);
    assert.equal(h.handles.lifecycle.course.evidence().diagnostic.status,'undetermined');
  }finally{await h.close();}
});

test('actual legacy recall host still rejects unready configured recall policy',async()=>{
  const h=await mountHost({course:false});
  try{
    await h.answer('Legacy original answer.');
    await h.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Synthetic legacy result.'});
    assert.equal(h.handles.draft.read('recallAttempt',null),null);
    await assert.rejects(h.handles.onGrade('good',{deferAdvance:true}),/study-attempt-policy-unready/);
    assert.equal(h.policyReads.length>0,true);assert.equal(h.formal.length,0);assert.equal(h.claimEntered.length,0);
    const saved=h.drivers[0].runtime.session.snapshot();assert.equal(saved.formal,null);assert.equal(saved.submitted.answer,'Legacy original answer.');
  }finally{await h.close();}
});
