import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields} from '../src/infrastructure/nonword-study/index.ts';
import {attachAccountMathDriver} from '../src/infrastructure/math-study/account-host-runtime.ts';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';
import {variantSource,mappingFetcher} from './fixtures/math-variant-host-fixture.mjs';
globalThis.indexedDB=indexedDB;
let serial=0;
export async function fixture(options={}){
 const source=await variantSource(options),scope={workspaceId:'variant-driver',ownerId:'variant-driver-'+serial++,libraryId:'library',snapshotId:source.snapshot.snapshotId,itemKey:source.item.itemKey,contentHash:source.item.contentHash,groupId:'group',roundId:'round',cloud:false};
 const originals=new Map(),records=new Map(),cloud={async read(id){return records.get(id)??null;},async mutate(mutation){
  const a=await originals.get(mutation.attemptId).repository.read(mutation.attemptId),parent=a.parentAttemptId?await originals.get(a.parentAttemptId).repository.read(a.parentAttemptId):undefined;
  const result=await applyPracticeEvidenceMutation(records.get(mutation.attemptId)??null,mutation,{attempt:a,parentAttempt:parent,source:{binding:a.binding,calculation:source.item.learningSupport,mapping:source.record.preparation.mapping}});
  records.set(mutation.attemptId,result.record);return {...result,durable:true};
 }};
 const create=async(purpose='first',parentAttemptId,instanceId)=>{
  const base=await createNonWordRuntime(scope,'calculation',{purpose,parentAttemptId,instanceId}),runtime={...base,scope:{...scope,cloud:true},async synchronize(){},async afterWrite(){}};
  originals.set(base.session.snapshot().attemptId,base);
  const driver={runtime,restore:()=>restoredFields(base.session.snapshot(),'calculation'),fields:values=>recoveryFields('calculation',values),answer:values=>rawAnswer('calculation',values)};
  return attachAccountMathDriver(driver,runtime,source,{cloud,fetcher:mappingFetcher(source,options),evaluate:async request=>({schemaVersion:1,attemptId:request.attemptId,answerRevision:request.answerRevision,sourceVersion:request.sourceVersion,final:{status:'correct',source:'deterministic',explanation:'synthetic result'}})});
 };
 return {source,scope,create,records};
}
test('driver creates actual child, saves descriptor before submit and restores typed JSON without altering first',async()=>{
 const f=await fixture(),parent=await f.create();await parent.runtime.session.submit('original 5');const first=parent.runtime.session.snapshot();
 const prepared=await parent.runtime.practice.calculation.getVariant(123),child=await f.create('remediation',first.attemptId,'child');
 await child.runtime.practice.calculation.prepareVariant(prepared.descriptor);assert.equal(child.runtime.session.snapshot().submitted,null);
 assert.deepEqual(child.runtime.practice.snapshot().variant,prepared.descriptor);assert.equal(child.runtime.practice.calculation.canVariant,false);
 assert.throws(()=>child.runtime.practice.stageStep('not allowed'),/step-unavailable/);await assert.rejects(()=>child.runtime.practice.calculation.evaluate('step'),/step-unavailable/);
 const values={value:'',calculationAnswerKind:'none'};await child.runtime.session.save(child.answer(values),child.fields(values));await child.runtime.session.submit(child.answer(values));
 const restored=await f.create('remediation',first.attemptId,'child');assert.equal(restored.restore().calculationAnswerKind,'none');assert.equal(restored.restore().value,'');
 assert.equal(restored.runtime.practice.calculation.activeVariant().variantHash,prepared.variant.variantHash);
 assert.equal(JSON.parse(restored.runtime.session.snapshot().submitted.answer).answerKind,'none');assert.deepEqual(Object.keys(restored.runtime.session.snapshot().checkpoint.pluginFields).sort(),['phase','value']);
 assert.deepEqual(parent.runtime.session.snapshot(),first);assert.equal(child.runtime.session.snapshot().formal,null);
});
test('missing mapping leaves legacy original raw numeric behavior and hides variant capability',async()=>{
 const f=await fixture({absent:true,legacy:true}),parent=await f.create();assert.equal(parent.runtime.practice.calculation.canVariant,false);assert.equal(await parent.runtime.practice.calculation.getVariant(1),null);
 assert.equal(parent.answer({value:'42'}),'42');assert.deepEqual(parent.fields({value:'42'}),{value:'42',phase:'answer'});
});
test('typed kinds serialize explicitly and cannot reinterpret a submitted original child',async()=>{
 const f=await fixture(),parent=await f.create();await parent.runtime.session.submit('original');const prepared=await parent.runtime.practice.calculation.getVariant(100);
 const child=await f.create('remediation',parent.runtime.session.snapshot().attemptId,'kinds');await child.runtime.practice.calculation.prepareVariant(prepared.descriptor);
 for(const kind of ['number','none','all','allowed','not-allowed'])assert.deepEqual(JSON.parse(child.answer({value:'7',calculationAnswerKind:kind})),{answerKind:kind,answer:kind==='number'?'7':''});
 const originalChild=await f.create('remediation',parent.runtime.session.snapshot().attemptId,'old-original');await originalChild.runtime.session.submit('saved numeric raw child');
 await assert.rejects(()=>originalChild.runtime.practice.calculation.prepareVariant(prepared.descriptor),/already-submitted/);assert.equal(originalChild.runtime.practice.snapshot(),null);
 assert.equal(originalChild.runtime.session.snapshot().submitted.answer,'saved numeric raw child');
});
test('approved historical cache survives offline, rejects a substituted descriptor and first-attempt descriptor',async()=>{
 const f=await fixture(),parent=await f.create();await parent.runtime.session.submit('original');const v=await parent.runtime.practice.calculation.getVariant(2);
 await assert.rejects(()=>parent.runtime.practice.calculation.prepareVariant(v.descriptor),/already-submitted|remediation-required/);
 const child=await f.create('remediation',parent.runtime.session.snapshot().attemptId,'two');
 await assert.rejects(()=>child.runtime.practice.calculation.prepareVariant({...v.descriptor,seed:3}),/binding/);assert.equal(child.runtime.practice.snapshot(),null);
 await child.runtime.practice.calculation.prepareVariant(v.descriptor);await child.runtime.session.save(child.answer({value:'5'}),child.fields({value:'5'}));
 const scope=f.scope,source=f.source,base=await createNonWordRuntime(scope,'calculation',{purpose:'remediation',parentAttemptId:parent.runtime.session.snapshot().attemptId,instanceId:'two'});
 const offline=await attachAccountMathDriver({runtime:base,restore:()=>restoredFields(base.session.snapshot(),'calculation'),fields:v=>recoveryFields('calculation',v),answer:v=>rawAnswer('calculation',v)},
  {...base,scope:{...scope,cloud:true},async synchronize(){throw Error('network unavailable');}},source,{cloud:{read:async()=>null,mutate:async()=>({status:'unsupported'})},fetcher:mappingFetcher(source,{offline:true})});
 assert.equal(offline.restore().value,'5');assert.equal(offline.runtime.practice.calculation.activeVariant().seed,2);
});
