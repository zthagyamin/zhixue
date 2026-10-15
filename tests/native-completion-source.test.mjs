import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildDailyPlanningInput,completedPlanTaskIds} from '../app/task-planning-input.ts';
import {generateTaskPlan,planningHash} from '../app/task-plan-engine.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';
import {createTaskPlanningSession} from '../app/task-planning-session.ts';
import {loadPlanningRecords,studyDay,currentPracticeCompletionEvents,currentPracticeCompletionReviews,nativeTaskCompletedKeys} from '../src/domain/planning/index.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {attempt,baseline} from './fixtures/task-event-fixtures.mjs';
const history={local:'complete',companion:'complete',tasks:'complete',cloud:'not-applicable'};

test('shared source fixture, conflicts and original word aliases use the same current-version rule',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/practice-completion-source-v1.json',import.meta.url),'utf8'));
 const catalog={subjects:[{words:fixture.wordKeys.map(itemKey=>({itemKey,legacyKeys:['word:alias']}))}],practiceSources:fixture.sources};
 for(const entry of fixture.cases){
  const event=await attempt(`fixture-${entry.id}`,'2026-08-31T01:00:00Z',0,3,true,{item:{kind:'due',key:entry.key}});
  const record={event,subjectId:'course'};
  if(entry.proof){const body={schemaVersion:1,eventId:event.eventId,coreHash:entry.wrongCore?'f'.repeat(64):event.coreHash,itemSource:{itemKey:entry.key,subjectId:entry.wrongSubject?'another':'course',sourceHash:entry.proof}};record.planningEvidence={...body,evidenceHash:await planningHash(body)};}
  assert.equal(currentPracticeCompletionEvents(catalog,[event],[record]).length>0,entry.expected,entry.id);
  if(entry.id==='current'){
   const conflicting=structuredClone(record);conflicting.planningEvidence.itemSource.sourceHash='c'.repeat(64);
   for(const records of [[record,conflicting],[conflicting,record]])assert.deepEqual(currentPracticeCompletionEvents(catalog,[event],records),[]);
   assert.deepEqual(currentPracticeCompletionEvents({...catalog,practiceSources:[...catalog.practiceSources,{...catalog.practiceSources[0],sourceHash:'c'.repeat(64)}]},[event],[record]),[]);
   assert.deepEqual(currentPracticeCompletionEvents({...catalog,practiceSources:[]},[event],[record]),[]);
  }
 }
 const alias=await attempt('word-alias','2026-08-31T01:00:00Z',0,3,true,{item:{kind:'word',key:'word:alias'}});
 assert.deepEqual(currentPracticeCompletionEvents(catalog,[alias],[]),[alias]);
 const reused={...catalog,practiceSources:[{itemKey:'word:alias',subjectId:'course',sourceHash:'b'.repeat(64)}]};
 assert.deepEqual(currentPracticeCompletionEvents(reused,[alias],[]),[]);
});

test('version-filtered review success still uses its immutable old anchor and latest failed attempt',async()=>{
 const anchor=await attempt('old-anchor','2026-08-31T01:00:00Z',0,3,true,{item:{kind:'due',key:'practice:p'}});
 const success=await attempt('current-success','2026-08-31T02:00:00Z',0,3,true,{item:anchor.item});
 const failure=await attempt('current-failure','2026-08-31T03:00:00Z',0,0,false,{item:anchor.item});
 const task={category:'review',action:{kind:'practice',itemKeys:[anchor.item.key]}},round={anchorEventId:anchor.eventId};
 assert.deepEqual(nativeTaskCompletedKeys(task,round,[success],'2026-08-31',[anchor,success]),[anchor.item.key]);
 assert.deepEqual(nativeTaskCompletedKeys(task,round,[success,failure],'2026-08-31',[anchor,success,failure]),[]);
});

test('historical review completion cannot bypass missing current-source proof, including a reused word alias',async()=>{
 const event=await attempt('review-complete','2026-08-31T02:00:00Z',0,3,true,{item:{kind:'due',key:'practice:p'}});
 const plan={day:'2026-08-31',tasks:[{taskId:'review',category:'review',reviewRoundId:'round'}]};
 const round={roundId:'round',itemKey:event.item.key,completed:true,completedAt:event.occurredAt};
 const facts={catalog:{subjects:[{words:[]}],practiceSources:[{itemKey:event.item.key}]},events:[],reviews:[round],identities:[],completions:[],taskEvents:[]};
 assert.deepEqual(completedPlanTaskIds(plan,facts),[]);
 const projected=currentPracticeCompletionReviews(facts.catalog,[round],[],'2026-08-31');
 assert.equal(projected[0].completed,false);assert.equal(round.completed,true);
 assert.equal(currentPracticeCompletionReviews(facts.catalog,[round],[event],'2026-08-31')[0].completed,true);
 const laterFailure=await attempt('next-round-failure','2026-08-31T03:00:00Z',0,0,false,{item:event.item});
 assert.equal(currentPracticeCompletionReviews(facts.catalog,[round],[event,laterFailure],'2026-08-31')[0].completed,true);
 assert.deepEqual(completedPlanTaskIds(plan,{...facts,events:[event]}),['review']);
 const words=[{itemKey:'word:canonical',legacyKeys:[event.item.key]}];
 assert.deepEqual(completedPlanTaskIds(plan,{...facts,catalog:{...facts.catalog,subjects:[{words}]}}),[]);
 assert.deepEqual(completedPlanTaskIds(plan,{...facts,catalog:{subjects:[{words}],practiceSources:[]}}),['review']);
 assert.deepEqual(completedPlanTaskIds(plan,{...facts,catalog:{subjects:[{words:[]}],practiceSources:[]}}),[]);
});

