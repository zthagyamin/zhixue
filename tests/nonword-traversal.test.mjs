import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as planning from '../src/domain/planning/index.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createSubjectRoundSessions,firstPendingRoundIndex} from '../app/subject-round-resume.ts';
import {prepareAttemptEvidence} from '../src/domain/assessment/index.ts';
import {attemptFailureMessage} from '../src/features/study-attempt/index.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';
import {createHooks,loader,nodes,deferred,tick} from './helpers/causal-harness.mjs';

test('traversal policy uses original word identity, including vocabulary quiz and flashcard',()=>{
  const policy=planning.completesSubjectItemAfterAttempt;
  for(const item of [{word:'tree',questionType:'quiz'},{word:'tree',questionType:'flashcard'},
    {eventKind:'word',questionType:'quiz'},{pluginType:'spelling'},{type:'three-stage'}])assert.equal(policy(item),false);
  assert.equal(policy({questionType:'flashcard'},{pluginType:'three-stage'}),false);
  for(const questionType of ['quiz','flashcard','calculation','code','recall'])assert.equal(policy({questionType}),true);
});

function inline(items,onRecordAttempt,{scoped=false}={}){
  const hooks=createHooks(),load=loader(hooks.api,{'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},
    'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},
    'app/plugins/index.ts':{registry:{get:()=>({renderUI:()=>null})}},'app/math-text.tsx':{MathText:()=>null}},{confirm:()=>true});
  const done=[],records=[],store=load('app/learning-draft-store.ts').createLearningDraftStore('nonword');
  hooks.mount(load('app/practice-session.tsx').PracticeSession,{items,drafts:store,
    ...(scoped?{nonWordScopeFor:()=>({workspaceId:'account:isolated',ownerId:'isolated',libraryId:'library',snapshotId:'s',itemKey:'A',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false})}:{}),
    onRecordAttempt:async(p,c)=>{records.push(p);await onRecordAttempt?.(p,c);},onFinish:s=>done.push(s)});
  return {hooks,done,records,store,plugin:()=>[...nodes(hooks.view())].find(n=>n.props.onGrade&&n.props.context)};
}
async function settle(f){for(let i=0;i<3;i++){f.hooks.flush();await tick();f.hooks.render();}}
const item=(id,questionType,extra={})=>({itemId:id,fingerprint:'v1',questionType,prompt:id,answer:'1',
  options:['1','2'],initialCode:'pass',testCode:'assert True',...extra});
for(const mode of ['code','quiz','flashcard'])test(`inline ${mode} explicit wrong grade advances once after durable save`,async()=>{
  const wait=deferred(),f=inline([item('A',mode),item('B',mode)],()=>wait.promise,{scoped:true});await settle(f);
  const saving=f.plugin().props.onGrade('again');await tick();f.hooks.render();assert.equal(f.plugin().props.data.itemId,'A');
  wait.resolve();await saving;await settle(f);assert.equal(f.plugin().props.data.itemId,'B');assert.equal(f.records[0].correct,false);
  await f.plugin().props.onGrade('good');await settle(f);assert.equal(f.done.length,1);assert.deepEqual(f.done[0],{answered:2,correct:1,wrong:1});f.hooks.unmount();
});
for(const mode of ['quiz','flashcard'])test(`inline original word ${mode} preserves wrong-answer review`,async()=>{
  const f=inline([item('A',mode,{word:'tree'})]);await settle(f);await f.plugin().props.onGrade('again');await settle(f);
  assert.equal(f.done.length,0);assert.equal(f.plugin().props.data.itemId,'A');f.hooks.unmount();
});
for(const mode of ['calculation','recall'])test(`inline ${mode} defers traversal until receipt is explicitly continued`,async()=>{
  const f=inline([item('A',mode),item('B',mode)]);await settle(f);await f.plugin().props.onGrade('again',{deferAdvance:true});await settle(f);
  assert.equal(f.plugin().props.data.itemId,'A');const draft=f.plugin().props.context.draft;draft.continueAfterFeedback();draft.continueAfterFeedback();await settle(f);
  assert.equal(f.plugin().props.data.itemId,'B');assert.equal(f.records.length,1);assert.equal(f.records[0].correct,false);f.hooks.unmount();
});

