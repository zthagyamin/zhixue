import test from 'node:test';
import assert from 'node:assert/strict';
import {paperReadingUnit,applyPaperReadingMutation} from '../src/domain/paper-reading/workspace.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
const source={ownerId:'account:u',libraryId:'library:l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'methods',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.',pageNumber:3}]};
const unit=()=>paperReadingUnit({schemaVersion:1,unitId:'unit1',title:'A paper',goal:'Explain the activation mechanism',source});
const request=(kind,extra={},revision=0)=>({schemaVersion:1,operationId:kind+revision,unitId:'unit1',expectedRevision:revision,kind,...extra});
const registered=()=>applyPaperReadingMutation(null,request('register',{unit:unit()})).workspace;
const prepared=()=>applyPaperReadingMutation(registered(),request('task',{task:paperReadingTask({taskId:'task1',revision:1,source,origin:'prepared',goal:unit().goal,ability:'mechanism',question:'Why can ReLU train faster on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}]})},1),'service').workspace;
test('unit registration is immutable, isolated and replayable after lost receipt',()=>{
 const first=registered();assert.equal(first.revision,1);assert.equal(first.task,null);
 const repeat=applyPaperReadingMutation(first,request('register',{unit:unit()}));assert.equal(repeat.status,'duplicate');
 assert.equal(applyPaperReadingMutation(first,request('register',{unit:{...unit(),title:'changed'}})).status,'conflict');
 assert.throws(()=>paperReadingUnit({...unit(),source:{...source,ownerId:''}}),/binding|invalid/);
});
test('public mutations cannot inject AI tasks, feedback or formal grades',()=>{
 assert.throws(()=>applyPaperReadingMutation(registered(),request('task',{task:prepared().task},1)),/service/);
 assert.throws(()=>applyPaperReadingMutation(registered(),{...request('pause',{paused:true},1),rating:'good'}),/fields|invalid/);
});
test('draft, first submission and inline retry remain separate and durable replay is idempotent',()=>{
 let state=prepared();state=applyPaperReadingMutation(state,request('draft',{answer:'I forgot',referenceSeen:false},2)).workspace;
 const submission=request('submit',{answer:'I forgot',submittedAt:'2026-10-08T08:00:00Z',referenceSeen:false},3);
 const first=applyPaperReadingMutation(state,submission).workspace;
 assert.equal(applyPaperReadingMutation(first,submission).status,'duplicate');
 assert.equal(first.attempts[0].submission.answer,'I forgot');assert.equal(first.attempts[0].evaluation.status,'pending');
 const retry=applyPaperReadingMutation(first,request('retry',{attemptId:'retry1',purpose:'remediation'},4)).workspace;
 assert.equal(retry.attempts.length,2);assert.equal(retry.attempts[1].parentAttemptId,retry.attempts[0].attemptId);
 assert.equal(retry.answer,'');assert.equal(retry.attempts[0].submission.answer,'I forgot');
 assert.equal('rating' in retry,false);assert.equal('formal' in retry,false);
});
test('old revision and mismatched service task cannot replace current work',()=>{
 const state=prepared();assert.equal(applyPaperReadingMutation(state,request('draft',{answer:'late',referenceSeen:false},1)).status,'conflict');
 const altered={...state.task,source:{...source,sourceVersion:'c'.repeat(64)}};
 assert.throws(()=>applyPaperReadingMutation(registered(),request('task',{task:altered},1),'service'),/binding/);
});
test('pause and effective duration preserve draft while unknown feedback remains pending',()=>{
 let state=prepared();state=applyPaperReadingMutation(state,request('draft',{answer:'my answer',referenceSeen:false},2)).workspace;
 state=applyPaperReadingMutation(state,request('pause',{paused:true,activeSeconds:45},3)).workspace;
 assert.equal(state.answer,'my answer');assert.equal(state.paused,true);assert.equal(state.activeSeconds,45);
 assert.throws(()=>applyPaperReadingMutation(state,request('pause',{paused:false,activeSeconds:2},4)),/duration/);
});
test('source version and material fingerprints require digest strings without coercion',()=>{
 for(const field of ['sourceVersion','materialFingerprint']){
  assert.throws(()=>paperReadingUnit({...unit(),source:{...source,[field]:[source[field]]}}),/binding|invalid/);
 }
});
