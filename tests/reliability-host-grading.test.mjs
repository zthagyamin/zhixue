import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,button,nodes,text,deferred,tick,waitForObservation} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields,evaluationPhase} from '../src/infrastructure/nonword-study/index.ts';

const support={schemaVersion:1,type:'quiz',selection:'multiple',options:[{optionId:'a',text:'Claim A'},{optionId:'b',text:'Claim B'},{optionId:'c',text:'Wrong claim'}],correctOptionIds:['a','b']};
const data={prompt:'Select supported claims',learningSupport:support};
const empty=()=>({selection:[],first:null,phase:'answer',retry:null});
const continueLabel='跳过补练或结束补练，继续';
let serial=0;

/** Real quiz -> real host lifecycle -> real local attempt journal -> formal-writer boundary.
 * Only the source-service response and final durable core receipt are synthetic.
 */
async function fixture({source=false,required=source,sourceStatus='confirmed',writerGate}={}){
 globalThis.indexedDB=new IDBFactory();const id=++serial;
 const scope={workspaceId:`local:host-grading-${id}`,ownerId:`host-grading-${id}`,libraryId:'synthetic-quiz-library',snapshotId:'synthetic',
  itemKey:'multiple-choice',contentHash:'a'.repeat(64),groupId:'synthetic-group',roundId:'synthetic-round',cloud:false,sourceConfirmationRequired:required};
 const hostHooks=createHooks(),quizHooks=createHooks(),drivers=[],formal=[],intents=[],claims=[],admissions=[],moves=[];
 const store=createLearningDraftStore(scope.workspaceId),draft=store.adapter(scope.itemKey,'quiz');
 let handles,core=null,quizMounted=false,sourceVerdict=sourceStatus,gradeFlight=null;
 const outcome=attempt=>{
  const selected=JSON.parse(attempt.submitted.answer),correct=selected.includes('a')&&selected.includes('b');
  const status=sourceVerdict==='changed'?'correct':correct?'correct':'partial';
  return {status,source:'deterministic',rating:status==='correct'?'good':'hard',explanation:'Synthetic comparison with the bound original options.'};
 };
 const props={bindingKey:JSON.stringify(scope),mode:'quiz',draft,reference:'Both A and B are supported.',recallConfigured:false,sourceConfirmationRequired:required,
  async createDriver(purpose,intent,parentAttemptId,instanceId){
   const runtime=await createNonWordRuntime(scope,'quiz',{purpose,intent,parentAttemptId,instanceId,
    ...(source?{sourceAdmission:async attempt=>{
     admissions.push({attemptId:attempt.attemptId,answer:attempt.submitted.answer});
     return sourceVerdict==='pending'?{status:'pending',reason:'Synthetic original source awaits confirmation.'}:{status:'confirmed',outcome:outcome(attempt)};
    }}:{}),verifyFormalEvent:async eventId=>core?.eventId===eventId?core:null});
   const driver={runtime,restore:()=>restoredFields(runtime.session.snapshot(),'quiz'),fields:values=>recoveryFields('quiz',values),
    answer:values=>rawAnswer('quiz',values),phase:()=>evaluationPhase(runtime.session.snapshot()),verifiedCore:async()=>core?.coreHash??null,
    ...(source?{source:{supported:()=>true,review:async()=>{},beforeFormal:async()=>{
     const attempt=runtime.session.snapshot();assert.equal(attempt.evaluation.rating,'hard');assert.equal(attempt.formal.rating,'hard');claims.push(attempt.attemptId);
    }}}:{})};
   drivers.push(driver);return driver;
  },
  renderPlugin(current,lifecycle,onGrade){handles={draft:current,lifecycle,onGrade};return 'Real quiz mounted by its own hook scope';},
  async onGrade(rating,options){
   const first=drivers[0].runtime.session.snapshot();
   assert.equal(first.formal.eventId,options.identity.eventId);assert.equal(first.formal.rating,rating);
   assert.equal(first.evaluation.status,'resolved');assert.equal(first.evaluation.rating,'hard');
   if(source)assert.equal(claims.length,1,'source claim must finish before formal callback');
   formal.push({rating,...structuredClone(options),submission:structuredClone(first.submitted)});
   await writerGate?.promise;
   core={eventId:options.identity.eventId,coreHash:'c'.repeat(64),itemKey:scope.itemKey,contentHash:scope.contentHash,reviewedAt:options.identity.reviewedAt,rating};
   return {status:'saved'};
  },
  continuePending:()=>moves.push('pending'),resumeFormal:rating=>moves.push(rating),renderMath:value=>value,
 };
 const Host=loader(hostHooks.api)('src/features/nonword-study/host.tsx').NonWordStudyHost;
 const Quiz=loader(quizHooks.api)('src/features/nonword-study/quiz.tsx').NonWordQuiz;
 function render(){
  hostHooks.render();hostHooks.flush();
  for(const node of nodes(hostHooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function')node.type(node.props);
  if(handles?.lifecycle.ready){
   const quiz=Quiz({data,state:handles.draft.read('nonwordQuizState',empty()),
    setState:next=>{const state=handles.draft.read('nonwordQuizState',empty());handles.draft.write('nonwordQuizState',typeof next==='function'?next(state):next);},
    lifecycle:handles.lifecycle,pending:()=>handles.lifecycle.sourcePending,hasSavedFeedback:()=>handles.draft.hasSavedFeedback(),
    continueAfterFeedback:()=>handles.draft.continueAfterFeedback(),onGrade:rating=>{
     intents.push(rating);gradeFlight=handles.onGrade(rating);return gradeFlight;
    },renderMath:value=>value});
   if(!quizMounted){quizHooks.mount(quiz.type,quiz.props);quizMounted=true;}else quizHooks.render(quiz.props);
   quizHooks.flush();
  }
 }
 const until=(observed,label)=>waitForObservation(async()=>{await tick();render();},observed,{label});
 hostHooks.mount(Host,props);hostHooks.flush();await until(()=>Boolean(handles?.lifecycle.ready&&quizMounted),'real quiz/host readiness');
 return {scope,drivers,formal,intents,claims,admissions,moves,render,until,get handles(){return handles;},
  get quizState(){return handles.draft.read('nonwordQuizState',empty());},get gradeFlight(){return gradeFlight;},
  view:()=>quizHooks.view(),hostView:()=>hostHooks.view(),setSourceVerdict:next=>{sourceVerdict=next;},
  choose(label){const choice=[...nodes(quizHooks.view())].find(node=>node.type==='button'&&text(node).includes(label));assert.ok(choice);assert.equal(choice.props.disabled,false);choice.props.onClick();render();},
  async submitPartial(){this.choose('Claim A');button(this.view(),'提交答案').props.onClick();await until(()=>this.quizState.first!==null,'partial feedback after durable assessment');},
  async close(){quizHooks.unmount();hostHooks.unmount();await tick();await Promise.all(drivers.map(driver=>driver.runtime.session.flush()));},
 };
}

for(const source of [false,true])for(const remediation of [false,true]){
 test(`F02 actual quiz and host preserve partial/hard through ${remediation?'completed remediation':'skip remediation'} ${source?'with':'without'} sourceAdmission`,async()=>{
  const gate=deferred(),f=await fixture({source,writerGate:gate});
  try{
   await f.submitPartial();const first=structuredClone(f.drivers[0].runtime.session.snapshot()),firstUi=structuredClone(f.quizState.first);
   assert.equal(first.evaluation.outcome,'partial');assert.equal(first.evaluation.rating,'hard');assert.equal(first.submitted.answer,'["a"]');
   assert.equal(f.formal.length,0);assert.equal(f.quizState.first.result.status,'partial');
   if(remediation){
    button(f.view(),'收起解释，再试一次').props.onClick();f.render();f.choose('Claim A');f.choose('Claim B');
    button(f.view(),'核对这次补练').props.onClick();await f.until(()=>f.quizState.retry?.status==='correct','real auxiliary remediation persisted');
    const child=f.drivers.find(driver=>driver.runtime.purpose==='remediation').runtime.session.snapshot();
    assert.equal(child.parentAttemptId,first.attemptId);assert.equal(child.submitted.answer,'["a","b"]');assert.equal(child.evaluation.rating,'good');assert.equal(child.formal,null);
    assert.deepEqual(f.drivers[0].runtime.session.snapshot().submitted,first.submitted);assert.deepEqual(f.drivers[0].runtime.session.snapshot().evaluation,first.evaluation);assert.deepEqual(f.quizState.first,firstUi);
   }
   const finish=button(f.view(),continueLabel);assert.ok(finish);assert.equal(finish.props.disabled,false);finish.props.onClick();finish.props.onClick();
   await f.until(()=>f.formal.length===1,'one formal callback from the real partial button');assert.deepEqual(f.intents,['hard']);
   assert.equal(f.formal[0].rating,'hard');assert.deepEqual(f.formal[0].submission,first.submitted);
   gate.resolve();await f.gradeFlight;await f.until(()=>f.drivers[0].runtime.session.snapshot().formal?.status==='linked','durable formal receipt linked');
   const stored=await f.drivers[0].runtime.repository.read(first.attemptId);assert.equal(stored.formal.rating,'hard');assert.equal(stored.evaluation.rating,'hard');assert.deepEqual(stored.submitted,first.submitted);
   button(f.view(),continueLabel).props.onClick();button(f.view(),continueLabel).props.onClick();await f.handles.onGrade('hard');f.render();
   assert.equal(f.formal.length,1,'repeated continue and the host receipt cannot create another official write');assert.deepEqual(f.intents,['hard']);
   assert.equal(f.claims.length,source?1:0);
  }finally{gate.resolve();await f.close();}
 });
}

for(const source of [false,true]){
 test(`F02 sourcePending prevents the real partial button from formally submitting ${source?'with':'without'} a sourceAdmission service`,async()=>{
  const f=await fixture({source,required:true,sourceStatus:'pending'});
  try{
   await f.submitPartial();assert.equal(f.handles.lifecycle.sourcePending,true);assert.equal(f.drivers[0].runtime.session.snapshot().evaluation.status,'pending');
   assert.equal(button(f.view(),continueLabel).props.disabled,true);
   // Exercise the host boundary even if a stale UI callback is invoked despite disabled.
   button(f.view(),continueLabel).props.onClick();await f.until(()=>f.intents.length===1,'stale button intent reached host');await f.gradeFlight;f.render();
   assert.equal(f.formal.length,0);assert.equal(f.claims.length,0);assert.equal(f.drivers[0].runtime.session.snapshot().formal,null);
   assert.equal(f.drivers[0].runtime.session.snapshot().submitted.answer,'["a"]');
  }finally{await f.close();}
 });
}

for(const source of [false,true]){
 test(`F02 ${source?'changed source verdict':'competing journal revision'} blocks the actual partial continue before formal submission`,async()=>{
  const f=await fixture({source});
  try{
   await f.submitPartial();const original=f.drivers[0].runtime.session.snapshot();
   if(source)f.setSourceVerdict('changed');
   else {
    const other=await createNonWordRuntime(f.scope,'quiz');await other.session.updateView({targetMinutes:13});
   }
   button(f.view(),continueLabel).props.onClick();await f.until(()=>f.intents.length===1,'partial continue reached host');await assert.rejects(f.gradeFlight);f.render();
   assert.equal(f.formal.length,0);assert.equal(f.claims.length,0);assert.equal(f.drivers[0].runtime.session.snapshot().formal,null);
   const durable=await f.drivers[0].runtime.repository.read(original.attemptId);assert.deepEqual(durable.submitted,original.submitted);assert.deepEqual(durable.evaluation,original.evaluation);
   assert.ok([...nodes(f.hostView())].some(node=>node.props.role==='alert'),'host exposes the blocked conflicting save');
  }finally{await f.close();}
 });
}