const source=readFileSync(new URL('../app/study-dashboard/subject-view.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('subject-view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let gradeNode;
(function walk(n){if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='onGrade'&&n.initializer?.getText(ast).includes('gradeModeEpoch'))gradeNode=n.initializer.expression;ts.forEachChild(n,walk);})(ast);
function subject(mode,{word=false,fail=false}={}){
  const items=[{id:'A',prompt:'A',...(word?{word:'tree',eventKind:'word'}:{})},{id:'B',prompt:'B'}],store=createLearningDraftStore('nonword-subject'),draft=store.adapter('A',mode),records=[],work=[];
  const state={round:undefined,index:0,scope:'round-1',progress:{itemStages:{},answered:0,correct:0}};
  const deps={createSubjectGradeHandler,roundScope:'round-1',getVisibleSubjectRound:()=>({round:state.round,scope:state.scope}),actualPluginType:mode,
    completesSubjectItemAfterAttempt:planning.completesSubjectItemAfterAttempt,accountModeEpoch:{current:0},taskWorkspaceRef:{current:'owner'},workspaceId:'owner',
    activeLearningDraftsRef:{current:store},learningDrafts:store,currentItem:items[0],draftAdapter:draft,prepareAttemptEvidence,attemptFailureMessage,
    setPlanMessage(){},visibleLearningRef:{current:'view'},draftViewId:'view',practiceRequest:{current:1},draftFrame:{navigationEpoch:1},setStageRoundBump(){},captureAttemptFrame:()=>({}),
    completedStage:0,idx:0,items,learningStages:{},advanceSubjectRound:planning.advanceSubjectRound,round:planning.emptySubjectRound(),resolveStudyItemProgressKey:item=>item.id,
    itemProgressKey:'A',uiProgress:{fsrsData:{}},subject:{id:'s',pluginType:word?'three-stage':mode},roundSnapshot:undefined,
    setSubjectRounds:fn=>{state.round=fn({s:state.round}).s;},setItemIndices:fn=>{state.index=fn({s:state.index}).s;},isDemoMode:false,domain:'differential-review',itemKind:word?'word':'due',
    itemLabel:item=>item.id,markdownNotePath:()=>undefined,data:{source:{}},resolveEventAbilityId:()=>undefined,accountLoaded:null,sessionUser:null,cloudSyncMetadata:{},eventMutation:{current:0},
    persistSubmittedEvent:async record=>{if(fail)throw Error('disk');records.push(record);return{};},noteEventsChanged(){},setProgressEvents(){},setAccountProgress(){},
    setProgress:fn=>state.progress=fn(state.progress),setNativeProjection(){},nativeScope:'source',applySavedNativeAttempt(){},sendSubmittedCloud(){},sendSubmittedCompanion(){},updateStudyEventDelivery(){},
    recordStudyAttempt:(input,handlers)=>{const run=(async()=>{await handlers.persistEvent({eventId:'synthetic-1',event:input});await handlers.persistProgress({event:input});})();work.push(run.catch(()=>{}));return run;}};
  const out={};new Function(...Object.keys(deps),'exports',ts.transpileModule(`exports.grade=${gradeNode.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(...Object.values(deps),out);
  return {grade:out.grade,state,records,work,draft,deps};
}
for(const mode of ['code','quiz','flashcard','calculation','recall'])test(`subject ${mode} wrong response leaves truthful grade and visits only after its save/continue boundary`,async()=>{
  const f=subject(mode),defer=['calculation','recall'].includes(mode);f.grade('again',{deferAdvance:defer});await Promise.all(f.work);
  if(defer){assert.equal(f.state.round,undefined);f.draft.continueAfterFeedback();f.draft.continueAfterFeedback();}
  assert.deepEqual(f.state.round.reviewedKeys,['A']);assert.deepEqual(f.state.round.correctKeys,[]);assert.equal(f.state.index,1);
  assert.equal(f.records.length,1);assert.equal(f.state.progress.correct,0);assert.equal(f.state.progress.itemStages.A,0);
});
for(const mode of ['quiz','flashcard'])test(`subject vocabulary displayed as ${mode} still requires correctness`,async()=>{
  const f=subject(mode,{word:true});f.grade('again');await Promise.all(f.work);assert.equal(f.state.round.reviewedKeys,undefined);
  assert.deepEqual(planning.pendingSubjectKeys(f.state.round,['A','B']),['A','B']);
});
test('a failed save and a different review round cannot acquire visited state',async()=>{
  const failed=subject('calculation',{fail:true});failed.grade('again',{deferAdvance:true});await Promise.all(failed.work);assert.equal(failed.state.round,undefined);
  const stale=subject('calculation');stale.grade('again',{deferAdvance:true});await Promise.all(stale.work);stale.state.scope='round-2';stale.draft.continueAfterFeedback();assert.equal(stale.state.round,undefined);
});
for(const mode of ['calculation','code'])test(`${mode} saved failures finish one scoped pass without becoming correct or repeating A`,()=>{
  const scope='owner/library/day/group/source/round-1',sessions=createSubjectRoundSessions();
  sessions.activate('s',scope,planning.emptySubjectRound());
  const advance=(index,round)=>planning.advanceSubjectRound({round,itemKeys:['A','B'],currentIndex:index,correct:false,
    completeAfterAttempt:planning.completesSubjectItemAfterAttempt({questionType:mode})});
  const a=advance(0,sessions.getVisible('s').round);sessions.set({s:a.round});
  const resumed=sessions.activate('s',scope,planning.emptySubjectRound());assert.equal(firstPendingRoundIndex(['A','B'],resumed,'A'),1);
  const b=advance(1,resumed);assert.equal(b.complete,true);assert.deepEqual(b.round.reviewedKeys,['A','B']);assert.deepEqual(b.round.correctKeys,[]);
  assert.deepEqual(planning.pendingSubjectKeys(b.round,['A','B']),[]);assert.equal(planning.isSubjectRoundComplete({pluginType:mode,items:['A','B'],itemStages:{},keyOf:key=>key,round:b.round}),false);
  assert.equal(sessions.activate('s',scope+'/round-2',planning.emptySubjectRound()).reviewedKeys,undefined);
});
test('subject orchestration forwards a reserved event identity and retry retains its first captured command',async()=>{
  const store=createLearningDraftStore('reserved-subject'),draft=store.adapter('A','calculation'),submissions=[],commands=[];
  const first={eventId:'reserved-first',reviewedAt:'2026-10-05T01:00:00.000Z'},later={eventId:'must-not-replace',reviewedAt:'2026-10-05T02:00:00.000Z'};
  let preparations=0,writes=0,advances=0;
  const grade=createSubjectGradeHandler({mode:'calculation',completedStage:0,isDemoMode:false,draft},{
    drafts:{submit(adapter,options){const result=store.submit(adapter,options);submissions.push(result);return result;}},
    modeEpoch:()=>0,ownerCurrent:()=>true,canPresent:()=>true,
    prepare(request,rating){preparations++;return {input:{identity:request.identity,rating},frame:{kind:'local',practiceMode:'calculation'},observation:null};},
    advance:()=>advances++,publishDemo(){},publishEvent(){},publishProgress(){},setMessage(){},invalidateView(){},
    record:async(command,ports)=>{commands.push(command);await ports.persistEvent({eventId:command.identity.eventId,event:command});await ports.persistProgress({event:command});},
    persist:async()=>{if(++writes===1)throw Error('synthetic disk failure');return{};},sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{},
  });
  grade('again',{deferAdvance:true,identity:first});await submissions[0];assert.equal(draft.hasSavedFeedback(),false);
  grade('again',{deferAdvance:true,identity:later});assert.equal((await submissions[1]).status,'conflict');assert.equal(writes,1);
  grade('again',{deferAdvance:true,identity:first});await submissions[2];assert.equal(draft.hasSavedFeedback(),true);
  assert.equal(preparations,1);assert.deepEqual(commands.map(command=>command.identity),[first,first]);assert.equal(advances,0);
  assert.equal(draft.continueAfterFeedback(),true);assert.equal(draft.continueAfterFeedback(),false);assert.equal(advances,1);
});
