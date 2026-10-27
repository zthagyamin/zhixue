/** Actual components/session/IndexedDB, with a bound in-memory transport. No HTTP server or model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory,IDBDatabase} from 'fake-indexeddb';
import {createHooks,loader,nodes,text,button,deferred,tick,waitForObservation} from './helpers/causal-harness.mjs';
import {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields,evaluationPhase} from '../src/infrastructure/nonword-study/index.ts';
import {createSourceLearningSession} from '../src/application/source-admission/index.ts';
import {createSourceAdmissionClient,createSourceSelfAssessmentRepository,sourceAdmissionFingerprint} from '../src/infrastructure/source-admission/index.ts';

globalThis.indexedDB=new IDBFactory();
const python=JSON.parse(readFileSync(new URL('./fixtures/source-flashcard-python-v1.json',import.meta.url),'utf8'));
const fixture=python.cases.find(row=>row.rating==='hard'),clone=value=>structuredClone(value);
let serial=0;
const equal=(left,right)=>assert.deepEqual(left,right);
async function hashBody(value,field){const body={...value};delete body[field];return {...body,[field]:await sourceAdmissionFingerprint(body)};}

/** SDK still validates every public response. Server effects are limited to synthetic maps. */
function transportState(){
  const state={online:false,confirmed:false,calls:[],submissions:new Map(),selves:new Map(),evaluations:new Map(),claims:new Map(),beforeFetch:null};
  const capture=()=>{
    if(state.confirmed)return clone(fixture.capture);
    const binding={...clone(fixture.capture.binding),captureId:'source-capture:'+'9'.repeat(64)};
    return {schemaVersion:1,status:'pending',durable:true,captureId:binding.captureId,binding,
      originalBinding:clone(binding),reason:'source-unverified'};
  };
  state.client=current=>createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
    capabilities:['nonword-source-v1'],libraryId:fixture.submission.binding.libraryId,isCurrent:current,
    fetcher:async(_url,init)=>{
      const {schemaVersion,action,request}=JSON.parse(init.body);assert.equal(schemaVersion,1);
      await state.beforeFetch?.({action,request});state.calls.push({action,request:clone(request)});
      if(!state.online)throw Error('Synthetic Companion unavailable.');
      if(action==='capture'){equal(request,fixture.query);return Response.json(capture());}
      const saved=state.submissions.get(request.attemptId);
      if(action==='submit'){
        equal(request.binding,capture().binding);assert.equal(request.answer,'');
        if(saved)equal(saved.submission,request);
        else state.submissions.set(request.attemptId,{submission:clone(request),capture:capture()});
        return Response.json({schemaVersion:1,durable:true,status:'saved',attemptId:request.attemptId,
          answerRevision:request.answerRevision,submittedAt:request.submittedAt,savedAt:new Date().toISOString(),
          submissionHash:await sourceAdmissionFingerprint(request)});
      }
      if(!saved)return Response.json({error:'source-admission-submission-required'},{status:409});
      if(action==='self-assess'){
        for(const field of ['attemptId','binding','answerRevision','submittedAt'])equal(request[field],saved.submission[field]);
        const previous=state.selves.get(request.attemptId);if(previous)equal(previous,request);
        else{state.selves.set(request.attemptId,clone(request));state.evaluations.delete(request.attemptId);}
        return Response.json({schemaVersion:1,durable:true,selfAssessment:request,selfAssessmentHash:await sourceAdmissionFingerprint(request)});
      }
      if(action==='read'){
        const submission=saved.submission,current=saved.capture,evaluation=state.evaluations.get(request.attemptId)??null;
        return Response.json({schemaVersion:1,durable:true,status:'saved',submission,binding:submission.binding,
          sourceBinding:current.status==='confirmed'?current.sourceBinding:null,
          selfAssessment:state.selves.get(request.attemptId)??null,evaluation,activeRequestId:evaluation?.requestId??null,
          receipt:{schemaVersion:1,durable:true,status:'saved',attemptId:submission.attemptId,
            answerRevision:submission.answerRevision,submittedAt:submission.submittedAt,savedAt:new Date().toISOString(),
            submissionHash:await sourceAdmissionFingerprint(submission)}});
      }
      if(action==='confirm'){
        assert.equal(state.confirmed,true);assert.equal(request.captureId,fixture.capture.captureId);
        saved.capture=clone(fixture.capture);state.evaluations.delete(request.attemptId);
        return Response.json({schemaVersion:1,durable:true,status:'confirmed',attemptId:request.attemptId,
          binding:saved.submission.binding,sourceBinding:fixture.capture.sourceBinding,sourceCaptureId:fixture.capture.captureId});
      }
      if(action==='evaluate'){
        assert.equal(saved.capture.status,'confirmed');const assessment=state.selves.get(request.attemptId);
        assert.ok(assessment);assert.equal(assessment.rating,'hard');
        const receipt=await hashBody({...clone(fixture.evaluation),requestId:request.requestId,attemptId:request.attemptId,
          binding:saved.submission.binding,sourceBinding:saved.capture.sourceBinding,sourceCaptureId:saved.capture.captureId,
          answerRevision:saved.submission.answerRevision,answerHash:await sourceAdmissionFingerprint(saved.submission.answer),
          selfAssessment:clone(assessment)},'evaluationHash');
        state.evaluations.set(request.attemptId,receipt);return Response.json(receipt);
      }
      if(action==='claim'){
        const evaluation=state.evaluations.get(request.attemptId),assessment=state.selves.get(request.attemptId);
        assert.ok(evaluation);assert.equal(request.rating,assessment.rating);
        const claim={...clone(fixture.claimReceipt.claim),attemptId:request.attemptId,eventId:request.eventId,
          binding:saved.submission.binding,sourceBinding:saved.capture.sourceBinding,sourceCaptureId:saved.capture.captureId,
          evaluationHash:evaluation.evaluationHash,answerRevision:saved.submission.answerRevision,
          answerHash:evaluation.answerHash,occurredAt:saved.submission.submittedAt,rating:assessment.rating};
        const previous=state.claims.get(request.attemptId);if(previous)equal(previous,claim);
        else state.claims.set(request.attemptId,clone(claim));
        return Response.json({schemaVersion:1,durable:true,status:'accepted',claim,claimHash:await sourceAdmissionFingerprint(claim)});
      }
      assert.fail('Unexpected source operation '+action);
    }});
  return state;
}

