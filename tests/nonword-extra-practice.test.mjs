import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,nodes,text,button,tick} from './helpers/causal-harness.mjs';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
globalThis.indexedDB=new IDBFactory();
let serial=0;
function fixture({mode='quiz',word=false,recover=true,count=1}={}) {
  const hooks=createHooks(),owner=`extra-owner-${serial++}`,workspaceId=`account:${owner}`;
  const item=index=>({id:`question-${index}`,pluginType:word?'three-stage':mode,prompt:'Choose the original result.',options:['1','2'],answer:'1',explanation:'Original explanation.',initialCode:'def result(): return 1',testCode:'assert result() == 1',front:'Question',back:'Answer',contentHash:'a'.repeat(64),...(word?{word:'tree',meaning:'树',example:'A tree grows.'}:{})});
  const scope=index=>({workspaceId,ownerId:owner,libraryId:'extra-library',snapshotId:'extra-snapshot',itemKey:`question-${index}`,contentHash:'a'.repeat(64),groupId:'extra-group',roundId:'extra-round',cloud:false,temporary:true});
  const Host=function TemporaryHost(){return null;},plugin={id:`@zhixue/plugin-${mode}`,renderUI:function PluginCard(){return null;}};
  const load=loader(hooks.api,{
    'app/plugins/index.ts':{registry:{get:()=>plugin}},'app/study-dashboard/nonword-plugin-host.tsx':{NonWordPluginHost:Host},
    'app/study-plugin-options.tsx':{StudyPluginOptionsProvider:()=>null,StudyPluginOptionsSlot:()=>null},'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},
    'app/learning-draft.tsx':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},'app/study-item-source.tsx':{StudyItemSource:()=>null},
    'app/calculation-client.ts':{gradeCalculationInWorker:()=>{throw Error('No calculation call authorized by this fixture');}},
  });
  const snapshot={scopeKey:`extra-scope-${owner}`,title:'Synthetic extra practice',items:Array.from({length:count},(_,i)=>item(i)),modes:Array(count).fill(mode),sourceModes:Array(count).fill(word?'three-stage':mode),source:{title:'Synthetic approved source',scope:'fixture'},...(recover?{recoveryScopes:Array.from({length:count},(_,i)=>scope(i))}:{})};
  hooks.mount(load('app/extra-practice-session.tsx').ExtraPracticeSession,{snapshot,onExit(){},canOpenLocal:false,getObsidianUri:()=>''});hooks.flush();
  const card=()=>[...nodes(hooks.view())].find(node=>node.props.context&&typeof node.props.onGrade==='function');
  return {hooks,snapshot,Host,workspaceId,card,
    async settle(){hooks.render();hooks.flush();await tick();hooks.render();},
    async grade(rating,options){const current=card();assert.ok(current);await current.props.onGrade(rating,options);await this.settle();return current;},
  };
}
for(const mode of ['quiz','code','calculation','flashcard','recall'])
  test(`temporary ${mode} preserves original-source scope and consumes a wrong-result continuation once without official persistence`,async()=>{
    const f=fixture({mode});const card=f.card();assert.equal(card.type,f.Host);assert.equal(card.props.context.nonWordScope.temporary,true);assert.equal(card.props.context.contentSource.data,f.snapshot.items[0]);
    assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);
    await f.grade('again',{deferAdvance:true});assert.doesNotMatch(text(f.hooks.view()),/本轮练习结束/);
    assert.equal(card.props.context.draft.continueAfterFeedback(),true);await f.settle();
    assert.match(text(f.hooks.view()),/本轮练习结束/);assert.match(text(f.hooks.view()),/待巩固 1/);assert.equal(card.props.context.draft.continueAfterFeedback(),false);
    assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);f.hooks.unmount();
  });
test('original word displayed as quiz keeps its old unscoped repetition behavior',async()=>{
  const f=fixture({mode:'quiz',word:true});const card=f.card();assert.notEqual(card.type,f.Host);assert.equal(card.props.context.nonWordScope,undefined);
  await f.grade('again',{deferAdvance:true});assert.doesNotMatch(text(f.hooks.view()),/本轮练习结束/);assert.equal(f.card().props.context.draft.hasSavedFeedback(),false);
  await f.grade('good',{deferAdvance:true});assert.match(text(f.hooks.view()),/本轮巩固完成/);assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);f.hooks.unmount();
});
test('unknown temporary answer traverses once as awaiting review without turning into wrong or correct evidence',async()=>{
  const f=fixture({count:2}),first=f.card();first.props.context.nonWordNavigation.continuePending();await f.settle();
  assert.equal(f.card().props.context.nonWordScope.itemKey,'question-1');first.props.context.nonWordNavigation.continuePending();await f.settle();assert.equal(f.card().props.context.nonWordScope.itemKey,'question-1');
  await f.grade('good');assert.match(text(f.hooks.view()),/待核对 1/);assert.doesNotMatch(text(f.hooks.view()),/待巩固 1|暂时跳过 1/);assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);f.hooks.unmount();
});
test('explicit replay creates another temporary round while retaining the exact owner and source version',async()=>{
  const f=fixture(),first=f.card().props.context.nonWordScope;await f.grade('good');
  button(f.hooks.view(),'再巩固一遍').props.onClick();await f.settle();const next=f.card().props.context.nonWordScope;
  assert.notEqual(next.roundId,first.roundId);for(const key of ['ownerId','libraryId','snapshotId','itemKey','contentHash','groupId'])assert.equal(next[key],first[key]);
  assert.equal(f.snapshot.recoveryScopes[0].roundId,'extra-round');f.hooks.unmount();
});
test('older nonword caller without recovery scope retains its direct plugin and exposes no formal capabilities',async()=>{
  const f=fixture({recover:false});assert.notEqual(f.card().type,f.Host);assert.equal(f.card().props.context.nonWordScope,undefined);assert.equal(f.card().props.context.nonWordNavigation,undefined);
  await f.grade('again',{deferAdvance:true});assert.equal(f.card().props.context.draft.continueAfterFeedback(),false);assert.doesNotMatch(text(f.hooks.view()),/本轮练习结束|待巩固 1/);
  await f.grade('good',{deferAdvance:true});assert.match(text(f.hooks.view()),/本轮巩固完成/);f.hooks.unmount();
});
test('actual temporary runtime durably preserves auxiliary raw work and cannot claim an official event',async()=>{
  const f=fixture(),scope=f.card().props.context.nonWordScope;
  const runtime=await createNonWordRuntime(scope,'quiz',{purpose:'remediation'});
  await runtime.session.submit('Original auxiliary selection.','observed');await runtime.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'Synthetic wrong choice.'});
  await assert.rejects(runtime.session.reserve('again'),/remediation-not-formal/);
  const saved=await runtime.repository.read(runtime.session.snapshot().attemptId);assert.equal(saved.submitted.answer,'Original auxiliary selection.');assert.equal(saved.formal,null);
  assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);f.hooks.unmount();
});