test('real daily session shows pending review totals for old or missing source evidence',async()=>{
 const key='practice:p',seed=await baseline(key),event=await attempt('summary-success','2026-08-31T02:00:00Z',0,3,true,{item:{kind:'due',key}});
 const catalog={schemaVersion:1,sourceHash:'a'.repeat(64),subjects:[{subjectId:'course',name:'Course',priority:3,words:[],units:[],goals:[]}],practiceSources:[{itemKey:key,subjectId:'course',title:'Current',sourceHash:'b'.repeat(64),completionRule:'graded-practice'}],diagnostics:[]};
 for(const hash of [null,'c'.repeat(64),'b'.repeat(64)]){
  const record={event,subjectId:'course'};
  if(hash){const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,itemSource:{itemKey:key,subjectId:'course',sourceHash:hash}};record.planningEvidence={...body,evidenceHash:await planningHash(body)};}
  const facts={context:{catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T03:00:00Z',planRevision:0,capabilities:[]},localEvents:[seed],companionRecords:[record],taskEvents:[],history,legacyItemKeys:[],previous:null,day:'2026-08-31'};
  const composed=await buildDailyPlanningInput(facts),plan=await generateTaskPlan(composed.input);
  assert.equal(composed.input.reviews.length,1);assert.equal(composed.input.reviews[0].completed,hash==='b'.repeat(64));
  let draft={plan,baseRevision:0,dirty:false};
  const session=createTaskPlanningSession({loadDraft:async()=>draft,saveDraft:async(_owner,value)=>{draft=value;},loadBundle:async()=>({...facts,authority:{revision:0,candidate:plan,history:[]}}),putTaskEvent:async()=>{},client:{},publish(){},now:()=>new Date(event.occurredAt),newId:()=> 'summary-test'});
  try{await session.open('account:summary','2026-08-31');const state=session.snapshot();assert.equal(state.summary.reviewTotal,1);assert.equal(state.summary.reviewDone,hash==='b'.repeat(64)?1:0);assert.deepEqual(composed.events,[seed,event]);}
  finally{session.invalidate();}
 }
});

test('old-version success followed by current-version success completes the real review task consistently',async()=>{
 const key='practice:p',seed=await baseline(key),old=await attempt('old-version-success','2026-08-31T02:00:00Z',0,3,true,{item:{kind:'due',key}}),current=await attempt('new-version-success','2026-08-31T03:00:00Z',0,3,true,{item:{kind:'due',key}});
 const catalog={schemaVersion:1,sourceHash:'a'.repeat(64),subjects:[{subjectId:'course',name:'Course',priority:3,words:[],units:[],goals:[]}],practiceSources:[{itemKey:key,subjectId:'course',title:'Current',sourceHash:'b'.repeat(64),completionRule:'graded-practice'}],diagnostics:[]};
 const records=await Promise.all([[old,'c'],[current,'b']].map(async([event,char])=>{const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,itemSource:{itemKey:key,subjectId:'course',sourceHash:char.repeat(64)}};return {event,subjectId:'course',planningEvidence:{...body,evidenceHash:await planningHash(body)}};}));
 const facts={context:{catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T04:00:00Z',planRevision:0,capabilities:[]},localEvents:[seed],companionRecords:records,taskEvents:[],history,legacyItemKeys:[],previous:null,day:'2026-08-31'};
 const composed=await buildDailyPlanningInput(facts),plan=await generateTaskPlan(composed.input),round=composed.input.reviews[0],task=plan.tasks.find(task=>task.reviewRoundId===round.roundId);
 assert.equal(round.completed,true);assert.equal(round.completedAt,current.occurredAt);assert.deepEqual(composed.events,[seed,old,current]);
 assert.deepEqual(nativeTaskCompletedKeys(task,round,composed.completionEvents,facts.day,composed.events),[key]);
 assert.equal(completedPlanTaskIds(plan,{catalog,events:composed.completionEvents,completions:composed.input.completions,reviews:composed.input.reviews,identities:[],taskEvents:[]}).includes(task.taskId),true);
});

test('daily completion requires the saved nonword source version and keeps all original events',async()=>{
 const currentHash='b'.repeat(64),key='practice:one';
 const event=await attempt('completion-version','2026-08-31T01:00:00Z',0,3,true,{item:{kind:'due',key}});
 const unit={unitId:'unit',subjectId:'course',title:'Current',order:0,sourceHash:currentHash,prerequisites:[],action:{kind:'practice',itemKeys:[key]},completionRule:'graded-practice'};
 const catalog={schemaVersion:1,sourceHash:'a'.repeat(64),subjects:[{subjectId:'course',name:'Course',priority:3,words:[],units:[unit],goals:[]}],practiceSources:[{itemKey:key,subjectId:'course',title:'Current',sourceHash:currentHash,completionRule:'graded-practice'}],diagnostics:[]};
 for(const [sourceHash,expected]of[[currentHash,true],['c'.repeat(64),false],[null,false]]){
  let record={event,subjectId:'course'};
  if(sourceHash){const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,itemSource:{itemKey:key,subjectId:'course',sourceHash}};record={...record,planningEvidence:{...body,evidenceHash:await planningHash(body)}};}
  const before=structuredClone(record),result=await buildDailyPlanningInput({day:'2026-08-31',context:{catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T02:00:00Z',planRevision:0,capabilities:[]},localEvents:[],companionRecords:[record],taskEvents:[],previous:null,legacyItemKeys:[],history});
  assert.equal(result.input.completions.length>0,expected,String(sourceHash));assert.deepEqual(result.events,[event]);assert.deepEqual(record,before);
 }
});

test('real native writer source changes do not complete a current-hash task or seed its restored cursor',async()=>{
 const packet=JSON.parse(execFileSync(process.env.PYTHON||'python',['-X','utf8',fileURLToPath(new URL('./fixtures/native_completion_source.py',import.meta.url))],{encoding:'utf8',windowsHide:true}));
 assert.equal(packet.sourceChanged,true);assert.equal(packet.immutableRecordsPreserved,true);assert.equal(packet.formalEventCount,1);
 const records=await loadPlanningRecords(packet.context,{getPlanningEvidence:async()=>packet.page}),day=studyDay(packet.event.occurredAt);
 const before=await buildDailyPlanningInput({context:packet.beforeContext,localEvents:[],companionRecords:records,taskEvents:[],history,legacyItemKeys:[],previous:null,day});
 assert.equal(before.input.completions.length,1);assert.deepEqual(before.events,[packet.event]);
 const facts={context:packet.context,localEvents:[],companionRecords:records,taskEvents:[],history,legacyItemKeys:[],previous:null,day};
 const composed=await buildDailyPlanningInput(facts),base=await generateTaskPlan(composed.input);
 const source=packet.context.catalog.practiceSources.find(s=>s.itemKey===packet.event.item.key);
 const task={taskId:'manual:current-version',subjectId:source.subjectId,title:'Current version',category:'subject',origin:'manual',required:false,unitIds:[],quantity:1,action:{kind:'practice',itemKeys:[source.itemKey]},completionRule:source.completionRule,sourceHash:source.sourceHash};
 const plan=await editTaskPlan(base,{type:'upsert',task},packet.context.catalog);let saved={plan,baseRevision:0,dirty:false};
 const session=createTaskPlanningSession({loadDraft:async()=>saved,saveDraft:async(_owner,draft)=>{saved=draft;},loadBundle:async()=>({...facts,authority:{revision:0,candidate:plan,history:[]}}),putTaskEvent:async()=>{},client:{},publish(){},now:()=>new Date(packet.event.occurredAt),newId:()=> 'version-test'});
 try{await session.open('account:version-test',day);assert.equal(session.snapshot().completedTaskIds.includes(task.taskId),false);
  const {createPlanningSourceAdapter}=loadTsx(new URL('../app/study-dashboard/planning-source-adapter.ts',import.meta.url));
  const frame={owner:'account:version-test',day,nativeScope:'version-scope',subjects:packet.subjects,latestSubjects:()=>packet.subjects,progress:{itemStages:{},fsrsData:{}},overrides:{item:{},subject:{}},selection:null,nativeSession:session,nativeProjection:{workspaceId:'account:version-test',sourceScope:'version-scope',events:records.map(r=>r.event)},nativeReady:true,account:null,journal:{}};
  const loaded=await createPlanningSourceAdapter(()=>frame).loadNative({scope:{owner:frame.owner,day,libraryId:frame.nativeScope,mode:'native'},current:()=>true},false);
  assert.deepEqual(loaded.context.completed[task.taskId],[]);assert.equal(packet.backendTaskComplete,false);
 }finally{session.invalidate();}
});
