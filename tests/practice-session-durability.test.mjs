import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxHandler} from './fixtures/tsx-handlers.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {prepareAttemptEvidence} from '../src/domain/assessment/index.ts';
import {attemptFailureMessage} from '../src/features/study-attempt/index.ts';
import {completesSubjectItemAfterAttempt} from '../src/domain/planning/index.ts';
import {isNonWordOriginal} from '../src/domain/content/index.ts';
const file=new URL('../app/practice-session.tsx',import.meta.url);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(){const pending=deferred(),drafts=createLearningDraftStore(),draftAdapter=drafts.adapter('synthetic-question','quiz:0');draftAdapter.write('choice','A');draftAdapter.assistance.cover();
  let saved=0,advanced=0,changed=0,warning='',retry=0,observed;
  const env={prepareAttemptEvidence,attemptFailureMessage,completesSubjectItemAfterAttempt,isNonWordOriginal,nonWordScopeFor:undefined,activeItem:{itemId:'one',questionType:'quiz'},drafts,draftAdapter,practiceAlive:{current:true},ended:{current:false},sessionEpoch:{current:0},summary:{answered:0,correct:0,wrong:0},attempts:0,
    setSummary:()=>changed++,onRecordAttempt:async value=>{saved++;observed=value;await pending.promise;},advance:()=>advanced++,advanceRef:{current:()=>advanced++},setPhase(){},setSaveError:value=>warning=value,setSaveRetry:fn=>retry=fn(retry)};
  return{env,pending,drafts,draftAdapter,grade:tsxHandler(file,'handleGrade',env),state:()=>({saved,advanced,changed,warning,retry,observed})};
}
test('inline practice waits for local durability before advancing or including an attempt in settlement',async()=>{
  const f=fixture();const saving=f.grade('good');assert.equal(f.state().advanced,0);assert.equal(f.state().changed,0);f.pending.resolve();await saving;
  assert.equal(f.state().advanced,1);assert.equal(f.state().changed,1);assert.equal(f.state().saved,1);assert.equal(f.drafts.isPending(),false);
});
test('inline practice rejects duplicate clicks and freezes only the current attempt assistance',async()=>{
  const f=fixture();f.draftAdapter.assistance.shown('ai-hint','one');const saving=f.grade('again');await f.grade('again');f.draftAdapter.assistance.shown('ai-tutor','too-late');
  assert.equal(f.state().saved,1);assert.deepEqual(f.state().observed.assistance.preSubmitAssistance,[{action:'ai-hint',count:1}]);f.pending.resolve();await saving;
});
test('inline save failure keeps answer buffers and never creates settlement progress',async()=>{
  const f=fixture(),saving=f.grade('good');f.pending.reject(new Error('storage unavailable'));await saving;
  assert.equal(f.state().advanced,0);assert.equal(f.state().changed,0);assert.equal(f.draftAdapter.read('choice',''),'A');assert.ok(f.state().warning);assert.equal(f.state().retry,1);
});
test('a late inline save cannot advance a disposed page',async()=>{
  const f=fixture(),saving=f.grade('good');f.env.practiceAlive.current=false;f.pending.resolve();await saving;assert.equal(f.state().advanced,0);assert.equal(f.state().changed,0);
});

test('managed non-word save failure retains its mounted driver and retries the same logical submission',async()=>{
  const f=fixture();f.env.nonWordScopeFor=()=>({itemKey:'one'});
  const failed=tsxHandler(file,'handleGrade',f.env)('good');f.pending.reject(Error('storage unavailable'));const failedOutcome=await failed;
  assert.equal(f.state().retry,0);assert.equal(f.state().advanced,0);assert.equal(f.state().changed,0);assert.equal(f.draftAdapter.read('choice',''),'A');
  let resumed=0;f.env.onRecordAttempt=async()=>{resumed++;};const retriedOutcome=await tsxHandler(file,'handleGrade',f.env)('good');
  assert.deepEqual(retriedOutcome.identity,failedOutcome.identity);
  assert.equal(resumed,1);assert.equal(f.state().advanced,1);assert.equal(f.state().changed,1);
});

for(const rating of ['good','again'])test(`inline calculation ${rating} keeps feedback after saving and only advances on continue`,async()=>{
 const f=fixture();f.env.activeItem.questionType='calculation';
 const saving=f.grade(rating,{deferAdvance:true});assert.equal(f.state().advanced,0);
 f.pending.resolve();await saving;assert.equal(f.state().saved,1);assert.equal(f.state().changed,1);assert.equal(f.state().advanced,0);
 assert.equal(f.draftAdapter.hasSavedFeedback(),true);f.draftAdapter.continueAfterFeedback();f.draftAdapter.continueAfterFeedback();
 assert.equal(f.state().advanced,1);assert.equal(f.state().saved,1);
});
test('a stale inline calculation skip cannot finish the same question twice',()=>{
 const f=fixture();f.env.activeItem.questionType='calculation';
 let advances=0;f.drafts.commit(f.draftAdapter.begin(),()=>advances++);
 const skip=tsxHandler(file,'handleSkip',{...f.env,advance:()=>advances++});skip();skip();assert.equal(advances,1);
});

test('deferred inline continue uses the latest remaining question order',async()=>{
 const f=fixture();f.env.activeItem.questionType='calculation';const saving=f.grade('good',{deferAdvance:true});
 f.pending.resolve();await saving;let nextOrder=0;f.env.advanceRef.current=()=>nextOrder++;
 f.draftAdapter.continueAfterFeedback();assert.equal(nextOrder,1);assert.equal(f.state().advanced,0);assert.equal(f.state().saved,1);
});
