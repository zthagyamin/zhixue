import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import ts from 'typescript';
import {createHooks,loader,nodes,deferred,tick} from './helpers/causal-harness.mjs';
import {advanceSubjectRound,emptySubjectRound,isSubjectPassComplete} from '../app/subject-round.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {prepareAttemptEvidence} from '../src/domain/assessment/index.ts';
import {attemptFailureMessage} from '../src/features/study-attempt/index.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';
const A={itemId:'A',fingerprint:'v1',questionType:'recall',prompt:'A',answer:'reference'},B={...A,itemId:'B',prompt:'B'};
function inline(){const hooks=createHooks(),load=loader(hooks.api,{'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},'app/plugins/index.ts':{registry:{get:()=>({renderUI:()=>null})}},'app/math-text.tsx':{MathText:()=>null}},{confirm:()=>true});const store=load('app/learning-draft-store.ts').createLearningDraftStore('inline-synthetic');return{hooks,store,Practice:load('app/practice-session.tsx').PracticeSession};}
const plugin=f=>[...nodes(f.hooks.view())].find(n=>n.props.onGrade&&n.props.context);
async function settle(f){for(let i=0;i<3;i++){f.hooks.flush();await tick();f.hooks.render();}}
for(const rating of ['again','hard','good'])test(`real inline host saves ${rating}, then its receipt ends one question once`,async()=>{
 const f=inline(),records=[],done=[];f.hooks.mount(f.Practice,{items:[A],drafts:f.store,onRecordAttempt:async p=>records.push(p),onFinish:s=>done.push(s)});await settle(f);
 assert.equal(plugin(f).props.context.recallNavigation.continueLabel,'结束本轮');await plugin(f).props.onGrade(rating,{deferAdvance:true});f.hooks.render();assert.equal(done.length,0);assert.equal(records.length,1);
 const draft=plugin(f).props.context.draft;draft.continueAfterFeedback();draft.continueAfterFeedback();assert.equal(done.length,1);assert.equal(done[0].answered,1);assert.equal(done[0].correct,rating==='good'?1:0);f.hooks.unmount();
});
test('real inline multi-item recall advances A to B instead of explained-phase dead end',async()=>{
 const f=inline(),records=[],done=[];f.hooks.mount(f.Practice,{items:[A,B],drafts:f.store,onRecordAttempt:async p=>records.push(p),onFinish:s=>done.push(s)});await settle(f);
 await plugin(f).props.onGrade('again',{deferAdvance:true});f.hooks.render();plugin(f).props.context.draft.continueAfterFeedback();f.hooks.render();await settle(f);assert.equal(plugin(f).props.data.prompt,'B');
 await plugin(f).props.onGrade('hard',{deferAdvance:true});f.hooks.render();await settle(f);plugin(f).props.context.draft.continueAfterFeedback();assert.equal(done.length,1);assert.equal(done[0].wrong,2);assert.deepEqual(records.map(r=>r.item.itemId),['A','B']);f.hooks.unmount();
});
test('inline no-reference skip never invokes its recording callback',async()=>{const f=inline();let writes=0,done=0;f.hooks.mount(f.Practice,{items:[A],drafts:f.store,onRecordAttempt:async()=>writes++,onFinish:()=>done++});await settle(f);plugin(f).props.context.recallNavigation.onSkip();assert.equal(writes,0);assert.equal(done,1);f.hooks.unmount();});
// The actual subject onGrade body, with synthetic persistence receipts; no external event writes.
const source=readFileSync(new URL('../app/study-dashboard/subject-view.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('subject-view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let gradeNode;
(function walk(n){if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='onGrade'&&n.initializer?.getText(ast).includes('gradeModeEpoch'))gradeNode=n.initializer.expression;ts.forEachChild(n,walk);})(ast);
function subjectFixture({count=1,fail=false}={}){
 const keys=count===1?['A']:['A','B'],items=keys.map(id=>({id,itemId:id,prompt:id})),store=createLearningDraftStore('subject'),draft=store.adapter('A','recall:1'),records=[],work=[],state={round:undefined,index:0,progress:{itemStages:{A:3},answered:0,correct:0},bump:0};
 const deps={createSubjectGradeHandler,roundScope:undefined,getVisibleSubjectRound:()=>({round:state.round}),actualPluginType:'recall',accountModeEpoch:{current:0},taskWorkspaceRef:{current:'owner'},workspaceId:'owner',activeLearningDraftsRef:{current:store},learningDrafts:store,currentItem:items[0],draftAdapter:draft,
 prepareAttemptEvidence,attemptFailureMessage,setPlanMessage(){},visibleLearningRef:{current:'view'},draftViewId:'view',practiceRequest:{current:1},draftFrame:{navigationEpoch:1},setStageRoundBump:fn=>state.bump=fn(state.bump),captureAttemptFrame:()=>({}),completedStage:3,idx:0,items,learningStages:{A:3},advanceSubjectRound,round:emptySubjectRound(),resolveStudyItemProgressKey:item=>item.id,itemProgressKey:'A',uiProgress:{fsrsData:{}},subject:{id:'s'},roundSnapshot:undefined,
 setSubjectRounds:fn=>{state.round=fn({s:state.round}).s;},setItemIndices:fn=>{state.index=fn({s:state.index}).s;},isDemoMode:false,domain:'differential-review',itemKind:'due',itemLabel:item=>item.id,markdownNotePath:()=>undefined,data:{source:{}},resolveEventAbilityId:()=>undefined,accountLoaded:null,sessionUser:null,cloudSyncMetadata:{},eventMutation:{current:0},
 persistSubmittedEvent:async record=>{if(fail)throw Error('disk');records.push(record);return{};},noteEventsChanged(){},setProgressEvents(){},setAccountProgress(){},setProgress:fn=>state.progress=fn(state.progress),setNativeProjection(){},nativeScope:'source',applySavedNativeAttempt(){},sendSubmittedCloud(){},sendSubmittedCompanion(){},updateStudyEventDelivery(){},
 recordStudyAttempt:(input,handlers)=>{const run=(async()=>{await handlers.persistEvent({eventId:'synthetic-1',event:input});await handlers.persistProgress({event:input});})();work.push(run.catch(()=>{}));return run;},
 };
 const js=ts.transpileModule(`exports.grade=${gradeNode.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const out={};new Function(...Object.keys(deps),'exports',js)(...Object.values(deps),out);
 return {grade:out.grade,state,records,work,store,draft,keys};
}
for(const rating of ['again','hard','good'])test(`real subject callback ${rating} changes traversal only after receipt and keeps truthful score`,async()=>{
 const f=subjectFixture();f.grade(rating,{deferAdvance:true});await Promise.all(f.work);assert.equal(f.records.length,1);assert.equal(f.state.round,undefined);assert.equal(f.draft.hasSavedFeedback(),true);
 assert.equal(f.state.progress.correct,rating==='good'?1:0);assert.equal(f.state.progress.itemStages.A,rating==='good'?3:0);
 f.draft.continueAfterFeedback();f.draft.continueAfterFeedback();assert.equal(isSubjectPassComplete(f.state.round,f.keys),true);assert.deepEqual(f.state.round.correctKeys,rating==='good'?['A']:[]);assert.equal(f.records.length,1);
});
test('real subject persistence failure leaves pass unfinished and retryable',async()=>{const f=subjectFixture({fail:true});f.grade('again',{deferAdvance:true});await Promise.all(f.work);await tick();assert.equal(f.records.length,0);assert.equal(f.state.round,undefined);assert.equal(f.draft.hasSavedFeedback(),false);assert.equal(f.draft.hasSaveFailure(),true);assert.equal(f.store.isPending(),false);});
test('real subject A failure visits B next while leaving A due for consolidation',async()=>{const f=subjectFixture({count:2});f.grade('again',{deferAdvance:true});await Promise.all(f.work);f.draft.continueAfterFeedback();assert.equal(f.state.index,1);assert.deepEqual(f.state.round.reviewedKeys,['A']);assert.deepEqual(f.state.round.correctKeys,[]);assert.equal(isSubjectPassComplete(f.state.round,f.keys),false);});
test('recall feedback key is stage-stable and page pass is not used as official completion',()=>{
 assert.match(source,/actualPluginType === "calculation" \|\| actualPluginType === "recall"\) \? 1/);
 assert.match(source,/recallPassUsed&&isSubjectPassComplete/);
 assert.match(source,/本轮练习结束/);assert.match(source,/本轮结束不代表全部答对/);
 const controller=readFileSync(new URL('../app/study-dashboard/use-dashboard-controller.ts',import.meta.url),'utf8');assert.doesNotMatch(controller,/isSubjectPassComplete/);
});

test('recall can cancel an in-flight AI check, while persistence and other modes stay locked',async()=>{
 const hooks=createHooks(),load=loader(hooks.api),Boundary=load('app/learning-draft.tsx').LearningDraftBoundary;
 const store=load('app/learning-draft-store.ts').createLearningDraftStore('boundary'),draft=store.adapter('A','recall:1'),wait=deferred();
 const operation=store.grade(()=>wait.promise);hooks.mount(Boundary,{store,interactiveWhileGrading:true,children:'test'});
 assert.equal([...nodes(hooks.view())].find(n=>n.type==='fieldset').props.disabled,false);
 hooks.render({store,interactiveWhileGrading:false,children:'test'});assert.equal([...nodes(hooks.view())].find(n=>n.type==='fieldset').props.disabled,true);
 wait.resolve();await operation;const ticket=draft.begin();hooks.render({store,interactiveWhileGrading:true,children:'test'});assert.equal([...nodes(hooks.view())].find(n=>n.type==='fieldset').props.disabled,true);
 store.fail(ticket);hooks.unmount();
});