async function mount({scope,transport=transportState(),failSelfSave=false}={}){
  scope??={workspaceId:'account:self-host-'+serial,ownerId:'self-host-owner-'+serial++,libraryId:fixture.submission.binding.libraryId,
    snapshotId:'local',itemKey:fixture.query.itemKey,contentHash:fixture.query.contentHash,groupId:'flashcard-group',
    roundId:'flashcard-round',cloud:false,sourceConfirmationRequired:true};
  const host=createHooks(),hostLoad=loader(host.api),drivers=[],writes=[],moves=[],cores=new Map();
  const selfRepository=createSourceSelfAssessmentRepository({ownerId:scope.ownerId,libraryId:scope.libraryId});
  const state={readGate:null,gateEntered:null},rawDraft=hostLoad('app/learning-draft-store.ts').createLearningDraftStore(scope.workspaceId).adapter(scope.itemKey,'flashcard');
  let rendered,child=null,childKey,nonce=0;
  const selfAssessment={
    read:async attempt=>{if(state.readGate){state.gateEntered?.resolve();await state.readGate.promise;}return selfRepository.read(attempt);},
    save:async(attempt,rating)=>{
      if(!failSelfSave)return selfRepository.save(attempt,rating);
      // Abort the real self-assessment IndexedDB transaction; attempt storage remains available.
      const transaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(...args){
        const tx=transaction.apply(this,args);
        if(this.name==='zhixue-source-self-assessments-v1'&&args[1]==='readwrite')queueMicrotask(()=>tx.abort());
        return tx;
      };
      try{return await selfRepository.save(attempt,rating);}finally{IDBDatabase.prototype.transaction=transaction;}
    }};
  const verified=async eventId=>cores.get(eventId)??null;
  const createDriver=async(purpose,intent,parentAttemptId,instanceId,_taskId,current)=>{
    const source=createSourceLearningSession({query:fixture.query,libraryId:scope.libraryId,current,selfAssessment,
      transport:transport.client(current),fingerprint:sourceAdmissionFingerprint,newId:()=>String(++nonce)});
    const runtime=await createNonWordRuntime(scope,'flashcard',{purpose,intent,parentAttemptId,instanceId,
      sourceAdmission:source.assess,verifyFormalEvent:verified,isCurrent:current});
    await source.restoreSelf(runtime.session.snapshot());
    const driver={runtime,source:{selfRating:source.selfRating,beforeContinue:()=>source.beforeContinue(runtime.session.snapshot()),
      review:async()=>{await runtime.session.assess({status:'undetermined',source:'model',explanation:'恢复核对。'});await runtime.afterWrite();},
      beforeFormal:()=>source.beforeFormal(runtime.session.snapshot())},
      restore:()=>({...restoredFields(runtime.session.snapshot(),'flashcard'),...(source.selfRating()?{flashcardRating:source.selfRating()}:{})}),
      fields:values=>recoveryFields('flashcard',values),answer:values=>rawAnswer('flashcard',values),
      phase:()=>evaluationPhase(runtime.session.snapshot()),verifiedCore:async()=>{
        const formal=runtime.session.snapshot().formal;return formal?(await verified(formal.eventId))?.coreHash??null:null;}};
    drivers.push(driver);return driver;
  };
  const props={bindingKey:JSON.stringify(scope),mode:'flashcard',sourceConfirmationRequired:true,reference:fixture.query.presentation.back,
    draft:rawDraft,recallConfigured:false,createDriver,renderPlugin:(draft,lifecycle,grade)=>{rendered={draft,lifecycle,grade};return null;},
    onGrade:async(rating,options)=>{
      assert.equal(rating,'hard');const attempt=drivers[0].runtime.session.snapshot();
      assert.equal(attempt.submitted.answer,'');assert.equal(attempt.evaluation.source,'self-assess');
      assert.equal(attempt.evaluation.outcome,'partial');assert.equal(transport.claims.get(attempt.attemptId)?.rating,'hard');
      writes.push({rating,...clone(options)});cores.set(options.identity.eventId,{eventId:options.identity.eventId,coreHash:'d'.repeat(64),
        itemKey:scope.itemKey,contentHash:scope.contentHash,reviewedAt:options.identity.reviewedAt,rating});
      return {status:'saved'};
    },continuePending:()=>moves.push('pending'),resumeFormal:rating=>moves.push(rating),renderMath:value=>value};
  const childMount=()=>{
    child?.unmount();child=createHooks();
    const load=loader(child.api,{'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
      'app/assistance-display.tsx':{useAssistance:()=>({submit(){}}),useAssistanceDisplay(){}},
      'app/study-guidance.tsx':{StudyGuidance:()=>null},'app/math-text.tsx':{MathText:()=>null},
      'app/use-study-swipe.ts':{useStudySwipe:()=>({})},'src/features/remediation/index.ts':{CandidateLauncher:()=>null}},
      {addEventListener(){},removeEventListener(){}});
    const shell=load('app/plugins/plugin-flashcard.tsx').FlashcardPlugin.renderUI({data:{itemId:scope.itemKey,
      front:fixture.query.presentation.front,back:fixture.query.presentation.back},
      context:{draft:rendered.draft,nonWordLearning:rendered.lifecycle},onGrade:rendered.grade});
    child.mount(shell.type,shell.props);child.flush();
  };
  async function settle(){
    for(let index=0;index<8;index++){
      host.flush();await tick();host.render();
      const slot=[...nodes(host.view())].find(node=>typeof node.type==='function'&&node.props.renderPlugin&&node.props.lifecycle);
      if(slot){slot.type(slot.props);if(rendered?.lifecycle.ready&&(child===null||childKey!==slot.key)){childKey=slot.key;childMount();}}
      if(child){child.flush();await tick();child.render();}
    }
  }
  host.mount(hostLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,props);
  await waitForObservation(settle,()=>Boolean(rendered?.lifecycle.ready&&child),{label:'actual source-flashcard host ready'});
  return {scope,transport,host,drivers,selfRepository,state,writes,moves,props,settle,
    get lifecycle(){return rendered.lifecycle;},get draft(){return rendered.draft;},childView:()=>child.view(),
    async card(label){
      const target=[...nodes(child.view())].find(node=>node.type==='button'&&text(node).startsWith(label));
      assert.ok(target,'Missing card action '+label);assert.equal(target.props.disabled===true,false);
      await target.props.onClick();await settle();
    },
    async hostAction(label){
      const target=button(host.view(),label);assert.ok(target,'Missing host action '+label);
      assert.equal(target.props.disabled===true,false);await target.props.onClick();await settle();
    },
    async close(){child?.unmount();host.unmount();await tick();await tick();}};
}

