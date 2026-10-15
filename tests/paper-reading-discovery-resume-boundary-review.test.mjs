import test from 'node:test';
import assert from 'node:assert/strict';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PaperReadingStore} from '../src/infrastructure/paper-reading/d1-store.ts';
import {paperReadingUnit,applyPaperReadingMutation,paperReadingTask} from '../src/domain/paper-reading/index.ts';
import {canonicalAttemptJson} from '../src/domain/learning-attempt/index.ts';
import {paperFingerprint} from '../app/paper-draft-store.ts';
import {matchPaperReadingResume} from '../src/application/paper-reading-resume/index.ts';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {createControlledPaperReadingAi} from '../src/application/paper-reading/controlled-ai.ts';
import {createPaperReadingRemote} from '../src/infrastructure/paper-reading/index.ts';
import {paperReadingDiscoverySummary} from '../src/domain/paper-reading/index.ts';
import {createHooks,extract,tick,waitForObservation,deferred,button,nodes,text} from './helpers/causal-harness.mjs';

const scope={ownerId:'account:review-u',libraryId:'account:review-l'};

test('discovery preserves legacy opaque unit IDs accepted by the authoritative unit registry across keyset pages',async t=>{
 const db=await openD1();t.after(()=>db.sqlite.close());
 db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('review-u'); INSERT INTO account_study_libraries(user_id,library_id) VALUES ('review-u','review-l');");
 const store=new D1PaperReadingStore(db.binding),ids=[' legacy spaced ','legacy/section','legacy\\section','valid-unit'];
 for(const [index,unitId]of ids.entries()){
  const unit=paperReadingUnit({schemaVersion:1,unitId,title:'Saved paper',goal:'Explain',source:{...scope,
   materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Original source.'}]}});
  await store.mutate(scope,{schemaVersion:1,kind:'register',unitId,operationId:'r'+index,expectedRevision:0,unit});
  assert.equal((await store.read(scope,unitId)).unit.unitId,unitId);
 }
 let cursor=null;const found=[];
 do{const page=await store.list(scope,{limit:1,cursor});found.push(...page.items.map(item=>item.unitId));cursor=page.nextCursor;}while(cursor!==null);
 assert.deepEqual(found,ids);assert.equal(new Set(found).size,ids.length);
 const app=createAccountStudyApplication({getAccessStore:async()=>({profile:async()=>({libraryId:'review-l',revision:1})}),getPaperReadingStore:async()=>store});
 for(const unitId of found){
  const read=await app.post({action:'read-paper-reading',unitId},{principal:{kind:'browser',userId:'review-u'}},new AbortController().signal);
  assert.equal(read.value.workspace.unit.unitId,unitId);
 }
});

function recoveryFixture(fetcher,onResume){
 const hooks=createHooks(),jsx=(type,props)=>({type,props});let settled=false;
 const component=extract('app/paper-reading/recovery-browser.tsx','BoundPaperReadingRecoveryBrowser')({...hooks.api,
  createPaperReadingRemote:options=>{
   const remote=createPaperReadingRemote({...options,fetcher});
   return {...remote,async list(...args){try{return await remote.list(...args);}finally{settled=true;}}};
  },PaperSourceText:'PaperSourceText',MathText:'MathText',exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 const services={owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true};
 const props={services,onResume};hooks.mount(component,props);hooks.flush();
 return {hooks,props,settled:()=>settled};
}
function savedWorkspace(){
 const source={...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Original source.'}]};
 const unit={schemaVersion:1,unitId:'prepared-old',title:'Private saved paper',goal:'Explain',source};
 const registered=applyPaperReadingMutation(null,{schemaVersion:1,kind:'register',operationId:'r',expectedRevision:0,unitId:unit.unitId,unit}).workspace;
 const task=paperReadingTask({taskId:'prepared:q',revision:1,source,origin:'prepared',goal:unit.goal,ability:'mechanism',question:'What is the mechanism?',
  reference:[{point:'PRIVATE REFERENCE',paragraphId:'p',quote:'Original source.'}]});
 const ready=applyPaperReadingMutation(registered,{schemaVersion:1,kind:'task',operationId:'t',expectedRevision:1,unitId:unit.unitId,task},'service').workspace;
 return applyPaperReadingMutation(ready,{schemaVersion:1,kind:'submit',operationId:'s',expectedRevision:2,unitId:unit.unitId,
  answer:'PRIVATE FIRST ANSWER',referenceSeen:false,submittedAt:'2026-10-08T09:00:00Z'}).workspace;
}
test('same-scope retired-account callbacks cannot publish a late discovery response into the recovery browser',async()=>{
 const workspace=savedWorkspace(),gate=deferred(),page={schemaVersion:1,scope,items:[paperReadingDiscoverySummary(workspace)],nextCursor:null};
 let resumes=0;const f=recoveryFixture(async()=>gate.promise,async()=>{resumes++;return true;});
 try{
  button(f.hooks.render(),'读取账号记录').props.onClick();
  f.hooks.render({...f.props,services:{...f.props.services,isCurrent:()=>false}});f.hooks.flush();
  gate.resolve(Response.json(page));await waitForObservation(tick,f.settled);await tick();
  assert.equal([...nodes(f.hooks.render())].filter(node=>node.type==='li').length,0);
  assert.equal(resumes,0);assert.doesNotMatch(text(f.hooks.render()),/Private saved paper|PRIVATE FIRST ANSWER/);
 }finally{f.hooks.unmount();}
});
test('missing matching material keeps saved question and answer in a read-only recovery view without grading or replacement references',async()=>{
 const workspace=savedWorkspace(),page={schemaVersion:1,scope,items:[paperReadingDiscoverySummary(workspace)],nextCursor:null},actions=[];
 const f=recoveryFixture(async(_url,init)=>{
  const body=JSON.parse(init.body);actions.push(body.action);
  return Response.json(body.action==='list-paper-reading'?page:{workspace});
 },async()=>false);
 try{
  button(f.hooks.render(),'读取账号记录').props.onClick();await waitForObservation(tick,f.settled);await tick();
  button(f.hooks.render(),'匹配原文并继续').props.onClick();
  await waitForObservation(tick,()=>text(f.hooks.render()).includes('本机缺少匹配版本的原文'));
  const view=f.hooks.render(),rendered=[...nodes(view)];
  assert.ok(rendered.some(node=>node.type==='PaperSourceText'&&node.props.text==='PRIVATE FIRST ANSWER'));
  assert.ok(rendered.some(node=>node.type==='PaperSourceText'&&node.props.text===workspace.task.question));
  assert.equal(rendered.some(node=>node.type==='textarea'||node.type==='input'),false);
  assert.equal(rendered.some(node=>node.type==='PaperSourceText'&&node.props.text==='PRIVATE REFERENCE'),false);
  assert.deepEqual(actions,['list-paper-reading','read-paper-reading']);
 }finally{f.hooks.unmount();}
});

test('explicit same-source old prepared recovery retains its original goal, unit identity and saved question revision',async()=>{
 const paper={paperId:'controlled',title:'Paper',origin:{kind:'upload',version:'b'.repeat(64),filename:'paper.pdf'},
  sections:[{id:'s',title:'Methods',paragraphs:[{id:'p',rawEn:'Original source.'}]}]};
 const fingerprint=await paperFingerprint(paper),source={...scope,materialFingerprint:fingerprint,sourceVersion:paper.origin.version,
  sectionId:'s',paragraphs:paper.sections[0].paragraphs};
 const restoredUnit=paperReadingUnit({schemaVersion:1,unitId:'prepared:old-known-unit',title:paper.title,
  goal:'Explain the mechanism in this paragraph',source});
 const registered=applyPaperReadingMutation(null,{schemaVersion:1,kind:'register',operationId:'r',expectedRevision:0,unitId:restoredUnit.unitId,unit:restoredUnit}).workspace;
 const task=paperReadingTask({taskId:'prepared:old-question',revision:3,source,origin:'prepared',goal:restoredUnit.goal,ability:'mechanism',
  question:'What explains the source mechanism?',reference:[{point:'Original source point.',paragraphId:'p',quote:'Original source.'}]});
 const workspace=applyPaperReadingMutation(registered,{schemaVersion:1,kind:'task',operationId:'old-task',expectedRevision:1,unitId:restoredUnit.unitId,task},'service').workspace;
 assert.deepEqual(matchPaperReadingResume(workspace,{materialFingerprint:fingerprint,sourceVersion:paper.origin.version,sections:paper.sections}),{position:0,count:1});
 const hooks=createHooks(),jsx=(type,props)=>({type,props});let opened;
 const component=extract('app/paper-reading/question.tsx','PaperQuestionEntry')({...hooks.api,
  useOptionalStudyAIWorkspace:()=>null,createLocalPaperReadingAi:()=>null,paperFingerprint,paperReadingUnit,canonicalAttemptJson,
  studyHash:async()=> 'c'.repeat(64),loadPreparedPaperTask:async()=>null,createPaperReadingRemote:()=>({}),createPaperReadingStore:()=>({}),
  createPaperReadingSession:options=>{opened=options.unit;return {load:async()=>{},dispose(){}};},
  QuestionSession:'QuestionSession',PreparedQuestionTools:'PreparedQuestionTools',paperReadingMessage:x=>x,exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 hooks.mount(component,{paper,unit:{paperId:paper.paperId,sectionId:'s',position:0,paragraphs:source.paragraphs},
  services:{owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true},restoredUnit,onSaving(){},onError(){},onSession(){},onContinue(){}});
 hooks.flush();
 try{await waitForObservation(tick,()=>Boolean(opened));assert.deepEqual(opened,restoredUnit);
  assert.equal(workspace.task.taskId,'prepared:old-question');assert.equal(workspace.task.revision,3);
 }finally{hooks.unmount();}
});

test('cached controlled preparation reserves room for the first-attempt suffix across legacy long unit ID boundaries',async()=>{
 let providerCalls=0;
 for(const length of [183,184,189,190,200]){
  const source={...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Source evidence.'}]};
  const unit=paperReadingUnit({schemaVersion:1,unitId:'u'.repeat(length),title:'Paper',goal:'Explain',source});
  const workspace=applyPaperReadingMutation(null,{schemaVersion:1,kind:'register',unitId:unit.unitId,operationId:'r',expectedRevision:0,unit}).workspace;
  const output={status:'ready',question:'What explains this mechanism?',ability:'mechanism',reference:[{point:'Uses source evidence.',paragraphId:'p',quote:'Source evidence.'}],
   quality:{sourceSufficient:true,taskSpecific:true,referenceConsistent:true,missingVisuals:false}};
  const ai=createControlledPaperReadingAi({deps:{now:()=>new Date('2026-10-08T00:00:00Z'),
   getPaperReadingProvider:async()=>{providerCalls++;throw Error('Unexpected provider call');},
   getAiStore:async()=>({
    getSettings:async()=>({enabled:true,configured:true,provider:'deepseek',model:'controlled-model',baseUrl:'https://fixture.invalid',revision:1,maxOutputTokens:2400}),
    begin:async(_scope,reservation)=>({status:'completed',result:{schemaVersion:1,kind:'prepare',input:{unit},
     trace:{requestId:reservation.requestId,modelId:'controlled-model',promptVersion:'paper-reading-v1',ruleVersion:'paper-source-and-answer-evidence-v1'},output}}),
   }),
  }},{userId:'review-u',libraryId:'review-l'});
  const task=await ai.prepare(unit,'cached-request',new AbortController().signal);
  const ready=applyPaperReadingMutation(workspace,{schemaVersion:1,kind:'task',unitId:unit.unitId,operationId:'t',expectedRevision:1,task},'service').workspace;
  assert.equal(ready.task.status,'ready');assert.ok(ready.attempts[0].attemptId.length<=200);
  if(length===183)assert.equal(task.taskId,'paper-task:'+unit.unitId);
 }
 assert.equal(providerCalls,0);
});
