import test from 'node:test';
import assert from 'node:assert/strict';
import {paperReadingTask,createPaperReadingAttempt,submitPaperReadingAnswer,applyPaperReadingFeedback} from '../src/domain/paper-reading/evidence.ts';
const source={ownerId:'u',libraryId:'l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'methods',paragraphs:[{id:'p1',rawEn:'ReLU avoids saturation for positive inputs.',pageNumber:3}]};
const taskInput={taskId:'task1',revision:1,source,origin:'prepared',goal:'Explain the mechanism',ability:'mechanism',question:'Why can ReLU improve learning on positive inputs?',reference:[{point:'Positive inputs avoid saturation.',paragraphId:'p1',quote:'avoids saturation for positive inputs'}]};
const ready=()=>paperReadingTask(taskInput);
const attempt=()=>createPaperReadingAttempt(ready(),{attemptId:'a1',purpose:'first',parentAttemptId:null});
test('task snapshots bind source and exact evidence without changing material',()=>{
 const snapshot=JSON.stringify(taskInput);const task=ready();assert.equal(task.status,'ready');
 taskInput.source.paragraphs[0].rawEn+=' ';assert.equal(task.source.paragraphs[0].rawEn,JSON.parse(snapshot).source.paragraphs[0].rawEn);
 taskInput.source.paragraphs[0].rawEn=JSON.parse(snapshot).source.paragraphs[0].rawEn;
 assert.equal(task.evidenceMode,'reading-supported');assert.equal('rating' in task,false);
});
test('missing evidence and unbounded generic questions are not answerable tasks',()=>{
 assert.equal(paperReadingTask({...taskInput,reference:[{point:'invented',paragraphId:'p1',quote:'not in source'}]}).status,'needs-improvement');
 assert.equal(paperReadingTask({...taskInput,question:'概括核心要点'}).status,'needs-improvement');
 const long=paperReadingTask({...taskInput,source:{...source,paragraphs:[{id:'p1',rawEn:'x'.repeat(8001)}]}});
 assert.equal(long.status,'needs-improvement');assert.equal(long.source.paragraphs[0].rawEn.length,8001);
});
test('submission is immutable and receipt-loss replay cannot create a second answer',()=>{
 const initial=attempt(),input={operationId:'submit1',expectedRevision:0,answer:'Positive inputs avoid saturation.',submittedAt:'2026-10-08T08:00:00Z'};
 const saved=submitPaperReadingAnswer(initial,input);assert.deepEqual(submitPaperReadingAnswer(saved,input),saved);
 assert.throws(()=>submitPaperReadingAnswer(saved,{...input,answer:'different'}),/conflict/);
 assert.equal(saved.evaluation.status,'pending');assert.equal(saved.submission.answer,input.answer);
 assert.equal('formal' in saved,false);assert.equal('rating' in saved,false);
});
test('stale feedback is rejected and resolved feedback cannot be silently replaced',()=>{
 const saved=submitPaperReadingAnswer(attempt(),{operationId:'s',expectedRevision:0,answer:'I do not know',submittedAt:'2026-10-08T08:00:00Z'});
 const input={operationId:'e',expectedRevision:1,answerRevision:1,taskRevision:1,evaluation:{status:'resolved',outcome:'incorrect',matched:[],issues:['Missing mechanism'],explanation:'Positive inputs avoid saturation.'}};
 assert.throws(()=>applyPaperReadingFeedback(saved,{...input,answerRevision:2}),/binding/);
 const resolved=applyPaperReadingFeedback(saved,input);assert.deepEqual(applyPaperReadingFeedback(resolved,input),resolved);
 assert.throws(()=>applyPaperReadingFeedback(resolved,{...input,operationId:'e2',expectedRevision:2,evaluation:{...input.evaluation,outcome:'correct'}}),/conflict/);
 const retry=createPaperReadingAttempt(ready(),{attemptId:'a2',purpose:'remediation',parentAttemptId:'a1'});
 assert.equal(retry.parentAttemptId,'a1');assert.equal(resolved.evaluation.outcome,'incorrect');assert.equal(retry.submission,null);
});