test('unavailable Companion persists the first hard rating before transport and permits only durable pending continuation',async t=>{
  const h=await mount();t.after(()=>h.close());
  h.transport.beforeFetch=async()=>{const saved=await h.selfRepository.read(h.drivers[0].runtime.session.snapshot());assert.equal(saved?.rating,'hard');};
  await h.card('显示答案');await h.card('困难');
  const attempt=h.drivers[0].runtime.session.snapshot();
  assert.equal((await h.selfRepository.read(attempt)).rating,'hard');assert.equal(attempt.submitted.answer,'');
  assert.equal(attempt.evaluation.status,'pending');assert.equal(attempt.formal,null);assert.equal(h.writes.length,0);
  assert.match(text(h.childView()),/自评：困难/);assert.match(text(h.childView()),/待核对/);
  assert.equal(h.transport.calls.filter(row=>row.action==='claim').length,0);
  await h.hostAction('保留答案，继续');
  await waitForObservation(h.settle,()=>h.moves.length===1,{label:'durable pending continuation'});
  assert.deepEqual(h.moves,['pending']);assert.equal(h.drivers[0].runtime.session.snapshot().checkpoint.traversed,true);
  assert.equal(h.writes.length,0);
});

test('refresh restores immutable hard instead of a later view rating, then confirmed source writes one formal partial result',async t=>{
  let h=await mount();t.after(()=>h.close());
  await h.card('显示答案');await h.card('困难');
  const scope=h.scope,transport=h.transport,original=h.drivers[0].runtime.session.snapshot();
  await h.drivers[0].runtime.session.save('',{isFlipped:'true',flashcardRating:'easy'},'submitted');
  await h.close();h=await mount({scope,transport});
  assert.equal(h.drivers[0].runtime.session.snapshot().attemptId,original.attemptId);
  assert.equal(h.lifecycle.firstSelfRating,'hard');assert.equal(h.draft.read('flashcardRating',null),'hard');
  assert.match(text(h.childView()),/自评：困难/);assert.equal(h.writes.length,0);
  transport.online=true;await h.hostAction('恢复核对');
  await waitForObservation(h.settle,()=>transport.selves.has(original.attemptId)
    &&button(h.host.view(),'恢复核对')?.props.disabled!==true,{label:'original hard mirrored while source is still pending'});
  assert.equal(transport.selves.get(original.attemptId)?.rating,'hard');
  assert.equal(h.drivers[0].runtime.session.snapshot().evaluation.status,'pending');assert.equal(h.writes.length,0);
  transport.confirmed=true;await h.hostAction('恢复核对');
  await waitForObservation(h.settle,()=>h.drivers[0].runtime.session.snapshot().evaluation.status==='resolved',
    {label:'confirmed source evaluation: '+text(h.host.view())});
  assert.equal(h.drivers[0].runtime.session.snapshot().evaluation.outcome,'partial');
  assert.equal(h.drivers[0].runtime.session.snapshot().evaluation.rating,'hard');
  assert.ok(transport.calls.some(row=>row.action==='confirm'),'Pending original capture must be independently confirmed.');
  await h.card('重试保存自评');
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].rating,'hard');
  assert.equal(h.drivers[0].runtime.session.snapshot().formal.status,'linked');
  await h.card('继续');await h.settle();
  assert.equal(h.writes.length,1);assert.equal(transport.claims.size,1);
  equal(h.drivers[0].runtime.session.snapshot().submitted,original.submitted);
  assert.equal((await h.selfRepository.read(h.drivers[0].runtime.session.snapshot())).rating,'hard');
});

