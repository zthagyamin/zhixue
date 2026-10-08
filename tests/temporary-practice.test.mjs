import assert from 'node:assert/strict';
import test from 'node:test';
import {createTemporaryDraft,createTemporaryRun} from '../src/application/temporary-practice/index.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

test('temporary inputs are isolated from a saved frozen answer and participate in host leave protection',()=>{
 const store=createLearningDraftStore('owner/library'),parent=store.adapter('item','recall');
 parent.read('answer','');parent.write('answer','first answer');let continues=0;
 assert.equal(store.commit(parent.begin(),()=>continues++),true);
 const draft=parent.createTemporary({answer:''});assert.ok(draft);
 assert.equal(draft.write('answer','assisted answer'),true);assert.equal(store.hasUnsavedInput(),true);
 assert.equal(parent.write('answer','overwrite'),false);assert.equal(parent.read('answer',''),'first answer');
 draft.acknowledge();assert.equal(store.hasUnsavedInput(),false);draft.dispose();
 assert.equal(parent.hasSavedFeedback(),true);assert.equal(continues,0);assert.equal(parent.continueAfterFeedback(),true);assert.equal(continues,1);
});
test('changing parent generation revokes temporary writes without clearing another item',()=>{
 const store=createLearningDraftStore(),a=store.adapter('a','code'),b=store.adapter('b','recall');b.read('answer','');b.write('answer','keep');
 const draft=a.createTemporary({code:'pass',stdin:''});draft.write('code','print(1)');store.clearItem('a');
 assert.equal(draft.isActive(),false);assert.equal(draft.write('code','late'),false);assert.equal(b.read('answer',''),'keep');
});
test('temporary operations reject repeat clicks and ignore cancelled or changed-scope results',async()=>{
 let active=true,calls=0,cancelled=0;const wait=deferred(),draft=createTemporaryDraft({initial:{code:'pass'},isCurrent:()=>active});
 const run=createTemporaryRun(draft,{run:async()=>{calls++;return wait.promise;},cancel:()=>cancelled++});
 const first=run.start();assert.equal(draft.hasUnsavedInput(),true);await run.start();assert.equal(calls,1);
 active=false;wait.resolve({kind:'checked',message:'stale'});await first;assert.equal(run.snapshot().result,null);
 run.dispose();assert.equal(cancelled,0,'an already finished runtime is not terminated by closing feedback');
});
test('acknowledging a temporary answer never calls or acquires a formal grading path',()=>{
 const draft=createTemporaryDraft({initial:{answer:''}});assert.equal('begin' in draft,false);assert.equal('onGrade' in draft,false);
 draft.write('answer','my explanation');draft.acknowledge();assert.equal(draft.hasUnsavedInput(),false);
 draft.write('answer','changed after checking');assert.equal(draft.hasUnsavedInput(),true);
 assert.equal(draft.write('unknown','value'),false);draft.dispose();assert.equal(draft.write('answer','late'),false);
});
