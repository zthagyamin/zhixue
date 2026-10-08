import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,nodes,tick,deferred} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createLocalAttemptRepository} from '../src/infrastructure/learning-attempt/index.ts';
import {restoreNonWordRound,createNonWordContinuation} from '../src/features/nonword-study/navigation.ts';
import {emptySubjectRound,isSubjectPassComplete} from '../src/domain/planning/index.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {persistOriginalSubmission} from '../app/study-submission.ts';
import {getLocalStudyEvent} from '../app/local-study-events.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';

globalThis.indexedDB=new IDBFactory();let serial=0;
async function settle(hooks,ready){const deadline=Date.now()+15000;for(let i=0;ready?Date.now()<deadline:i<24;i++){hooks.flush();await tick();hooks.render();
  for(const node of nodes(hooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function'){
    const rendered=node.type(node.props);if(rendered&&typeof rendered.type==='function')rendered.type(rendered.props);
  }
  if(ready?.()){hooks.flush();return;}
}if(ready)assert.fail('The actual group host did not become ready or restore its accepted projection');}
const overrides={'app/math-text.tsx':{MathText:()=>null},'app/account-study-runtime.ts':{resolveAccountStudyItem:()=>assert.fail('Synthetic native group must not resolve a cloud source')},
  'app/dynamic-ui-model.ts':{stableStudyItemKey:()=>undefined}};
function cache(){let get;const hooks=createHooks(),load=loader(hooks.api,overrides);hooks.mount(()=>{get=load('app/study-dashboard/nonword-round-cache.ts').useNonWordRoundCache();return null;},{});hooks.flush();return {get,load,hooks};}
function ui(){const value={index:0,round:emptySubjectRound(),scope:'projection-1',bumps:0};const ports={canContinue:()=>true,canRestore:()=>value.scope==='projection-1',round:()=>value.round,clear(){},publish:fn=>{value.round=fn(value.round);},select:index=>{value.index=index;},bump:()=>value.bumps++};return {value,ports};}
function scope(){const ownerId=`group-host-${serial++}`,members=['A','B'].map((itemKey,index)=>({itemKey,snapshotId:'local',contentHash:(index?'b':'a').repeat(64),kind:'practice',mode:'recall'}));
  return {workspaceId:`account:${ownerId}`,ownerId,libraryId:'group-library',snapshotId:'local',itemKey:'A',contentHash:members[0].contentHash,groupId:'course-group',roundId:'page-group-scope',day:'2026-10-05',cloud:false,members};}
async function mount(t,base,key,getRound,projection,{earlyPolicy,bootGate,writeFormal=true}={}){
  const initialBumps=projection.value.bumps;
  const member=base.members.find(item=>item.itemKey===key),currentScope={...base,itemKey:key,contentHash:member.contentHash},boundHooks=createHooks(),boundLoad=loader(boundHooks.api,overrides),hostHooks=createHooks(),hostLoad=loader(hostHooks.api);
  const store=createLearningDraftStore(`${base.workspaceId}:${key}:${serial++}`),rawDraft=store.adapter(key,'recall'),events=[];let handles;
  if(earlyPolicy)rawDraft.write('recallAttempt',earlyPolicy);
  const probe=props=>{handles=props;props.context.draft.read('recallAttempt',null);return null;};
  const context={nonWordScope:currentScope,draft:rawDraft,contentSource:{mode:'recall',data:{itemId:key,prompt:`Explain synthetic ${key}.`,explanation:`Reference ${key}.`}},
    nonWordNavigation:{restoreRound:state=>restoreNonWordRound(state,['A','B'],projection.value.index,projection.ports),
      continuePending:()=>createNonWordContinuation({itemKeys:['A','B'],index:['A','B'].indexOf(key)},projection.ports)(),
      resumeFormal:rating=>createNonWordContinuation({itemKeys:['A','B'],index:['A','B'].indexOf(key)},projection.ports)(rating)}};
  const props={plugin:{id:'@zhixue/plugin-recall',renderUI:probe},data:{itemId:key,prompt:`Explain synthetic ${key}.`,explanation:`Reference ${key}.`,...(earlyPolicy?{learningSupport:{type:'recall'}}:{})},context,
    round:async()=>{await bootGate?.promise;return getRound(currentScope);},
    async onGrade(rating,options){assert.equal(writeFormal,true,'Pending continuation must not call the official writer');const identity=options.identity;assert.ok(identity);
      const event=await attempt(identity.eventId,identity.reviewedAt,0,['good','easy'].includes(rating)?3:0,['good','easy'].includes(rating),{domain:'differential-review',item:{kind:'due',key},attempt:{rating,correct:['good','easy'].includes(rating),stageBefore:0,stageAfter:['good','easy'].includes(rating)?3:0}});
      const record={workspaceId:base.workspaceId,eventId:event.eventId,event,cloud:'not-required',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt};
      const payload={schemaVersion:1,workspaceId:base.workspaceId,eventId:event.eventId,core:record,route:{kind:'local',binding:{schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,contentHash:member.contentHash,localBindingHash:'d'.repeat(64),practiceMode:'recall'}},summary:null};
      const journal=createSubmissionJournal();await journal.put(payload);await persistOriginalSubmission(payload);await journal.markCoreStored(base.workspaceId,event.eventId);events.push(event);
      const ticket=rawDraft.begin();if(ticket)store.commit(ticket,()=>context.nonWordNavigation.resumeFormal(rating));return {status:'saved'};
    }};
  const outer=boundLoad('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost(props);boundHooks.mount(outer.type,outer.props);
  const hostProps=boundHooks.view().props;hostHooks.mount(hostLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,hostProps);
  t.after(()=>{hostHooks.unmount();boundHooks.unmount();});if(!bootGate)await settle(hostHooks,()=>Boolean(handles?.context.nonWordLearning.ready)||projection.value.bumps>initialBumps);
  return {base,key,props,rawDraft,store,events,hostProps,hostHooks,boundHooks,get handles(){return handles;},
    async submit(raw,result='again') {assert.ok(handles);handles.context.draft.write('answer',raw);await handles.context.nonWordLearning.submit(raw);
      if(result==='pending'){await handles.context.nonWordLearning.waitForReview('Synthetic offline grading');await handles.context.nonWordLearning.continuePending();}
      else{await handles.context.nonWordLearning.assess({status:result==='good'?'correct':'incorrect',source:'self-assess',rating:result,explanation:`Synthetic ${result}.`});await handles.onGrade(result,{deferAdvance:true});assert.equal(handles.context.draft.continueAfterFeedback(),true);assert.equal(handles.context.draft.continueAfterFeedback(),false);await settle(hostHooks);}
    }};
}

for(const result of ['again','pending'])test(`actual app bridge refresh at B preserves first A ${result}, group cursor and B identity`,async t=>{
  const base=scope(),firstCache=cache(),projection=ui(),a=await mount(t,base,'A',firstCache.get,projection,{writeFormal:result!=='pending'});
  assert.ok(a.handles);await a.submit(`FIRST_A_${result}`,result);const group=await firstCache.get(base),saved=await group.read();assert.equal(saved.currentItemKey,'B');assert.equal(projection.value.index,1);
  const repo=createLocalAttemptRepository({userId:base.ownerId,libraryId:base.libraryId}),firstA=(await repo.list()).find(row=>row.submitted?.answer===`FIRST_A_${result}`);
  assert.ok(firstA);assert.deepEqual(saved.traversal.correctKeys,[]);assert.deepEqual(result==='pending'?saved.traversal.awaitingReviewKeys:saved.traversal.wrongKeys,['A']);
  if(result==='again'){assert.equal(firstA.formal.status,'linked');assert.equal((await getLocalStudyEvent(base.workspaceId,firstA.formal.eventId)).event.attempt.correct,false);}else{assert.equal(firstA.formal,null);assert.equal(a.events.length,0);}
  a.hostHooks.unmount();const coldCache=cache(),coldProjection=ui(),redirect=await mount(t,base,'A',coldCache.get,coldProjection);
  assert.equal(redirect.handles,undefined,'First bootstrap must redirect instead of exposing stale A input');assert.equal(coldProjection.value.index,1);assert.ok(coldProjection.value.bumps>0);
  const b=await mount(t,base,'B',coldCache.get,coldProjection);assert.ok(b.handles);const idB=(await b.hostProps.createDriver('first','review')).runtime.session.snapshot().attemptId;
  assert.equal((await redirect.hostProps.createDriver('first','review')).runtime.session.snapshot().attemptId,firstA.attemptId);
  const againB=(await b.hostProps.createDriver('first','review')).runtime.session.snapshot().attemptId;assert.equal(againB,idB);assert.equal((await coldCache.get(base)).anchorAttemptId,saved.anchorAttemptId);
  assert.equal((await repo.read(firstA.attemptId)).submitted.answer,`FIRST_A_${result}`);assert.equal(redirect.events.length,0);firstCache.hooks.unmount();coldCache.hooks.unmount();
});
test('completed group summary is restored before stale first-question input and never rewrites its raw or formal result',async t=>{
  const base=scope(),get=cache(),projection=ui(),a=await mount(t,base,'A',get.get,projection);await a.submit('ORIGINAL_WRONG_A');a.hostHooks.unmount();
  const b=await mount(t,base,'B',get.get,projection);await b.submit('CORRECT_B','good');const accepted=await (await get.get(base)).read();assert.equal(accepted.currentItemKey,null);
  const repo=createLocalAttemptRepository({userId:base.ownerId,libraryId:base.libraryId}),before=(await repo.list()).filter(row=>row.submitted),projectionCold=ui(),cold=await mount(t,base,'A',cache().get,projectionCold);
  assert.equal(cold.handles,undefined);assert.equal(isSubjectPassComplete(projectionCold.value.round,['A','B']),true);assert.deepEqual(projectionCold.value.round.correctKeys,['B']);assert.deepEqual(projectionCold.value.round.wrongKeys,['A']);
  assert.deepEqual((await repo.list()).filter(row=>row.submitted),before);assert.equal(cold.events.length,0);get.hooks.unmount();
});
test('explicit normal restart awaits existing reset, creates new first IDs and preserves old actual events',async t=>{
  const base=scope(),get=cache(),projection=ui(),a=await mount(t,base,'A',get.get,projection);await a.submit('OLD_A_RAW');a.hostHooks.unmount();
  const repo=createLocalAttemptRepository({userId:base.ownerId,libraryId:base.libraryId}),old=(await repo.list()).find(row=>row.submitted),group=await get.get(base),oldRun=await group.read(),order=[];
  const resetGate=deferred();
  const restarting=get.load('app/study-dashboard/nonword-round-cache.ts').restartSavedRound(get.get,base,async()=>{order.push('reset');await resetGate.promise;projection.value.round=emptySubjectRound();projection.value.index=0;},()=>order.push('remount'));
  await tick();assert.equal((await group.read()).runId,oldRun.runId);assert.deepEqual(order,['reset']);resetGate.resolve();await restarting;
  const next=await group.read();assert.deepEqual(order,['reset','remount']);assert.notEqual(next.runId,oldRun.runId);assert.notEqual(next.roundId,oldRun.roundId);
  const fresh=await mount(t,base,'A',get.get,projection),driver=await fresh.hostProps.createDriver('first','review');assert.notEqual(driver.runtime.session.snapshot().attemptId,old.attemptId);
  assert.equal(driver.runtime.session.snapshot().submitted,null);assert.equal((await repo.read(old.attemptId)).submitted.answer,'OLD_A_RAW');assert.equal((await getLocalStudyEvent(base.workspaceId,old.formal.eventId)).event.coreHash,old.formal.coreHash);get.hooks.unmount();
});
test('pending recovery writes its accepted anchor before resetting UI and reuses the submitted first attempt',async t=>{
  const base=scope(),get=cache(),projection=ui(),a=await mount(t,base,'A',get.get,projection,{writeFormal:false});await a.submit('PENDING_ORIGINAL_A','pending');a.hostHooks.unmount();
  const repo=createLocalAttemptRepository({userId:base.ownerId,libraryId:base.libraryId}),old=(await repo.list()).find(row=>row.submitted),group=await get.get(base),oldRun=await group.read();
  let observedDuringReset;
  await get.load('app/study-dashboard/nonword-round-cache.ts').restoreSavedPending(get.get,base,()=>{observedDuringReset=group.read();projection.value.round=emptySubjectRound();projection.value.index=0;});
  assert.equal((await observedDuringReset).currentItemKey,'A');assert.deepEqual((await observedDuringReset).traversal.awaitingReviewKeys,[]);
  const restored=await group.read();assert.equal(restored.currentItemKey,'A');assert.deepEqual(restored.traversal.awaitingReviewKeys,[]);assert.equal(restored.runId,oldRun.runId);
  const resumed=await mount(t,base,'A',get.get,projection),driver=await resumed.hostProps.createDriver('first','review');assert.equal(driver.runtime.session.snapshot().attemptId,old.attemptId);assert.equal(driver.runtime.session.snapshot().submitted.answer,'PENDING_ORIGINAL_A');assert.equal(driver.runtime.session.snapshot().formal,null);get.hooks.unmount();
});
test('level-three policy observed before actor boot stays in the first submission and cold recovery',async t=>{
  const base=scope(),get=cache(),projection=ui(),gate=deferred(),policy={schemaVersion:1,attemptId:'preboot-policy',maxPreHintLevel:3};
  const a=await mount(t,base,'A',get.get,projection,{earlyPolicy:policy,bootGate:gate});await settle(a.hostHooks);assert.equal(a.handles,undefined);gate.resolve();await settle(a.hostHooks,()=>Boolean(a.handles?.context.nonWordLearning.ready));assert.ok(a.handles);
  a.handles.context.draft.write('recallRequestedRating','good');await a.submit('FIRST_A_AFTER_LEVEL_THREE','again');
  const repo=createLocalAttemptRepository({userId:base.ownerId,libraryId:base.libraryId}),first=(await repo.list()).find(row=>row.submitted);assert.equal(first.submitted.maxPreHintLevel,3);assert.equal(first.formal.rating,'again');
  assert.equal(first.checkpoint.pluginFields.hintLevel,'3');assert.equal(first.checkpoint.pluginFields.policyAttemptId,policy.attemptId);
  a.hostHooks.unmount();const driver=await a.hostProps.createDriver('first','review');assert.equal(driver.runtime.session.snapshot().attemptId,first.attemptId);assert.deepEqual(driver.restore().recallAttempt,policy);get.hooks.unmount();
});
test('original vocabulary display overrides stay on the legacy app branch without opening or altering a group',()=>{
  const hooks=createHooks(),load=loader(hooks.api,overrides),base=scope(),data={front:'tree',back:'树'},original={word:'tree',meaning:'树'},context={contentSource:{mode:'flashcard',data:original},nonWordScope:base,draft:createLearningDraftStore().adapter('word','flashcard')};
  const fallback=()=>null,result=load('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost({plugin:{id:'@zhixue/plugin-flashcard',renderUI:fallback},data,context,onGrade(){},round:async()=>assert.fail('Word display cannot create a nonword group')});
  assert.equal(result.type,fallback);assert.strictEqual(result.props.data,data);assert.strictEqual(result.props.context.contentSource.data,original);assert.equal(result.props.context.nonWordLearning,undefined);
});
test('restored projection is blocked for a stale UI scope, and snapshot identity changes intentionally open another anchor',async()=>{
  const base=scope(),get=cache(),group=await get.get(base),old=await group.read(),projection=ui();projection.value.scope='new-projection';
  assert.equal(restoreNonWordRound({...old,currentItemKey:'B'},['A','B'],0,projection.ports),false);assert.equal(projection.value.index,0);assert.equal(projection.value.bumps,0);
  const changed=await get.get({...base,members:base.members.map(member=>({...member,snapshotId:'new-header'}))});assert.notEqual((await changed.read()).anchorAttemptId,old.anchorAttemptId);assert.equal((await group.read()).runId,old.runId);get.hooks.unmount();
});
test('a driver from an older run cannot advance a newly accepted run',async t=>{
  const base=scope(),get=cache(),projection=ui(),a=await mount(t,base,'A',get.get,projection),oldDriver=await a.hostProps.createDriver('first','review'),group=await get.get(base);
  await group.startNewRound({restartConfirmed:true});const before=await group.read();await assert.rejects(oldDriver.continueGroup('again'),/本轮已经切换|run-conflict/);assert.deepEqual(await group.read(),before);get.hooks.unmount();
});
test('a run switched between the driver guard read and inner cursor read cannot settle the new run',async t=>{
  const base=scope(),get=cache(),group=await get.get(base),other=await cache().get(base);let arm=false;
  const port={...group,read:async()=>{const state=await group.read();if(arm){arm=false;await other.startNewRound({restartConfirmed:true});}return state;}};
  const a=await mount(t,base,'A',async()=>port,ui());a.handles.context.draft.write('answer','OLD_LINKED_A');await a.handles.context.nonWordLearning.submit('OLD_LINKED_A');
  await a.handles.context.nonWordLearning.assess({status:'incorrect',source:'self-assess',rating:'again',explanation:'Synthetic first incorrect.'});await a.handles.onGrade('again',{deferAdvance:true});
  const driver=await a.hostProps.createDriver('first','review');assert.equal(driver.runtime.session.snapshot().formal.status,'linked');arm=true;
  await assert.rejects(driver.continueGroup('again'),/本轮已经切换|run-conflict|round.*conflict|续学/);const current=await other.read();assert.deepEqual(current.traversal.wrongKeys,[]);assert.equal(current.currentItemKey,'A');get.hooks.unmount();
});
test('same-session restart between inner read and save is rejected inside the serial application boundary',async t=>{
  const base=scope(),get=cache(),group=await get.get(base);let arm=false;
  const port={...group,saveCursor:async(cursor,expectedRunId)=>{if(arm){arm=false;await group.startNewRound({restartConfirmed:true});}return group.saveCursor(cursor,expectedRunId);}};
  const a=await mount(t,base,'A',async()=>port,ui()),driver=await a.hostProps.createDriver('first','review');arm=true;
  await assert.rejects(driver.continueGroup('pending'),/run-conflict|本轮已经切换/);const current=await group.read();assert.deepEqual(current.traversal.awaitingReviewKeys,[]);assert.equal(current.currentItemKey,'A');get.hooks.unmount();
});