test('explicit source recovery survives an old host cleanup committing after remount without replacing the first answer',async t=>{
  const old=await mount();
  await old.card('显示答案');await old.card('困难');
  const session=old.drivers[0].runtime.session;
  await session.save('',{isFlipped:'true',flashcardRating:'easy'},'submitted');
  const original=session.snapshot(),gate=deferred(),entered=deferred(),committed=deferred(),save=session.save;
  session.save=async(...args)=>{entered.resolve();await gate.promise;const result=await save(...args);committed.resolve();return result;};
  await old.close();await entered.promise;
  const fresh=await mount({scope:old.scope,transport:old.transport});
  t.after(()=>fresh.close());
  assert.equal(fresh.drivers[0].runtime.session.snapshot().revision,original.revision);
  gate.resolve();await committed.promise;await tick();await session.flush();await tick();
  await session.updateView({activeSeconds:100});
  const stored=await fresh.drivers[0].runtime.repository.read(original.attemptId);
  assert.ok(stored.revision>original.revision);equal(stored.submitted,original.submitted);
  assert.equal((await fresh.selfRepository.read(stored)).rating,'hard');
  const repository=fresh.drivers[0].runtime.repository,mutate=repository.mutate;
  let evaluationEntered=false;const releaseEvaluation=deferred();
  t.after(()=>releaseEvaluation.resolve());
  repository.mutate=async mutation=>{
    if(mutation.kind==='evaluate'&&mutation.evaluation.status==='resolved'){
      evaluationEntered=true;await releaseEvaluation.promise;
    }
    return mutate(mutation);
  };
  fresh.transport.online=true;fresh.transport.confirmed=true;
  await fresh.hostAction('恢复核对');
  await waitForObservation(fresh.settle,()=>evaluationEntered,{label:'cleanup recovery computed result before persistence'});
  assert.equal(fresh.drivers[0].runtime.session.snapshot().evaluation.status,'pending');
  assert.equal(fresh.writes.length,0);
  releaseEvaluation.resolve();
  await waitForObservation(fresh.settle,()=>fresh.drivers[0].runtime.session.snapshot().evaluation.status==='resolved'
    &&button(fresh.host.view(),'恢复核对')?.props.disabled!==true,{label:'cleanup recovery evaluation durably resolved'});
  assert.doesNotMatch(text(fresh.host.view()),/另一设备已修改/);
  assert.equal(fresh.drivers[0].runtime.session.snapshot().evaluation.status,'resolved');
  assert.equal(fresh.drivers[0].runtime.session.snapshot().evaluation.rating,'hard');
  assert.ok(fresh.drivers[0].runtime.session.snapshot().checkpoint.activeSeconds>=100);
  assert.match(text(fresh.host.view()),/本组有效用时 1 分 40 秒/);
  equal(fresh.drivers[0].runtime.session.snapshot().submitted,original.submitted);
  assert.equal(fresh.transport.claims.size,0);assert.equal(fresh.writes.length,0);
});

