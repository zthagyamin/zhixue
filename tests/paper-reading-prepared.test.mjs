import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {createPaperReadingService} from '../src/application/paper-reading/service.ts';
import {openStudyDb} from '../app/local-study-db.ts';
import {preparedPaperTask} from '../src/domain/paper-reading/index.ts';
import {createPreparedPaperTaskService} from '../src/application/paper-reading/prepared.ts';
import {createPreparedPaperTaskIndexedDbStore} from '../src/infrastructure/paper-reading/prepared-store.ts';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {loadPreparedPaperTask,savePreparedPaperTask,exportPreparedPaperTaskTemplate}=loadTsx(new URL('../app/paper-reading/prepared.tsx',import.meta.url));
const scope={ownerId:'u',libraryId:'l'};
const unit={schemaVersion:1,unitId:'base',title:'Paper',goal:'Explain the mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Attention mixes values using learned weights.'}]}};
function packet(question='How does attention mix values?'){
 return {...JSON.parse(exportPreparedPaperTaskTemplate(unit)),question,ability:'mechanism',reference:[{point:'Uses learned weights.',paragraphId:'p',quote:'using learned weights'}]};
}
test('prepared sidecar restores across repositories with stable identity and no AI preparation',async()=>{
 globalThis.indexedDB=new IDBFactory();
 const first=await savePreparedPaperTask(scope,unit,packet());
 const loaded=await loadPreparedPaperTask(scope,unit);assert.deepEqual(loaded,first);assert.match(first.recipeHash,/^[a-f0-9]{64}$/);
 assert.equal(first.task.taskId,'prepared:'+first.recipeHash);assert.equal(first.task.origin,'prepared');
 const service=createPaperReadingService({scope,store:createPaperReadingStore(),ai:{prepare(){throw Error('unexpected AI');}}});
 await service.open(unit);const ready=await service.begin(unit.unitId,'begin',new AbortController().signal,loaded.task);
 assert.equal(ready.task.question,packet().question);assert.equal(ready.attempts[0].submission,null);
});
test('files carry no account identity and cannot cross source version, fingerprint, section or paragraph selection',async()=>{
 globalThis.indexedDB=new IDBFactory();
 for(const patch of [{ownerId:'forged'},{sourceVersion:'c'.repeat(64)},{materialFingerprint:'c'.repeat(64)},{sectionId:'other'},{paragraphIds:['other']},{formal:true},{goal:'forged'}]){
  await assert.rejects(savePreparedPaperTask(scope,unit,{...packet(),...patch}),/prepared/);
 }
 await assert.rejects(savePreparedPaperTask({...scope,ownerId:'another'},unit,packet()),/scope/);
 await savePreparedPaperTask(scope,unit,packet());
 const other={...unit,source:{...unit.source,ownerId:'another'}};
 assert.equal(await loadPreparedPaperTask({ownerId:'another',libraryId:'l'},other),null);
 assert.equal(await loadPreparedPaperTask(scope,{...unit,source:{...unit.source,sourceVersion:'c'.repeat(64)}}),null);
});
test('wide questions, foreign references, unknown fields and missing ability are rejected before persistence',async()=>{
 globalThis.indexedDB=new IDBFactory();
 for(const bad of [{...packet(),question:'总结全文'},{...packet(),reference:[{point:'x',paragraphId:'p',quote:'fabricated'}]},
  {...packet(),reference:[{...packet().reference[0],extra:true}]},{...packet(),ability:'unknown'},{...packet(),reference:[]}]){
  await assert.rejects(savePreparedPaperTask(scope,unit,bad),/prepared/);
 }
 assert.equal(await loadPreparedPaperTask(scope,unit),null);
});
test('editing a recipe creates a new identity, preserves prior task and answer, and retains all sidecar history',async()=>{
 globalThis.indexedDB=new IDBFactory();const first=await savePreparedPaperTask(scope,unit,packet());
 const service=createPaperReadingService({scope,store:createPaperReadingStore()});await service.open(unit);
 await service.begin('base','begin',new AbortController().signal,first.task);
 await service.mutate({schemaVersion:1,operationId:'answer',unitId:'base',expectedRevision:2,kind:'submit',answer:'Original answer',referenceSeen:false,submittedAt:'2026-10-08T09:00:00Z'});
 const revised=await savePreparedPaperTask(scope,unit,packet('Which weights combine the values?'));
 assert.notEqual(revised.recipeHash,first.recipeHash);assert.notEqual(revised.task.taskId,first.task.taskId);
 const old=await service.read('base');assert.equal(old.task.taskId,first.task.taskId);assert.equal(old.attempts[0].submission.answer,'Original answer');
 const db=await openStudyDb();const tx=db.transaction('workspace-records','readonly'),request=tx.objectStore('workspace-records').getAll();
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 const row=request.result.find(r=>r.workspaceId==='paper-reading-prepared:v1');assert.equal(row.value.recipes.length,2);
 assert.equal(row.value.activeRecipeHash,revised.recipeHash);
});
test('different concurrent edits conflict rather than losing a prepared recipe',async()=>{
 globalThis.indexedDB=new IDBFactory();await savePreparedPaperTask(scope,unit,packet());
 const outcomes=await Promise.allSettled([savePreparedPaperTask(scope,unit,packet('Which weights are used?')),savePreparedPaperTask(scope,unit,packet('How are values combined?'))]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/conflict/);
 assert.ok(await loadPreparedPaperTask(scope,unit));
});
test('identical concurrent imports reuse the same durable recipe instead of conflicting',async()=>{
 globalThis.indexedDB=new IDBFactory();
 const [first,second]=await Promise.all([savePreparedPaperTask(scope,unit,packet()),savePreparedPaperTask(scope,unit,packet())]);
 assert.deepEqual(first,second);assert.deepEqual(await loadPreparedPaperTask(scope,unit),first);
});
test('failed persistence never returns success; damaged envelopes, binding, history and hashes cannot load or be overwritten',async()=>{
 globalThis.indexedDB=undefined;await assert.rejects(savePreparedPaperTask(scope,unit,packet()),/保存|unavailable/);
 for(const damage of [row=>{row.kind='foreign';},row=>{row.value.baseUnit.source.ownerId='foreign';},row=>{row.value.recipes[0].packet.question='tampered';},row=>{row.value.activeRecipeHash='c'.repeat(64);}]){
  globalThis.indexedDB=new IDBFactory();await savePreparedPaperTask(scope,unit,packet());
  const db=await openStudyDb();const tx=db.transaction('workspace-records','readwrite'),store=tx.objectStore('workspace-records'),get=store.getAll();
  get.onsuccess=()=>{const row=get.result[0];damage(row);store.put(row);};
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  await assert.rejects(loadPreparedPaperTask(scope,unit),/prepared/);await assert.rejects(savePreparedPaperTask(scope,unit,packet()),/prepared/);
 }
});
test('template contains only portable content and UI keeps import outside the default question flow',()=>{
 const template=JSON.parse(exportPreparedPaperTaskTemplate(unit));
 assert.deepEqual(template.paragraphIds,['p']);assert.equal(template.sourceVersion,unit.source.sourceVersion);
 assert.equal(template.materialFingerprint,unit.source.materialFingerprint);assert.equal(template.sectionId,'s');
 assert.equal(template.question,'');assert.equal(template.reference[0].paragraphId,'p');
 for(const key of ['ownerId','libraryId','title','goal','formal','rating','schedule'])assert.equal(Object.hasOwn(template,key),false);
 const {PreparedQuestionTools}=loadTsx(new URL('../app/paper-reading/prepared.tsx',import.meta.url));
 const markup=renderToStaticMarkup(createElement(PreparedQuestionTools,{unit,scope,beforeChange:async()=>{},onChange(){}}));
 assert.match(markup,/<details>/);assert.match(markup,/下载预备题模板/);assert.match(markup,/导入预备题/);
 assert.doesNotMatch(markup,/已同步|云端已保存|Uses learned weights/);
});
test('public task factory rejects coercible array hashes rather than accepting array identities',()=>{
 assert.throws(()=>preparedPaperTask(unit,packet(),['a'.repeat(64)]),/paper-prepared-hash/);
 assert.throws(()=>preparedPaperTask(unit,packet(),{toString(){return 'a'.repeat(64);}}),/paper-prepared-hash/);
});
test('duplicate import is stable and question or reference edits change identities without erasing recipes',async()=>{
 globalThis.indexedDB=new IDBFactory();const first=await savePreparedPaperTask(scope,unit,packet());
 const reordered=Object.fromEntries(Object.entries(packet()).reverse());
 assert.deepEqual(await savePreparedPaperTask(scope,unit,reordered),first);
 const edited=packet();edited.reference[0].point='Combine weighted values.';
 const second=await savePreparedPaperTask(scope,unit,edited,{expectedRecipeHash:first.recipeHash});
 assert.notEqual(second.recipeHash,first.recipeHash);
 await assert.rejects(savePreparedPaperTask(scope,unit,packet('Why does it work?'),{expectedRecipeHash:first.recipeHash}),/conflict/);
 const restored=await savePreparedPaperTask(scope,unit,packet(),{expectedRecipeHash:second.recipeHash});
 assert.deepEqual(restored,first);
});
test('a real IndexedDB write transaction abort cannot report success or replace the prior active recipe',async()=>{
 globalThis.indexedDB=new IDBFactory();const first=await savePreparedPaperTask(scope,unit,packet());
 const interrupted=createPreparedPaperTaskService(createPreparedPaperTaskIndexedDbStore(async()=>{
  const db=await openStudyDb(),transaction=db.transaction.bind(db);
  db.transaction=(...args)=>{
   const tx=transaction(...args);
   if(args[1]==='readwrite'){
    const objectStore=tx.objectStore.bind(tx);
    tx.objectStore=(name)=>{
     const store=objectStore(name),put=store.put.bind(store);
     store.put=(row)=>{const request=put(row);queueMicrotask(()=>tx.abort());return request;};
     return store;
    };
   }
   return tx;
  };
  return db;
 }),async text=>createHash('sha256').update(text).digest('hex'));
 await assert.rejects(interrupted.save(scope,unit,packet('What determines the weights?')),/Abort|prepared/);
 assert.deepEqual(await loadPreparedPaperTask(scope,unit),first);
});
