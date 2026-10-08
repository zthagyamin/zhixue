import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createHooks,loader,tick,nodes,waitForObservation,deferred} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields,evaluationPhase} from '../src/infrastructure/nonword-study/index.ts';
import {attachAccountMathDriver} from '../src/infrastructure/math-study/account-host-runtime.ts';
import {variantSource,mappingFetcher} from './fixtures/math-variant-host-fixture.mjs';
globalThis.indexedDB=indexedDB;
let serial=0;
async function settle(hooks){for(let i=0;i<15;i++){hooks.flush();await tick();hooks.render();for(const node of nodes(hooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function')node.type(node.props);}}
async function fixture({absent=false,waitVariant}={}){
 const source=await variantSource(),scope={workspaceId:'math-variant-host-'+serial,ownerId:'math-variant-host-'+serial++,libraryId:'library',snapshotId:source.snapshot.snapshotId,itemKey:source.item.itemKey,contentHash:source.item.contentHash,groupId:'group',roundId:'round',cloud:false};
 const store=createLearningDraftStore(scope.workspaceId),draft=store.adapter(scope.itemKey,'calculation'),drivers=[],formal=[],moves=[];
 let handles,core=null,failPrepare=false,variantRequested=false;
 const createDriver=async(purpose,intent,parentAttemptId,instanceId)=>{
  const base=await createNonWordRuntime(scope,'calculation',{purpose,intent,parentAttemptId,instanceId,verifyFormalEvent:async id=>core?.eventId===id?core:null});
  const runtime={...base,scope:{...scope,cloud:true},async synchronize(){},async afterWrite(){}};
  const raw={runtime,restore:()=>restoredFields(base.session.snapshot(),'calculation'),fields:values=>recoveryFields('calculation',values),answer:values=>rawAnswer('calculation',values),phase:()=>evaluationPhase(base.session.snapshot()),verifiedCore:async()=>core?.coreHash??null};
  const fetcher=mappingFetcher(source,{absent});
  const driver=await attachAccountMathDriver(raw,runtime,source,{fetcher:async(url,init)=>{
   if(JSON.parse(init.body).action==='math-variant'){variantRequested=true;await waitVariant?.promise;}
   return fetcher(url,init);
  },cloud:{read:async()=>null,mutate:async()=>({status:'unsupported'})}});
  const prepare=driver.runtime.practice.calculation.prepareVariant;
  driver.runtime.practice.calculation.prepareVariant=async descriptor=>{if(failPrepare){failPrepare=false;throw Error('synthetic descriptor save failure');}return prepare(descriptor);};
  drivers.push({driver,instanceId});return driver;
 };
 const props={bindingKey:JSON.stringify(scope),mode:'calculation',draft,question:source.item.practice.prompt,reference:'Original solution',recallConfigured:false,createDriver,
  renderPlugin(current,lifecycle,grade){handles={draft:current,lifecycle,grade};return 'Synthetic calculation interaction';},
  async onGrade(rating,options){formal.push({rating,...options});core={eventId:options.identity.eventId,coreHash:'c'.repeat(64),itemKey:scope.itemKey,contentHash:scope.contentHash,reviewedAt:options.identity.reviewedAt,rating};return {status:'saved'};},
  continuePending(){moves.push('pending');},resumeFormal(rating){moves.push(rating);},renderMath:value=>value};
 let hooks;
 async function mount(){hooks=createHooks();hooks.mount(loader(hooks.api)('src/features/nonword-study/host.tsx').NonWordStudyHost,props);await waitForObservation(()=>settle(hooks),()=>Boolean(handles?.lifecycle.ready),{label:'actual calculation host ready'});}
 await mount();
 return {drivers,formal,moves,get handles(){return handles;},get variantRequested(){return variantRequested;},async settle(){await settle(hooks);},
  failNextPrepare(){failPrepare=true;},async reload(){hooks.unmount();await tick();handles=null;await mount();},async close(){hooks.unmount();await tick();await tick();}};
}
async function firstOutcome(f){f.handles.draft.write('value','original 5');await f.handles.lifecycle.submit('original 5');await f.handles.lifecycle.assess({status:'incorrect',source:'deterministic',explanation:'Synthetic incorrect first',rating:'again'});await f.handles.grade('again',{deferAdvance:true});await f.settle();}
test('actual Host opens seeded same-page child, grades only first once and returns first continuation',async()=>{
 const f=await fixture();try{
  await firstOutcome(f);const first=f.drivers[0].driver.runtime.session.snapshot();
  await Promise.all([f.handles.lifecycle.startVariant(42),f.handles.lifecycle.startVariant(77)]);await f.settle();
  assert.equal(f.handles.lifecycle.purpose,'remediation');assert.equal(f.handles.lifecycle.practice.calculation.activeVariant().seed,42);
  const childId=f.handles.lifecycle.attemptId;assert.notEqual(childId,first.attemptId);assert.equal(f.formal.length,1);
  await assert.rejects(()=>f.handles.lifecycle.startVariant(9),/首轮/);assert.equal(f.handles.lifecycle.attemptId,childId);
  f.handles.draft.write('value','5');await f.handles.lifecycle.submit(JSON.stringify({answerKind:'number',answer:'5'}));await f.handles.lifecycle.assess({status:'correct',source:'deterministic',explanation:'Synthetic child result',rating:'good'});await f.handles.grade('good',{deferAdvance:true});
  assert.equal(f.formal.length,1);assert.equal(f.drivers.at(-1).driver.runtime.session.snapshot().formal,null);
  await f.handles.lifecycle.finishRemediation();assert.deepEqual(f.moves,['again']);assert.equal(f.formal.length,1);
  assert.equal(f.drivers[0].driver.runtime.session.snapshot().submitted.answer,first.submitted.answer);assert.equal(f.drivers[0].driver.runtime.session.snapshot().formal.eventId,first.formal.eventId);
 }finally{await f.close();}
});
test('creation failure exposes no child editor and reload recreates exact persisted intent and descriptor',async()=>{
 const f=await fixture();try{
  await firstOutcome(f);f.failNextPrepare();await assert.rejects(()=>f.handles.lifecycle.startVariant(88),/save failure/);
  assert.equal(f.handles.lifecycle.purpose,'first');const failed=f.drivers.at(-1),id=failed.driver.runtime.session.snapshot().attemptId;
  assert.equal(failed.driver.runtime.practice.snapshot(),null);assert.equal(failed.driver.runtime.session.snapshot().submitted,null);
  await f.reload();assert.equal(f.handles.lifecycle.attemptId,id);assert.equal(f.handles.lifecycle.practice.calculation.activeVariant().seed,88);
  assert.deepEqual(failed.driver.runtime.session.snapshot().submitted,null);assert.equal(f.formal.length,1);
 }finally{await f.close();}
});
test('pending original blocks child creation, absent approval hides actual Host capability',async()=>{
 const f=await fixture({absent:true});try{
  assert.equal(f.handles.lifecycle.practice.calculation.canVariant,false);await f.handles.lifecycle.submit('raw pending');
  await assert.rejects(()=>f.handles.lifecycle.startVariant(1),/待核对/);assert.equal(f.drivers.length,1);assert.equal(f.formal.length,0);
 }finally{await f.close();}
});
test('a late variant reply after host scope closes cannot activate or create a child',async()=>{
 const gate=deferred(),f=await fixture({waitVariant:gate});try{
  await firstOutcome(f);const operation=f.handles.lifecycle.startVariant(91);operation.catch(()=>{});
  await waitForObservation(()=>f.settle(),()=>f.variantRequested,{label:'pending source-approved variant request'});
  await f.close();gate.resolve();await assert.rejects(()=>operation,/切换/);
  assert.equal(f.drivers.length,1);assert.equal(f.formal.length,1);assert.equal(f.drivers[0].driver.runtime.session.snapshot().submitted.answer,'original 5');
 }finally{gate.resolve();await f.close();}
});
