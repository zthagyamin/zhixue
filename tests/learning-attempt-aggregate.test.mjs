import assert from 'node:assert/strict';
import test from 'node:test';
import {parseLearningAttempt, applyAttemptMutation, parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
const binding={ownerId:'owner',libraryId:'library',snapshotId:'snapshot',itemKey:'item',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
const at='2026-10-10T00:00:00Z';
function advance(current,body){
  const mutation=parseAttemptMutation({schemaVersion:1,attemptId:current?.attemptId??'attempt',binding,operationId:`operation-${(current?.revision??0)+1}`,expectedRevision:current?.revision??0,updatedAt:at,...body});
  return applyAttemptMutation(current,mutation,'c'.repeat(64)).attempt;
}
function draft(){return advance(null,{kind:'checkpoint',parentAttemptId:null,answer:'original answer',checkpoint:{phase:'answering',position:0,traversed:false,mode:'recall',purpose:'first'}});}
function submitted(){const row=draft();return advance(row,{kind:'submit',answerRevision:row.answerRevision,assistance:'independent'});}
function resolved(){const row=submitted();return advance(row,{kind:'evaluate',answerRevision:row.answerRevision,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'Checked.',evaluationHash:'b'.repeat(64),referenceHash:binding.contentHash}});}
function claimed(){return advance(resolved(),{kind:'claim-formal',eventId:'event',occurredAt:at,evaluationHash:'b'.repeat(64),rating:'good'});}
function changed(row,change){const copy=structuredClone(row);change(copy);return copy;}

test('aggregate parsing preserves draft, submitted pending, resolved and formal pointers without claiming authority',()=>{
  const linked=advance(claimed(),{kind:'link-formal',eventId:'event',coreHash:'d'.repeat(64)});
  linked.formal.authoritativeRecord={attemptId:'official-attempt',roundId:'official-round'};
  for(const row of [draft(),submitted(),resolved(),claimed(),linked]){
    const parsed=parseLearningAttempt(row);assert.deepEqual(parsed,row);assert.notEqual(parsed,row);
    parsed.binding.ownerId='changed';assert.equal(row.binding.ownerId,'owner');
  }
});
test('legacy missing startedAt is preserved and identities are not rewritten',()=>{
  const row=submitted();delete row.startedAt;row.attemptId='nw:original';row.binding.ownerId='account:owner';
  const parsed=parseLearningAttempt(row);assert.deepEqual(parsed,row);assert.equal(Object.hasOwn(parsed,'startedAt'),false);
});
test('round, continuation and reopen metadata remain legal lesson/guided aggregates',()=>{
  for(const prefix of ['nw-round:','nw-continue:','nw-reopen:']){
    const row=advance(null,{attemptId:prefix+'original',kind:'checkpoint',parentAttemptId:null,answer:'',checkpoint:{phase:'lesson',position:0,traversed:false,mode:'lesson',purpose:'guided',intent:'lesson',pluginFields:{notes:'{"schemaVersion":1,"runId":"original"}'},view:{purpose:'guided',lessonStep:'reading',paused:true,referenceSeen:false,instanceId:'original-instance'},visited:['item'],pending:['other'],skipped:[]}});
    assert.deepEqual(parseLearningAttempt(row),row);
  }
});
test('aggregate requires closed records, supported version, bounded text and valid timestamps',()=>{
  const checks=[row=>{row.extra=true;},row=>{delete row.binding;},row=>{row.schemaVersion=2;},row=>{row.updatedAt='bad';},row=>{row.startedAt='bad';},row=>{row.answer='a'.repeat(32001);},row=>{row.revision=-1;},row=>{row.checkpoint.pluginFields={rawSource:'unallowed'};},row=>{row.binding.extra=true;}];
  for(const check of checks)assert.throws(()=>parseLearningAttempt(changed(draft(),check)));
  assert.throws(()=>parseLearningAttempt(null));assert.throws(()=>parseLearningAttempt([]));
});
test('operation receipts must be bounded, unique and contiguous with the aggregate revision',()=>{
  const checks=[row=>{row.operations[0].fingerprint='bad';},row=>{row.operations[0].extra=true;},row=>{row.operations[1].operationId=row.operations[0].operationId;},row=>{row.operations[1].revision=1;},row=>{row.revision++;},row=>{row.operations.reverse();},row=>{row.operations=[];}];
  for(const check of checks)assert.throws(()=>parseLearningAttempt(changed(submitted(),check)));
  const row=draft();row.revision=2001;row.operations=Array.from({length:2001},(_,i)=>({operationId:`op-${i}`,fingerprint:'a'.repeat(64),revision:i+1}));
  assert.throws(()=>parseLearningAttempt(row));
});
test('the maximum stored operation history is accepted without changing receipt identities',()=>{
  const row=draft();row.revision=2000;row.operations=Array.from({length:2000},(_,i)=>({operationId:`original-operation-${i}`,fingerprint:'a'.repeat(64),revision:i+1}));
  assert.deepEqual(parseLearningAttempt(row),row);
});
test('submission must retain its immutable answer, revision and assistance evidence',()=>{
  const checks=[row=>{row.submitted.answer='replacement';},row=>{row.submitted.answerRevision++;},row=>{row.answerRevision=row.revision+1;},row=>{row.submitted.extra=true;},row=>{row.submitted.submittedAt='bad';},row=>{row.submitted.assistance='invented';},row=>{row.submitted.maxPreHintLevel=1;},row=>{row.submitted.answerRevealed=true;}];
  for(const check of checks)assert.throws(()=>parseLearningAttempt(changed(submitted(),check)));
});
test('resolved evaluation must bind an actual submission and the same reference hash',()=>{
  for(const change of [row=>{row.submitted=null;},row=>{row.evaluation.referenceHash='e'.repeat(64);},row=>{row.evaluation.correct=false;},row=>{row.evaluation.extra=true;}])assert.throws(()=>parseLearningAttempt(changed(resolved(),change)));
});
test('formal pointers must be internally consistent and cannot turn auxiliary or pending work into a grade',()=>{
  const checks=[row=>{row.formal.evaluationHash='e'.repeat(64);},row=>{row.formal.coreHash='d'.repeat(64);},row=>{row.formal.authoritativeRecord={attemptId:'x',roundId:'y'};},row=>{row.formal.status='linked';},row=>{row.formal.status='unknown';},row=>{row.formal.rating='easy';},row=>{row.evaluation={status:'pending',reason:'offline'};},row=>{row.parentAttemptId='parent';},row=>{row.checkpoint.purpose='guided';},row=>{row.formal.extra=true;}];
  for(const change of checks)assert.throws(()=>parseLearningAttempt(changed(claimed(),change)));
});
test('parent self cycles are rejected while independent remediation identities remain unchanged',()=>{
  assert.throws(()=>parseLearningAttempt(changed(draft(),row=>{row.parentAttemptId=row.attemptId;})));
  const row=changed(draft(),row=>{row.parentAttemptId='first-attempt';row.checkpoint.purpose='remediation';});assert.deepEqual(parseLearningAttempt(row),row);
});