test('recovered host time counts an overlapping cleanup interval once',async()=>{
  const realNow=Date.now;let now=realNow(),old,fresh,gate,closed=false;
  Date.now=()=>now;
  try{
    old=await mount();await old.card('显示答案');await old.card('困难');
    const session=old.drivers[0].runtime.session;
    await session.save('',{isFlipped:'true',flashcardRating:'easy'},'submitted');
    const original=session.snapshot(),entered=deferred(),committed=deferred(),save=session.save;
    gate=deferred();
    session.save=async(...args)=>{entered.resolve();await gate.promise;const result=await save(...args);committed.resolve();return result;};
    await old.close();closed=true;await entered.promise;
    fresh=await mount({scope:old.scope,transport:old.transport});
    now+=5000;gate.resolve();await committed.promise;await tick();await session.flush();await tick();
    assert.equal((await fresh.drivers[0].runtime.repository.read(original.attemptId)).checkpoint.activeSeconds,5);
    fresh.transport.online=true;fresh.transport.confirmed=true;await fresh.hostAction('恢复核对');
    await waitForObservation(fresh.settle,()=>fresh.drivers[0].runtime.session.snapshot().evaluation.status==='resolved'
      &&button(fresh.host.view(),'恢复核对')?.props.disabled!==true,{label:'overlapping cleanup source recovery durably resolved'});
    assert.equal(fresh.drivers[0].runtime.session.snapshot().evaluation.status,'resolved');
    assert.equal(fresh.drivers[0].runtime.session.snapshot().checkpoint.activeSeconds,5);
    assert.match(text(fresh.host.view()),/本组有效用时 0 分 5 秒/);
    equal(fresh.drivers[0].runtime.session.snapshot().submitted,original.submitted);
    assert.equal(fresh.transport.claims.size,0);assert.equal(fresh.writes.length,0);
  }finally{gate?.resolve();if(fresh)await fresh.close();else if(old&&!closed)await old.close();Date.now=realNow;}
});

