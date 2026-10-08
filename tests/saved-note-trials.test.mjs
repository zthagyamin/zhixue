import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {saveTrialMaterial,loadTrialMaterials,removeTrialMaterial} from '../app/saved-note-trials.ts';
const questions=[{id:'trial-1',prompt:'What?',answer:'Source answer',filename:'notes.md',section:'Section',kind:'qa'}];
test('explicit material save survives readback, deduplicates and isolates both owner and library',async()=>{
 const entry=await saveTrialMaterial('test-owner','lib-a','数学','导数',questions);
 assert.equal((await loadTrialMaterials('test-owner','lib-a'))[0].id,entry.id);
 await saveTrialMaterial('test-owner','lib-a','数学','导数',questions);
 assert.equal((await loadTrialMaterials('test-owner','lib-a')).length,1);
 assert.deepEqual(await loadTrialMaterials('test-owner','lib-b'),[]);
 assert.deepEqual(await loadTrialMaterials('other-owner','lib-a'),[]);
 assert.deepEqual(Object.keys(entry).sort(),['id','questions','subject','title']);
 assert.deepEqual(entry.questions,questions);
 await removeTrialMaterial('test-owner','lib-a',entry.id);
 assert.deepEqual(await loadTrialMaterials('test-owner','lib-a'),[]);
});
test('material saves validate content and never smuggle trial answers or grades into stored data',async()=>{
 await assert.rejects(saveTrialMaterial('test-owner','lib-a','','Title',questions));
 await assert.rejects(saveTrialMaterial('test-owner','lib-a','数学','Title',[]));
 const value=await saveTrialMaterial('test-owner','lib-c','数学','Title',questions.map(q=>({...q,rating:'good',learnerAnswer:'private input'})));
 assert.deepEqual(value.questions,questions);
});
test('unavailable IndexedDB is a visible failure, never a false saved receipt',async()=>{
 const database=globalThis.indexedDB;try{globalThis.indexedDB=undefined;
 await assert.rejects(saveTrialMaterial('test-owner','lib-a','数学','Title',questions),/无法保存/);
 await assert.rejects(loadTrialMaterials('test-owner','lib-a'),/无法保存/);
 }finally{globalThis.indexedDB=database;}
});
