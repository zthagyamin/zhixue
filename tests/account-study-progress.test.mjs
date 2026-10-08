import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {loadWorkspaceRecord,saveWorkspaceRecord} from '../app/local-study-db.ts';
import {scheduleReviewAt} from '../app/fsrs-scheduler.ts';
let api;try{api=await import('../app/account-study-progress.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const progress={itemStages:{word:2},fsrsData:{},answered:2,correct:2};
const view=(libraryId='a')=>({schemaVersion:1,workspaceId:'account:user',libraryId,progress:structuredClone(progress),evidenceHash:'a'.repeat(64),historyReady:true});
test('real scheduled decimal review state survives the account progress cache unchanged',async()=>{
  globalThis.indexedDB=new IDBFactory();const value=view(),state=scheduleReviewAt(undefined,'again','2026-09-01T00:00:00.000Z');assert.equal(Number.isInteger(state.stability),false);
  value.progress.fsrsData.word=state;await api.saveAccountProgress(value);assert.deepEqual((await api.loadAccountProgress(value.workspaceId,value.libraryId)).progress.fsrsData.word,state);
});
test('account view persistence is scoped by library and does not replace legacy local progress',async()=>{
  globalThis.indexedDB=new IDBFactory();assert.equal(typeof api?.saveAccountProgress,'function');await saveWorkspaceRecord('account:user','progress',{legacy:'preserve'});
  await api.saveAccountProgress(view());assert.deepEqual((await api.loadAccountProgress('account:user','a')).progress,progress);assert.equal(await api.loadAccountProgress('account:user','b'),null);
  assert.deepEqual(await loadWorkspaceRecord('account:user','progress',null),{legacy:'preserve'});
});
test('a projection update never carries stages from another account or library',()=>{
  assert.equal(typeof api?.projectAccountProgress,'function');const incoming={workspaceId:'account:user',libraryId:'b',progress:{itemStages:{other:1},fsrsData:{},answered:0,correct:0},evidenceHash:'b'.repeat(64),historyReady:true};
  const result=api.projectAccountProgress(view(),null,incoming,new Set());assert.equal(result.progress.itemStages.word,undefined);assert.equal(result.progress.itemStages.other,1);
});
test('unchanged evidence preserves an explicit same-library retry, changed evidence respects pending keys',()=>{
  const current=view();current.progress.itemStages.word=0;
  const incoming={workspaceId:current.workspaceId,libraryId:current.libraryId,progress:{...progress,itemStages:{word:3}},evidenceHash:current.evidenceHash,historyReady:true};
  assert.equal(api.projectAccountProgress(current,null,incoming,new Set()).progress.itemStages.word,0);
  incoming.evidenceHash='b'.repeat(64);assert.equal(api.projectAccountProgress(current,null,incoming,new Set(['word'])).progress.itemStages.word,0);
  assert.equal(api.projectAccountProgress(current,null,incoming,new Set()).progress.itemStages.word,3);
});
test('missing or failed history retains a known same-scope view without claiming full verification',()=>{
  const current=view(),result=api.projectAccountProgress(current,null,{workspaceId:current.workspaceId,libraryId:current.libraryId,progress:null,evidenceHash:null,historyReady:false},new Set());
  assert.equal(result.historyReady,false);assert.equal(result.progress.itemStages.word,2);
});