test('source review retains its computed result when a peer checkpoint arrives before local evaluation persistence',async t=>{
  const h=await mount();t.after(()=>h.close());
  await h.card('显示答案');await h.card('困难');
  const original=h.drivers[0].runtime.session.snapshot(),peer=await createNonWordRuntime(h.scope,'flashcard');
  assert.equal(peer.session.snapshot().attemptId,original.attemptId);
  let written=false;
  h.transport.beforeFetch=async({action})=>{
    if(action!=='evaluate'||written)return;
    written=true;await peer.session.open();
    await peer.session.save('',{...peer.session.snapshot().checkpoint.pluginFields,flashcardRating:'easy'},'submitted');
  };
  const repository=h.drivers[0].runtime.repository,mutate=repository.mutate,release=deferred();
  let held=false;
  t.after(()=>release.resolve());
  repository.mutate=async mutation=>{
    if(mutation.kind==='evaluate'&&mutation.evaluation.status==='resolved'&&!held){
      held=true;await release.promise;
    }
    return mutate(mutation);
  };
  h.transport.online=true;h.transport.confirmed=true;await h.hostAction('恢复核对');
  await waitForObservation(h.settle,()=>held,{label:'computed source result waiting for local persistence'});
  assert.equal(h.drivers[0].runtime.session.snapshot().evaluation.status,'pending');
  release.resolve();
  await waitForObservation(h.settle,()=>h.drivers[0].runtime.session.snapshot().evaluation.status==='resolved',
    {label:'computed source result persisted after peer checkpoint'});
  assert.equal(written,true);
  assert.equal(h.transport.evaluations.get(original.attemptId).status,'resolved');
  assert.equal(h.drivers[0].runtime.session.snapshot().evaluation.status,'resolved');
  assert.equal(h.transport.calls.filter(row=>row.action==='evaluate').length,1);
  equal(h.drivers[0].runtime.session.snapshot().submitted,original.submitted);
  assert.equal(h.transport.claims.size,0);assert.equal(h.writes.length,0);
});

