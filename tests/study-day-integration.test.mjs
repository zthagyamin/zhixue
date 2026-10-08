import test from 'node:test';
import assert from 'node:assert/strict';
import {attempt,baseline,catalog,word} from './fixtures/task-event-fixtures.mjs';
import {buildDailyPlanningInput,projectUnitCompletions,completedPlanTaskIds} from '../app/task-planning-input.ts';
import {goalQuota,planningHash} from '../app/task-plan-engine.ts';
import {projectReviewObligations} from '../app/task-review-projection.ts';
import {hashTaskEvent,validateTaskEvent} from '../app/task-event-v1.ts';
import {summarizeTaskPlan} from '../app/task-plan-runtime.ts';
import {nativeTaskCompletedKeys} from '../src/domain/planning/round-resume.ts';
import {watchStudyDay} from '../src/application/planning/study-day-clock.ts';

const day='2026-09-22',night='2026-09-22T19:59:59.999Z';
test('planning composition includes the entire transition window and restores overnight completion',async()=>{
 const event=await attempt('overnight-complete',night,0,3),data=catalog();
 const result=await buildDailyPlanningInput({day,context:{catalog:data,sourceReviews:[],captureReviews:[],observedAt:night,planRevision:0,capabilities:[]},
 localEvents:[event],companionRecords:[],taskEvents:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},legacyItemKeys:[],previous:null});
 assert.equal(result.events.length,1);
 const task={taskId:'new',category:'new-word',required:true,action:{kind:'practice',itemKeys:['word:tree']}};
 assert.deepEqual(nativeTaskCompletedKeys(task,undefined,[event],day),['word:tree']);
 const words=[{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'learned',firstLearnedAt:night}];
 const summary=summarizeTaskPlan({day,tasks:[task],vocabulary:{target:1,snapshot:[word()]}},words,[]);
 assert.equal(summary.newDone,1);assert.equal(summary.newMissing,0);
});
test('both legacy and new task-day declarations retain their exact signed bodies',async()=>{
 for(const declared of ['2026-09-22','2026-09-23']){
  const body={schemaVersion:1,eventType:'task-completed',eventId:`task-${declared}`,taskId:'task-test',subjectId:'course',day:declared,occurredAt:night,unitIds:[],source:'self-report',evidenceRefs:[]};
  const event={...body,coreHash:await hashTaskEvent(body)};assert.deepEqual(await validateTaskEvent(event),event);
 }
});
test('tomorrow note-date review waits until four; real FSRS midnight instant remains due tonight',async()=>{
 const data=catalog(),common={day,words:[],events:[],previous:[],catalog:data};
 const source={itemKey:'word:tree',subjectId:'vocab',sourceHash:word().sourceHash,completionRule:'three-stage',state:{enabled:true,dueAt:'2026-09-23T00:00:00+08:00'}};
 const notes=await projectReviewObligations({...common,currentSourceReviews:[source],sourceObservedAt:'2026-09-22T16:00:00.000Z'});
 assert.equal(notes.length,0);
 const real=await projectReviewObligations({...common,events:[await baseline('word:tree','2026-09-22T16:00:00.000Z')]});
 assert.equal(real.length,1);assert.equal(real[0].dueAt,'2026-09-22T16:00:00.000Z');
});
test('clock ticks exactly at the boundary and recovers after a hidden page returns',()=>{
 let now=new Date(night),callback,delay,visible,closed=false;const days=[];
 const stop=watchStudyDay({now:()=>now,publish:day=>days.push(day),schedule:(fn,ms)=>{callback=fn;delay=ms;return 1;},clear(){},onVisible:fn=>{visible=fn;return()=>{closed=true;};}});
 assert.equal(delay,1);now=new Date('2026-09-22T20:00:00.000Z');callback();assert.equal(days.at(-1),'2026-09-23');
 now=new Date('2026-09-23T21:00:00.000Z');visible();assert.equal(days.at(-1),'2026-09-24');stop();assert.equal(closed,true);
});
test('legacy self-report retains its declared plan day through unit and goal projections',()=>{
 const data=catalog([]);data.subjects[0].units=[{unitId:'unit',subjectId:'vocab',title:'Unit',order:0,sourceHash:word().sourceHash,prerequisites:[],action:{kind:'open-note',contentRef:'unit'},completionRule:'self-report',formalComplete:false}];
 const report={taskId:'legacy-task',subjectId:'vocab',source:'self-report',day:'2026-09-23',occurredAt:'2026-09-22T17:00:00.000Z',unitIds:['unit']};
 const completions=projectUnitCompletions(data,[],[report],[]),task={taskId:'legacy-task',subjectId:'vocab',unitIds:['unit'],category:'subject',completionRule:'self-report'};
 const facts={catalog:data,events:[],completions,reviews:[],identities:[],taskEvents:[report]};
 assert.deepEqual(completedPlanTaskIds({day:'2026-09-22',tasks:[task]},facts),[]);
 assert.deepEqual(completedPlanTaskIds({day:'2026-09-23',tasks:[task]},facts),['legacy-task']);
 const goal={kind:'daily',targetCount:1,unitIds:['unit'],startOn:'2026-09-22',completionBasis:'self-report'};
 assert.equal(goalQuota(goal,'2026-09-22',completions,1),1);assert.equal(goalQuota(goal,'2026-09-23',completions,1),0);
});
test('source date encoding migration does not reopen an already completed review',async()=>{
 const event=await attempt('pending-old-source','2026-09-23T01:00:00.000Z',2,3,true,{scheduling:undefined});
 const beforeReview={enabled:true,dueAt:'2026-09-23T00:00:00+08:00'};
 const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,beforeReview};
 const sourceHistory=[{event,subjectId:'vocab',planningEvidence:{...body,evidenceHash:await planningHash(body)}}],original=structuredClone(sourceHistory);
 const common={day:'2026-09-23',words:[],events:[event],previous:[],catalog:catalog(),sourceHistory,sourceObservedAt:'2026-09-23T02:00:00.000Z'};
 for(const dueAt of [beforeReview.dueAt,'2026-09-23T04:00:00+08:00']){
  const rounds=await projectReviewObligations({...common,currentSourceReviews:[{itemKey:'word:tree',subjectId:'vocab',sourceHash:word().sourceHash,completionRule:'three-stage',state:{enabled:true,dueAt}}]});
  assert.equal(rounds.length,1);assert.equal(rounds[0].completed,true);
 }
 assert.deepEqual(sourceHistory,original);
});
