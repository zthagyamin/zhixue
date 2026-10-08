import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,button,deferred,tick,text,nodes,waitForObservation} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields,evaluationPhase} from '../src/infrastructure/nonword-study/index.ts';
import {attemptFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {parseAttemptMutation,applyAttemptMutation} from '../src/domain/learning-attempt/index.ts';
globalThis.indexedDB=new IDBFactory();
let serial=0;
async function settle(hooks) {for(let i=0;i<20;i++){hooks.flush();await tick();hooks.render();
  // The host's pure stable plugin slot is a real child component; this hooks
  // harness does not automatically mount children, so execute its rendering seam.
  for(const node of nodes(hooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function')node.type(node.props);
}}
async function fixture({scope:providedScope,waitGrade,failAfterDurable=false,commitFeedback=false,temporary=false}={}) {
  const scope=providedScope??{workspaceId:`account:host-${serial}`,ownerId:`host-${serial++}`,libraryId:'host-library',snapshotId:'host-snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false};
  const hooks=createHooks(),drivers=[],formal=[],moves=[];let handles,core=null,fail=failAfterDurable;
  const store=createLearningDraftStore(scope.workspaceId),draft=store.adapter('question','recall');
  const createDriver=async(purpose,intent,parentAttemptId,instanceId)=>{
    const runtime=await createNonWordRuntime(scope,'recall',{purpose:temporary?'remediation':purpose,intent,parentAttemptId,instanceId,verifyFormalEvent:async eventId=>core?.eventId===eventId?core:null});
    const driver={runtime,restore:()=>restoredFields(runtime.session.snapshot(),'recall'),fields:values=>recoveryFields('recall',values),answer:values=>rawAnswer('recall',values),phase:()=>evaluationPhase(runtime.session.snapshot()),verifiedCore:async()=>core?.coreHash??null};
    drivers.push(driver);return driver;
  };
  const props={temporary,bindingKey:JSON.stringify(scope),mode:'recall',draft,reference:'REFERENCE: use independent held-out evaluation.',recallConfigured:false,createDriver,
    renderPlugin(current,lifecycle,grade){handles={draft:current,lifecycle,grade};return 'Synthetic learner input';},
    async onGrade(rating,options){await waitGrade?.promise;formal.push({rating,...options});if(options.identity)core={eventId:options.identity.eventId,coreHash:'c'.repeat(64),itemKey:scope.itemKey,contentHash:scope.contentHash,reviewedAt:options.identity.reviewedAt,rating};if(commitFeedback){const ticket=draft.begin();if(ticket)store.commit(ticket,()=>moves.push({source:'draft',rating}));}if(fail){fail=false;throw Error('durable receipt lost');}return {status:'saved'};},
    continuePending(){moves.push({source:'pending'});},resumeFormal(rating){moves.push({source:'fallback',rating});},renderMath:value=>value,
  };
  hooks.mount(loader(hooks.api)('src/features/nonword-study/host.tsx').NonWordStudyHost,props);await settle(hooks);
  try {await waitForObservation(()=>settle(hooks),()=>Boolean(handles?.lifecycle.ready)||Boolean(button(hooks.view(),'继续学习')&&!button(hooks.view(),'继续学习').props.disabled),{label:'actual host readiness'});}
  catch(error){hooks.unmount();throw error;}
  return {scope,hooks,drivers,formal,moves,rawDraft:draft,props,get handles(){return handles;},
    async click(label){
      await waitForObservation(()=>settle(hooks),()=>Boolean(button(hooks.view(),label)&&!button(hooks.view(),label).props.disabled),{label:'enabled '+label});
      const target=button(hooks.view(),label);await target.props.onClick();await settle(hooks);
      const completed={
        '深入学习':()=>Boolean(button(hooks.view(),'进入引导练习')&&!button(hooks.view(),'进入引导练习').props.disabled),
        '日常复习':()=>handles?.lifecycle.intent==='review'&&!button(hooks.view(),'进入引导练习'),
        '进入引导练习':()=>handles?.lifecycle.purpose==='guided'&&Boolean(button(hooks.view(),'收起讲解，独立尝试')&&!button(hooks.view(),'收起讲解，独立尝试').props.disabled),
        '收起讲解，独立尝试':()=>handles?.lifecycle.purpose==='first'&&!button(hooks.view(),'收起讲解，独立尝试'),
        '暂停并保存':()=>Boolean(button(hooks.view(),'继续学习')&&!button(hooks.view(),'继续学习').props.disabled),
        '继续学习':()=>Boolean(handles?.lifecycle.ready&&!button(hooks.view(),'继续学习')),
      }[label];
      if(completed)await waitForObservation(()=>settle(hooks),completed,{label:'completed '+label});
    },
    async edit(answer){handles.draft.write('answer',answer);await settle(hooks);},
    async close(){hooks.unmount();await tick();await tick();},
  };
}
test('host persists first snapshot before official writer and retries a lost receipt with the fixed identity',async()=>{
  const f=await fixture({failAfterDurable:true});try {
    await f.edit('My original answer.');await f.handles.lifecycle.submit('My original answer.');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Matches the source.'});
    await assert.rejects(f.handles.grade('good'),/receipt lost/);await settle(f.hooks);
    const first=f.drivers[0].runtime.session.snapshot();assert.equal(first.submitted.answer,'My original answer.');assert.equal(first.formal.status,'claimed');
    const claimedIdentity=first.formal.eventId;
    await f.handles.grade('good');assert.equal(f.formal.length,1,'a verified durable core is linked without invoking the writer a second time');assert.equal(f.formal[0].identity.eventId,claimedIdentity);assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');
  } finally {await f.close();}
});

test('durably linked first feedback stays available after refreshing the transient draft facade',async()=>{
  const f=await fixture();let restored;
  try{
    await f.handles.lifecycle.submit('original');await f.handles.lifecycle.assess({status:'correct',source:'model',rating:'good',explanation:'Source matched.'});
    await f.handles.grade('good',{deferAdvance:true});
    assert.equal(f.drivers[0].runtime.session.snapshot().formal.status,'linked');assert.equal(f.rawDraft.hasSavedFeedback(),false);
    assert.equal(f.handles.draft.hasSavedFeedback(),true);
    await f.close();restored=await fixture({scope:f.scope});assert.equal(restored.handles.draft.hasSavedFeedback(),true);
    assert.equal(restored.drivers[0].runtime.session.snapshot().submitted.answer,'original');assert.equal(restored.formal.length,0);
  }finally{if(restored)await restored.close();else await f.close();}
});
test('reading a reference in learn mode remains observed when returning to review before first submit',async()=>{
  const f=await fixture();try {
    await f.click('深入学习');assert.ok(text(f.hooks.view()).includes('先理解任务，再尝试'));assert.equal(f.drivers[0].runtime.session.snapshot().checkpoint.intent,'lesson');
    await f.click('日常复习');await f.edit('Answer after reading the reference.');await f.handles.lifecycle.submit('Answer after reading the reference.');
    const state=f.drivers.at(-1).runtime.session.snapshot();assert.equal(state.submitted.answerRevealed,true);assert.equal(state.submitted.assistance,'observed');
  } finally {await f.close();}
});
test('guided answer and learning step survive pause and remount instead of restoring an empty first attempt',async()=>{
  const f=await fixture();let reopened;try {
    await f.click('深入学习');await f.click('进入引导练习');await f.edit('Guided answer in progress.');await f.click('暂停并保存');
    const child=f.drivers.at(-1).runtime.session.snapshot();assert.equal(child.answer,'Guided answer in progress.');assert.equal(child.checkpoint.purpose,'guided');
    await f.close();reopened=await fixture({scope:f.scope});
    await reopened.click('继续学习');assert.equal(reopened.handles.lifecycle.purpose,'guided');assert.equal(reopened.handles.draft.read('answer',''),'Guided answer in progress.');assert.equal(reopened.drivers.at(-1).runtime.session.snapshot().attemptId,child.attemptId);
  } finally {if(reopened)await reopened.close();else await f.close();}
});
test('switching between first and guided work attributes each active interval once without counting inactive gaps',async()=>{
  const realNow=Date.now;let now=10000;Date.now=()=>now;let f;
  try {
    f=await fixture();await f.click('深入学习');now+=5000;await f.click('进入引导练习');
    const first=f.drivers[0],guided=f.drivers.at(-1);
    assert.equal(first.runtime.session.snapshot().checkpoint.activeSeconds,5);
    now+=7000;await f.edit('Guided answer.');await f.click('收起讲解，独立尝试');await f.click('暂停并保存');
    assert.equal((await guided.runtime.repository.read(guided.runtime.session.snapshot().attemptId)).checkpoint.activeSeconds,7);
    assert.equal((await first.runtime.repository.read(first.runtime.session.snapshot().attemptId)).checkpoint.activeSeconds,5);
    assert.equal(await first.runtime.groupSeconds(),7);
  } finally {if(f)await f.close();Date.now=realNow;}
});
test('checkpoint view and clock parsing accepts bounded recovery evidence and rejects arbitrary, malformed or reversed data',()=>{
  const checkpoint={phase:'answering',position:0,traversed:false,mode:'recall',view:{purpose:'guided',instanceId:'child-instance',lessonStep:'guided',paused:true,referenceSeen:true},activeSeconds:120,startActiveSeconds:5,targetMinutes:12};
  const mutation={schemaVersion:1,operationId:'clock',attemptId:'clock-attempt',binding:{ownerId:'clock-owner',libraryId:'clock-library',snapshotId:'s',itemKey:'q',contentHash:'a'.repeat(64),groupId:'g',roundId:'r'},expectedRevision:0,updatedAt:'2026-10-05T00:00:00Z',kind:'checkpoint',answer:'',parentAttemptId:null,checkpoint};
  assert.deepEqual(parseAttemptMutation(mutation).checkpoint,checkpoint);
  for(const invalid of [{activeSeconds:-1},{activeSeconds:1.5},{activeSeconds:86401},{targetMinutes:181},{startActiveSeconds:121},{view:{...checkpoint.view,paused:'true'}},{view:{...checkpoint.view,arbitrarySourcePath:'private-note.md'}}]) assert.throws(()=>parseAttemptMutation({...mutation,checkpoint:{...checkpoint,...invalid}}),/attempt/);
});
test('group clock projection isolates the current owner, group and round and excludes the active attempt itself',async()=>{
  const scope={workspaceId:'account:clock-group',ownerId:`group-clock-${serial++}`,libraryId:'clock-library',snapshotId:'s',itemKey:'first',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false};
  const first=await createNonWordRuntime(scope,'recall');await first.session.updateView({activeSeconds:5});
  const second=await createNonWordRuntime({...scope,itemKey:'second'},'recall');await second.session.updateView({activeSeconds:7});
  const outside=await createNonWordRuntime({...scope,itemKey:'other-round',roundId:'later-round'},'recall');await outside.session.updateView({activeSeconds:100});
  const otherOwner=await createNonWordRuntime({...scope,ownerId:'another-clock-owner',workspaceId:'account:another-clock-owner'},'recall');await otherOwner.session.updateView({activeSeconds:200});
  assert.equal(await first.groupSeconds(),7);assert.equal(await second.groupSeconds(),5);assert.equal(await outside.groupSeconds(),0);
});
test('a changed binding cannot accept new-source input into the old attempt while recovery is pending',async()=>{
  const f=await fixture(),waiting=deferred();try {
    const old=f.drivers[0].runtime.session.snapshot();
    const next={...f.props,bindingKey:'new-content-version',draft:createLearningDraftStore('new-source').adapter('question','recall'),createDriver:()=>waiting.promise};
    f.hooks.render(next);await settle(f.hooks);
    assert.equal(button(f.hooks.view(),'深入学习').props.disabled,true);
    let accepted=false;try {await f.handles.lifecycle.submit('Answer to the changed source.');accepted=true;}catch{/* A recovery boundary must refuse the new input. */}
    assert.equal(accepted,false);assert.equal((await f.drivers[0].runtime.repository.read(old.attemptId)).submitted,null);
  } finally {await f.close();}
});
async function savedDeferred(f,rating='again') {
  await f.edit('Immutable first answer.');await f.handles.lifecycle.submit('Immutable first answer.');
  await f.handles.lifecycle.assess({status:rating==='good'?'correct':'incorrect',source:'deterministic',rating,explanation:'Synthetic validated result.'});
  await f.handles.grade(rating,{deferAdvance:true});await settle(f.hooks);
}
test('deferred feedback links its formal result but does not traverse until durable explicit continuation',async()=>{
  const f=await fixture({commitFeedback:true});try {
    await savedDeferred(f);const first=f.drivers[0].runtime.session;
    assert.equal(first.snapshot().formal.status,'linked');assert.equal(first.snapshot().checkpoint.traversed,false);assert.equal(f.moves.length,0);assert.equal(f.rawDraft.hasSavedFeedback(),true);
    assert.equal(f.handles.draft.continueAfterFeedback(),true);assert.equal(f.handles.draft.continueAfterFeedback(),false);assert.equal(f.moves.length,0);
    await settle(f.hooks);assert.equal(first.snapshot().checkpoint.traversed,true);assert.equal(f.moves.length,1);assert.equal(f.moves[0].source,'draft');assert.equal(f.formal.length,1);
    assert.equal(f.handles.draft.continueAfterFeedback(),false);await settle(f.hooks);assert.equal(f.moves.length,1);
  } finally {await f.close();}
});
test('failed traversal persistence leaves feedback unconsumed and permits an explicit host retry after a plugin latched acceptance',async()=>{
  const f=await fixture({commitFeedback:true});try {
    await savedDeferred(f);const runtime=f.drivers[0].runtime,write=runtime.repository.mutate;let fail=true;
    runtime.repository.mutate=mutation=>{if(fail&&mutation.kind==='checkpoint'&&mutation.checkpoint.traversed){fail=false;return Promise.reject(Error('Synthetic traversal storage failure'));}return write(mutation);};
    const accepted=f.handles.draft.continueAfterFeedback();assert.equal(accepted,true);await settle(f.hooks);
    assert.equal(f.moves.length,0);assert.equal(runtime.session.snapshot().checkpoint.traversed,false);assert.equal(f.rawDraft.hasSavedFeedback(),true);assert.match(text(f.hooks.view()),/traversal storage failure/);
    const retry=button(f.hooks.view(),'重试继续');assert.ok(retry,'Plugins that latch accepted=true need a host-owned retry after asynchronous save failure');
    await retry.props.onClick();await settle(f.hooks);assert.equal(runtime.session.snapshot().checkpoint.traversed,true);assert.equal(f.moves.length,1);
  } finally {await f.close();}
});
test('remediation draft cannot consume its parent continuation and repeated finishes advance the original result once',async()=>{
  const f=await fixture({commitFeedback:true});try {
    await savedDeferred(f);await f.handles.lifecycle.startRemediation();await settle(f.hooks);
    assert.equal(f.handles.lifecycle.purpose,'remediation');assert.equal(f.rawDraft.hasSavedFeedback(),true);assert.equal(f.handles.draft.hasSavedFeedback(),false);assert.equal(f.handles.draft.continueAfterFeedback(),false);
    const finish=f.handles.lifecycle.finishRemediation;
    await Promise.all([finish(),finish()]);await settle(f.hooks);
    assert.equal(f.drivers[0].runtime.session.snapshot().checkpoint.traversed,true);assert.equal(f.formal.length,1);assert.equal(f.moves.length,1);
    await finish();await settle(f.hooks);assert.equal(f.moves.length,1);
  } finally {await f.close();}
});
test('already-linked grade continuation consumes the original draft once and creates no additional formal write',async()=>{
  const f=await fixture({commitFeedback:true});try {
    await savedDeferred(f);await f.handles.grade('again');await settle(f.hooks);
    assert.equal(f.formal.length,1);assert.equal(f.moves.length,1);assert.equal(f.moves[0].source,'draft');assert.equal(f.rawDraft.hasSavedFeedback(),false);
    await f.handles.grade('again');await settle(f.hooks);assert.equal(f.formal.length,1);assert.equal(f.moves.length,1);
  } finally {await f.close();}
});
test('temporary host continuation remains auxiliary and never reserves or links a formal event',async()=>{
  const f=await fixture({temporary:true,commitFeedback:true});try {
    await savedDeferred(f);const first=f.drivers[0].runtime.session.snapshot();assert.equal(first.checkpoint.purpose,'remediation');assert.equal(first.formal,null);assert.equal(f.formal.length,1);assert.equal(f.formal[0].identity,undefined);
    assert.equal(f.handles.draft.continueAfterFeedback(),true);assert.equal(f.handles.draft.continueAfterFeedback(),false);await settle(f.hooks);assert.equal(f.moves.length,1);
    assert.equal(f.drivers[0].runtime.session.snapshot().formal,null);
  } finally {await f.close();}
});
test('known cloud CAS conflict remains locked through autosave and offline synchronization before official writing',async()=>{
  const originalFetch=globalThis.fetch;let f;
  globalThis.fetch=async()=>{throw Error('Synthetic offline transport');};
  try {
    const owner=`offline-conflict-${serial++}`,scope={workspaceId:`account:${owner}`,ownerId:owner,libraryId:'offline-library',snapshotId:'offline-source',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:true};
    f=await fixture({scope,commitFeedback:true});await f.edit('First conflicting answer.');await f.handles.lifecycle.submit('First conflicting answer.');await f.handles.lifecycle.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'Original unresolved branch.'});
    const runtime=f.drivers[0].runtime,id=runtime.session.snapshot().attemptId;
    await runtime.repository.sync({mutate:async mutation=>({status:'conflict',durable:false,operationId:mutation.operationId,revision:99,attempt:null})});
    assert.equal(await runtime.repository.status(id),'cloud-conflict');
    await assert.rejects(f.handles.grade('again',{deferAdvance:true}),/另一设备|冲突/);
    assert.equal(f.formal.length,0);assert.equal(f.moves.length,0);assert.equal(await runtime.repository.status(id),'cloud-conflict');
    assert.equal((await runtime.repository.read(id)).submitted.answer,'First conflicting answer.');assert.ok((await runtime.repository.pending()).length>0);
  } finally {if(f)await f.close();globalThis.fetch=originalFetch;}
});
test('only verified acknowledgment of the complete compatible queue clears a known conflict; partial receipts preserve raw descendants',async()=>{
  const f=await fixture();try {
    await f.edit('Preserved first answer.');await f.handles.lifecycle.submit('Preserved first answer.');const runtime=f.drivers[0].runtime,id=runtime.session.snapshot().attemptId;
    await runtime.repository.sync({mutate:async mutation=>({status:'conflict',durable:false,operationId:mutation.operationId,revision:99,attempt:null})});
    await runtime.session.save('Preserved first answer.',{answer:'Preserved first answer.'},'submitted');assert.equal(await runtime.repository.status(id),'cloud-conflict');
    const queued=(await runtime.repository.pending()).sort((a,b)=>a.mutation.expectedRevision-b.mutation.expectedRevision),first=queued[0];
    let remote=applyAttemptMutation(null,first.mutation,first.fingerprint).attempt;
    await runtime.repository.ack(first.mutation.operationId,{status:'accepted',durable:true,operationId:first.mutation.operationId,revision:remote.revision,attempt:remote});
    assert.equal(await runtime.repository.status(id),'cloud-conflict');assert.equal((await runtime.repository.read(id)).submitted.answer,'Preserved first answer.');assert.equal((await runtime.repository.pending()).length,queued.length-1);
    const result=await runtime.repository.sync({mutate:async mutation=>{const receipt=applyAttemptMutation(remote,mutation,await attemptFingerprint(mutation));remote=receipt.attempt;return {...receipt,durable:receipt.status!=='conflict'};}});
    assert.equal(result.pending,0);assert.equal(result.conflict,false);assert.equal(await runtime.repository.status(id),'cloud-acked');assert.equal((await runtime.repository.read(id)).submitted.answer,'Preserved first answer.');
  } finally {await f.close();}
});