test('scope retirement during a late-result compatibility reread prevents local evaluation retry',async t=>{
  const h=await mount();t.after(()=>h.close());
  await h.card('显示答案');await h.card('困难');
  const runtime=h.drivers[0].runtime,original=runtime.session.snapshot(),peer=await createNonWordRuntime(h.scope,'flashcard');
  let written=false;
  h.transport.beforeFetch=async({action})=>{
    if(action!=='evaluate'||written)return;
    written=true;await peer.session.open();await peer.session.updateView({activeSeconds:5});
  };
  const gate=deferred(),entered=deferred(),read=runtime.repository.read;
  runtime.repository.read=async(...args)=>{entered.resolve();await gate.promise;return read(...args);};
  h.transport.online=true;h.transport.confirmed=true;
  const operation=h.hostAction('恢复核对');await entered.promise;
  assert.equal(h.transport.evaluations.get(original.attemptId).status,'resolved');
  h.host.render({...h.props,bindingKey:'retired-owner-content',createDriver:()=>new Promise(()=>{})});h.host.flush();
  gate.resolve();await operation;await tick();await runtime.session.flush();await tick();
  const stored=await read(original.attemptId);
  assert.equal(runtime.session.snapshot().evaluation.status,'pending');assert.equal(stored.evaluation.status,'pending');
  equal(stored.submitted,original.submitted);assert.equal(stored.formal,null);
  assert.equal(h.transport.calls.filter(row=>row.action==='evaluate').length,1);
  assert.equal(h.transport.claims.size,0);assert.equal(h.writes.length,0);
});

test('aborted actual self-assessment transaction preserves oral answer and blocks pending advancement',async t=>{
  const h=await mount({failSelfSave:true});t.after(()=>h.close());
  await h.card('显示答案');await h.card('困难');
  const attempt=h.drivers[0].runtime.session.snapshot();
  assert.equal(attempt.submitted.answer,'');assert.equal(await h.selfRepository.read(attempt),null);
  assert.equal(h.transport.calls.length,0);assert.equal(h.writes.length,0);
  assert.match(text(h.childView()),/保存|失败/);
  await h.hostAction('保留答案，继续');await h.settle();
  assert.deepEqual(h.moves,[]);assert.equal(h.drivers[0].runtime.session.snapshot().checkpoint.traversed,false);
  assert.match(text(h.host.view()),/自评尚未可靠保存/);
});

test('scope change while the original declaration is read prevents traversal and either continuation',async t=>{
  const h=await mount();t.after(()=>h.close());
  await h.card('显示答案');await h.card('困难');
  const original=h.drivers[0].runtime.session.snapshot();
  h.state.readGate=deferred();h.state.gateEntered=deferred();
  const target=button(h.host.view(),'保留答案，继续');target.props.onClick();
  await h.state.gateEntered.promise;
  h.host.render({...h.props,bindingKey:'another-owner-or-content',createDriver:()=>new Promise(()=>{})});
  h.host.flush();h.state.readGate.resolve();await h.settle();
  assert.deepEqual(h.moves,[]);assert.equal(h.writes.length,0);
  assert.equal(h.drivers[0].runtime.session.snapshot().checkpoint.traversed,false);
  equal(h.drivers[0].runtime.session.snapshot().submitted,original.submitted);
  assert.equal((await h.selfRepository.read(h.drivers[0].runtime.session.snapshot())).rating,'hard');
});
test('a malformed array rating cannot become a durable first declaration in the actual local repository',async t=>{
  const h=await mount();t.after(()=>h.close());
  await h.lifecycle.submit('');
  const original=h.drivers[0].runtime.session.snapshot();
  await assert.rejects(h.selfRepository.save(original,['hard']),/self-assessment-rating/);
  assert.equal(await h.selfRepository.read(original),null);assert.equal(h.writes.length,0);
});
