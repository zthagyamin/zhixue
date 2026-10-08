import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {reviewedCases,reviewedSource} from './fixtures/math-mapping-fixtures.mjs';
import {createNativeMathClient} from '../src/infrastructure/math-study/native-client.ts';
import {validateNativeMathMappingRecord,rebuildNativeMathVariant} from '../src/domain/math-study/native-mapping.ts';
import {createNativeMathMappingCache} from '../src/infrastructure/math-study/native-mapping-cache.ts';
import {nativeMathTask,attachNativeMathDriver} from '../src/infrastructure/math-study/native-host-runtime.ts';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {nativeMathClaimHash} from '../src/domain/math-study/index.ts';
import {evaluateMathVariant} from '../src/domain/guided-math/index.ts';
import {parseNativeMathClaim} from '../src/domain/math-study/index.ts';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const python=process.env.PYTHON||'python';
globalThis.indexedDB=indexedDB;
let sequence=0;
async function fixture(example=reviewedCases[0]){
 const raw=reviewedSource(example),identity={schemaVersion:1,libraryId:'local-vault:'+'a'.repeat(64),itemKey:'practice:'+raw.item.itemKey,contentHash:'b'.repeat(64),localBindingHash:'c'.repeat(64)};
 const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:identity.itemKey,contentHash:identity.contentHash,learningSupport:raw.item.learningSupport,
  practice:{questionType:'calculation',prompt:example.prompt,answer:example.answer,sourceLabel:'Reviewed synthetic material',domain:'math'}};
 const body={schemaVersion:1,identity,item},capture={...body,captureId:await studyHash(body)};
 const preparation={...raw.preparation,snapshotId:'local',mapping:{...raw.preparation.mapping,parentItemKey:identity.itemKey,parentContentHash:identity.contentHash}},recordBody={schemaVersion:1,identity,captureId:capture.captureId,preparation};
 const record={...recordBody,receiptHash:await studyHash(recordBody)},ownerId='native-variant-owner-'+sequence++;
 const scope={workspaceId:'workspace',ownerId,libraryId:identity.libraryId,snapshotId:'local',itemKey:identity.itemKey,contentHash:identity.contentHash,groupId:'group',roundId:'round',cloud:false,nativeMathIdentity:identity,nativeMathPresentation:item};
 return {example,identity,item,capture,preparation,record,scope};
}
const options={baseUrl:'http://127.0.0.1:5195',sessionToken:'test',capabilities:['native-math-v1','native-math-variants-v1']};
for(const example of reviewedCases)test(`paired native ${example.templateId} mapping and complete variant are independently rebuilt`,async()=>{
 const f=await fixture(example),calls=[],expected=await rebuildNativeMathVariant(f.capture,f.record,7);
 const client=createNativeMathClient({...options,fetcher:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body,init});return {ok:true,status:200,json:async()=>url.endsWith('/mapping/read')?{schemaVersion:1,durable:true,status:'available',record:f.record}:{schemaVersion:1,status:'available',...expected,mapping:f.preparation.mapping}};}});
 assert.deepEqual(await client.mapping(f.capture),f.record);assert.deepEqual(await client.variant(f.capture,'parent',7,f.record),expected);
 assert.deepEqual(calls[1].body,{schemaVersion:1,identity:f.identity,captureId:f.capture.captureId,attemptId:'parent',seed:7});
 assert.equal(calls[1].init.headers['X-Study-Loop-Session'],'test');assert.equal('publish' in client,false);
});
test('native mapping validation rejects wrong source, unreviewed conditions, seed or response definition',async()=>{
 const f=await fixture(),rebuilt=await rebuildNativeMathVariant(f.capture,f.record,7);
 for(const patch of [{captureId:'d'.repeat(64)},{identity:{...f.identity,localBindingHash:'d'.repeat(64)}},{preparation:{...f.preparation,snapshotId:'other'}},
  {preparation:{...f.preparation,review:{sourceQuote:'not present',rationale:f.preparation.review.rationale}}},
  {preparation:{...f.preparation,review:{sourceQuote:f.preparation.review.sourceQuote,rationale:'short'}}},
  {preparation:{...f.preparation,mapping:{...f.preparation.mapping,sourceConditions:[]}}}]){
  const {receiptHash,...body}={...f.record,...patch};assert.ok(receiptHash);await assert.rejects(validateNativeMathMappingRecord({...body,receiptHash:await studyHash(body)},f.capture));
 }
 for(const response of [{...rebuilt,variant:{...rebuilt.variant,seed:8}}, {...rebuilt,descriptor:{...rebuilt.descriptor,seed:8}},
  {...rebuilt,variant:{...rebuilt.variant,definition:{...rebuilt.variant.definition,answer:'caller answer'}}}]){
  const client=createNativeMathClient({...options,fetcher:async()=>({ok:true,status:200,json:async()=>({schemaVersion:1,status:'available',...response,mapping:f.preparation.mapping})})});
  await assert.rejects(client.variant(f.capture,'parent',7,f.record),/binding/);
 }
});
test('actual native mapping cache survives reload, keeps complete source binding and isolates owner/library',async()=>{
 const f=await fixture(),cache=createNativeMathMappingCache(f.scope,f.capture);await cache.save(f.record);
 assert.deepEqual(await createNativeMathMappingCache(f.scope,f.capture).read(),f.record);
 assert.equal(await createNativeMathMappingCache({...f.scope,ownerId:'other'},f.capture).read(),null);
 await assert.rejects(createNativeMathMappingCache({...f.scope,libraryId:'local-vault:'+'d'.repeat(64)},f.capture).read(),/binding/);
 const escaped=await cache.read();escaped.preparation.mapping.parameters.k=8;assert.deepEqual(await cache.read(),f.record);
 const {receiptHash,...changed}=f.record;assert.ok(receiptHash);changed.preparation={...changed.preparation,review:{...changed.preparation.review,rationale:changed.preparation.review.rationale+' Independently reviewed again.'}};
 await assert.rejects(cache.save({...changed,receiptHash:await studyHash(changed)}),/conflict/);assert.deepEqual(await cache.read(),f.record);
});
test('old capability and unavailable approved mapping hide variants without publishing or transport leakage',async()=>{
 const f=await fixture();let calls=0;
 const old=createNativeMathClient({...options,capabilities:['native-math-v1'],fetcher:async()=>{calls++;throw Error('unexpected');}});
 assert.equal(old.variantSupported(),false);await assert.rejects(old.mapping(f.capture),/unsupported/);assert.equal(calls,0);
 const missing=createNativeMathClient({...options,fetcher:async()=>({ok:true,status:200,json:async()=>({schemaVersion:1,durable:true,status:'unavailable',reason:'missing-approved-mapping'})})});
 assert.equal(await missing.mapping(f.capture),null);
});
async function attachedFixture(example=reviewedCases[0],{old=false,missing=false}={}){
 const f=await fixture(example),claims=new Map(),calls=[];let offline=false;
 const client=createNativeMathClient({...options,...(old?{capabilities:['native-math-v1']}:{}) ,fetcher:async(url,init)=>{
  const request=JSON.parse(init.body);calls.push({url,request});if(offline)throw Error('offline');
  const reply=data=>({ok:true,status:200,json:async()=>data});
  if(url.endsWith('/source/capture')||url.endsWith('/source/read'))return reply({schemaVersion:1,durable:true,capture:f.capture});
  if(url.endsWith('/mapping/read'))return reply(missing?{schemaVersion:1,durable:true,status:'unavailable',reason:'missing-approved-mapping'}:{schemaVersion:1,durable:true,status:'available',record:f.record});
  if(url.endsWith('/read')){
   const claim=claims.get(request.attemptId);return claim?reply({schemaVersion:1,durable:true,claim,results:[],formalBarrier:null}):{ok:false,status:400,json:async()=>({error:'native-math-attempt-not-found'})};
  }
  if(url.endsWith('/claim')){
   assert.equal(request.action,undefined,'native variants never write formal barriers');
   if(request.variant){const parent=claims.get(request.attempt.parentAttemptId);assert.ok(parent);assert.equal(parent.variant,undefined);assert.deepEqual(parent.attempt.binding,request.attempt.binding);assert.equal(request.attempt.checkpoint.purpose,'remediation');}
   claims.set(request.attempt.attemptId,structuredClone(request));
   return reply({schemaVersion:1,durable:true,attemptId:request.attempt.attemptId,answerRevision:request.attempt.submitted.answerRevision,captureId:request.captureId,claimHash:await nativeMathClaimHash(request)});
  }
  if(url.endsWith('/variant')){assert.ok(claims.get(request.attemptId));const rebuilt=await rebuildNativeMathVariant(f.capture,f.record,request.seed);return reply({schemaVersion:1,status:'available',...rebuilt,mapping:f.preparation.mapping});}
  if(url.endsWith('/evaluate')){
   const saved=claims.get(request.attemptId);assert.ok(saved.variant);assert.equal(request.mode,'final');
   const rebuilt=await rebuildNativeMathVariant(f.capture,f.record,saved.variant.seed),checked=evaluateMathVariant(rebuilt.variant,JSON.parse(saved.attempt.submitted.answer)).final;
   const body={schemaVersion:1,durable:true,requestId:request.requestId,attemptId:request.attemptId,answerRevision:request.answerRevision,sourceVersion:request.sourceVersion,
    final:{status:checked.verdict==='correct'?'correct':checked.verdict==='wrong'?'incorrect':'undetermined',source:'deterministic',explanation:checked.explanation},capability:{variant:'available'}};
   return reply({...body,receiptHash:await studyHash(body)});
  }throw Error('unexpected '+url);
 }});
 async function attach(runtime,prepared){return attachNativeMathDriver({runtime,fields:values=>({value:String(values.value??'')}),answer:values=>String(values.value??''),restore:()=>({value:runtime.session.snapshot().answer}),phase:()=> 'answering'},runtime,prepared,client);}
 const prepared=await nativeMathTask(f.scope,'first',undefined,client),runtime=await createNonWordRuntime(f.scope,'calculation'),driver=await attach(runtime,prepared);
 return {...f,client,runtime,driver,prepared,calls,claims,attach,setOffline:value=>{offline=value;}};
}
for(const example of reviewedCases)test(`native ${example.templateId} opens only a real remediation child, restores offline and grades its JSON result`,async()=>{
 const h=await attachedFixture(example),parent=h.runtime.session.snapshot();assert.equal(h.driver.runtime.practice.calculation.canVariant,true);
 await assert.rejects(h.driver.runtime.practice.calculation.getVariant(7),/submitted-parent/);
 await h.runtime.session.submit(example.answer);
 const selected=await h.driver.runtime.practice.calculation.getVariant(7);assert.ok(selected);
 await assert.rejects(h.driver.runtime.practice.calculation.prepareVariant(selected.descriptor),/parent-binding/);
 const prepared=await nativeMathTask(h.scope,'remediation',parent.attemptId,h.client),child=await createNonWordRuntime(h.scope,'calculation',{purpose:'remediation',parentAttemptId:parent.attemptId,binding:parent.binding,instanceId:'variant:7'});
 const d=await h.attach(child,prepared);await d.runtime.practice.calculation.prepareVariant(selected.descriptor);
 assert.equal(d.runtime.practice.calculation.activeVariant().variantHash,selected.variant.variantHash);assert.equal(d.runtime.practice.calculation.canVariant,false);
 const kind=selected.variant.definition.answerKind,value=kind==='number'?selected.variant.definition.answer:'';
 const raw=d.answer({value,calculationAnswerKind:kind});assert.deepEqual(JSON.parse(raw),{answerKind:kind,answer:value});
 await child.session.save(raw,d.fields({value,calculationAnswerKind:kind}),'answering');await child.session.submit(raw);
 const result=await d.runtime.practice.calculation.evaluate('final');assert.equal(result.final.status,'correct');
 const claimed=h.claims.get(child.session.snapshot().attemptId);assert.deepEqual(parseNativeMathClaim(claimed),claimed);
 assert.throws(()=>parseNativeMathClaim({...claimed,attempt:{...claimed.attempt,parentAttemptId:null,checkpoint:{...claimed.attempt.checkpoint,purpose:'first'}}}),/variant-binding/);
 const extra=JSON.stringify({answerKind:kind,answer:value,expected:'caller supplied'});
 assert.throws(()=>parseNativeMathClaim({...claimed,attempt:{...claimed.attempt,answer:extra,submitted:{...claimed.attempt.submitted,answer:extra}}}));
 await assert.rejects(d.runtime.practice.calculation.evaluate('step'),/variant-step/);await assert.rejects(d.runtime.practice.saveStep('unrelated'),/variant-step/);
 await child.session.assess({status:'correct',source:'deterministic',explanation:result.final.explanation,rating:'good'});await assert.rejects(child.session.reserve('good'));
 const saved=await child.repository.read(child.session.snapshot().attemptId);assert.equal(saved.formal,null);
 h.setOffline(true);
 const restoredRuntime=await createNonWordRuntime(h.scope,'calculation',{purpose:'remediation',parentAttemptId:parent.attemptId,binding:parent.binding,instanceId:'variant:7'});
 const restored=await h.attach(restoredRuntime,prepared);assert.equal(restored.runtime.practice.calculation.activeVariant().variantHash,selected.variant.variantHash);
 assert.equal(restored.restore().value,value);assert.equal(restored.restore().calculationAnswerKind,kind);
 assert.deepEqual(restored.runtime.practice.snapshot().variant,selected.descriptor);assert.equal(h.calls.some(c=>c.url.includes('/publish')||c.url.includes('/events')),false);
});
test('old native Companion and missing mapping leave variant button unavailable on actual driver',async()=>{
 for(const setup of [{old:true},{missing:true}]){const h=await attachedFixture(reviewedCases[0],setup);assert.equal(h.driver.runtime.practice.calculation.canVariant,false);assert.equal(h.driver.runtime.practice.calculation.getVariant,undefined);}
});
test('native mapping compares normalized condition sets and admits canonical quote limit; unsafe seed stops before POST',async()=>{
 const f=await fixture(),quote='q'.repeat(1000);
 f.item.practice.prompt=quote+' original question';f.item.learningSupport.conditions=['alpha','beta'];
 const {captureId,...captureBody}=f.capture;assert.ok(captureId);f.capture.captureId=await studyHash(captureBody);
 const {receiptHash,...recordBody}=f.record;assert.ok(receiptHash);recordBody.captureId=f.capture.captureId;
 recordBody.preparation={...f.preparation,mapping:{...f.preparation.mapping,sourceConditions:['ALPHA',' BETA ']},review:{sourceQuote:quote,rationale:'Reviewed source conditions retain their exact authored sequence.'}};
 const record={...recordBody,receiptHash:await studyHash(recordBody)};assert.deepEqual(await validateNativeMathMappingRecord(record,f.capture),record);
 const swapped={...recordBody,preparation:{...recordBody.preparation,mapping:{...recordBody.preparation.mapping,sourceConditions:['beta','alpha']}}};
 assert.ok(await validateNativeMathMappingRecord({...swapped,receiptHash:await studyHash(swapped)},f.capture));
 const py=spawnSync(python,['-X','utf8','-c','import sys,json;sys.path.insert(0,"companion");from infrastructure.math_mapping_store import MathMappingStore\nr=json.load(sys.stdin)\ntry: MathMappingStore(None,None,None)._validate(r["capture"],r["preparation"]); print("accepted")\nexcept ValueError: print("rejected")'],{input:JSON.stringify({capture:f.capture,preparation:swapped.preparation}),encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(py.status,0,`${py.error?.code??''} ${py.error?.message??''}\n${py.stderr??''}`);assert.equal(py.stdout.trim(),'accepted','Native Python condition sets allow order-only differences');
 let calls=0;const client=createNativeMathClient({...options,fetcher:async()=>{calls++;throw Error('unexpected');}});
 for(const seed of [-1,4294967296,1.5])await assert.rejects(client.variant(f.capture,'parent',seed,record));assert.equal(calls,0);
});
test('shared native quote boundaries match actual Python preparation parser and browser validation',async()=>{
 const contract=JSON.parse(readFileSync(new URL('./fixtures/native-math-mapping-boundaries-v1.json',import.meta.url),'utf8'));
 for(const row of contract.cases){
  const f=await fixture(),quote='q'.repeat(row.quoteLength);f.item.practice.prompt='q'.repeat(row.promptLength??Math.min(contract.nativePromptMaximum,row.quoteLength));
  const {captureId,...captureBody}=f.capture;assert.ok(captureId);f.capture.captureId=await studyHash(captureBody);
  const preparation={...f.preparation,review:{sourceQuote:quote,rationale:'Explicit synthetic review matches the authored native source conditions.'}};
  const recordBody={schemaVersion:1,identity:f.identity,captureId:f.capture.captureId,preparation},record={...recordBody,receiptHash:await studyHash(recordBody)};
  const py=spawnSync(python,['-X','utf8','-c','import sys,json;sys.path.insert(0,"companion");from native_math_schema import parse_preparation\ntry: parse_preparation(json.load(sys.stdin)); print("accepted")\nexcept ValueError: print("rejected")'],{input:JSON.stringify(preparation),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(py.status,0,`${py.error?.code??''} ${py.error?.message??''}\n${py.stderr??''}`);assert.equal(py.stdout.trim(),row.accepted?'accepted':'rejected',row.name);
  if(row.accepted)assert.ok(await validateNativeMathMappingRecord(record,f.capture));else await assert.rejects(validateNativeMathMappingRecord(record,f.capture));
 }
});
