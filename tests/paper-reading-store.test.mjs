import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {openStudyDb} from '../app/local-study-db.ts';
const scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'A paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Source evidence.',pageNumber:1}]}};
const register={schemaVersion:1,operationId:'register',unitId:'unit',expectedRevision:0,kind:'register',unit};
test('reading persistence acknowledges actual IndexedDB commit and scopes every read',async()=>{
 globalThis.indexedDB=new IDBFactory();const store=createPaperReadingStore();
 const receipt=await store.mutate(scope,register);assert.equal(receipt.durable,true);
 assert.equal((await createPaperReadingStore().read(scope,'unit')).unit.title,'A paper');
 assert.equal(await store.read({...scope,ownerId:'another'},'unit'),null);
 assert.equal(await store.read({...scope,libraryId:'another'},'unit'),null);
 assert.equal((await store.mutate(scope,register)).status,'duplicate');
});
test('two repositories competing for a revision cannot both advance the same workspace',async()=>{
 globalThis.indexedDB=new IDBFactory();const a=createPaperReadingStore(),b=createPaperReadingStore();await a.mutate(scope,register);
 const base={schemaVersion:1,unitId:'unit',expectedRevision:1,kind:'pause',paused:true};
 const receipts=await Promise.all([a.mutate(scope,{...base,operationId:'one',activeSeconds:10}),b.mutate(scope,{...base,operationId:'two',activeSeconds:20})]);
 assert.deepEqual(receipts.map(r=>r.status).sort(),['accepted','conflict']);assert.equal(receipts.filter(r=>r.durable).length,1);
});
test('corrupt or mismatched records do not restore as empty drafts',async()=>{
 globalThis.indexedDB=new IDBFactory();const store=createPaperReadingStore();await store.mutate(scope,register);
 const db=await openStudyDb();const tx=db.transaction('workspace-records','readwrite'),all=tx.objectStore('workspace-records').getAll();
 all.onsuccess=()=>{const row=all.result[0];row.value.answer='forged';tx.objectStore('workspace-records').put(row);};
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 await assert.rejects(store.read(scope,'unit'),/corrupt/);
});
test('missing persistence and foreign source binding never return a successful receipt',async()=>{
 globalThis.indexedDB=undefined;await assert.rejects(createPaperReadingStore().mutate(scope,register),/保存|unavailable/);
 globalThis.indexedDB=new IDBFactory();await assert.rejects(createPaperReadingStore().mutate({...scope,ownerId:'other'},register),/scope/);
});
test('cloud hydration only extends the same journal and never replaces an offline first answer',async()=>{
 globalThis.indexedDB=new IDBFactory();const local=createPaperReadingStore();await local.mutate(scope,register);
 const paused=await local.mutate(scope,{schemaVersion:1,operationId:'pause',unitId:'unit',expectedRevision:1,kind:'pause',paused:true,activeSeconds:10});
 const incoming=structuredClone(paused.workspace);await local.hydrate(scope,incoming);
 const conflict=structuredClone(incoming);conflict.operations[1].operationId='other';
 await assert.rejects(local.hydrate(scope,conflict),/conflict|corrupt/);
 assert.equal((await local.read(scope,'unit')).operations[1].operationId,'pause');
});
