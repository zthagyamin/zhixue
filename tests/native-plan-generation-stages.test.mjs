import assert from 'node:assert/strict';
import test from 'node:test';
import {catalog,DAY} from './fixtures/task-event-fixtures.mjs';
import {courseSubject} from './fixtures/task-plan-input.mjs';
import {createTaskPlanningSession} from '../app/task-planning-session.ts';
import {buildDailyPlanningInput} from '../app/task-planning-input.ts';
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';

test('native generation shows the actual AI request stage and preserves the rule draft on failure',async()=>{
  const data=catalog(),subject=courseSubject(1);subject.goals=[];data.subjects.push(subject);
  const bundle={context:{catalog:data,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}};
  const states=[];let calls=0;
  const session=createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async()=>{},loadBundle:async()=>structuredClone(bundle),putTaskEvent:async()=>{},now:()=>new Date('2026-08-31T06:00:00.000Z'),client:{suggestPlan:async()=>{calls++;throw Error('network');}},publish:value=>states.push(value)});
  await session.open('synthetic',DAY);
  await assert.rejects(session.generate(),/network/);
  assert.equal(calls,1);
  assert.ok(session.snapshot().draft);
  assert.match(session.snapshot().message,/规则草稿已保留/);
  const phases=states.map(value=>value.generationPhase).filter(Boolean);
  assert.ok(phases.indexOf('checking')<phases.indexOf('generating'));
  assert.ok(phases.indexOf('generating')<phases.indexOf('suggesting'));
  assert.equal(session.snapshot().generationPhase,null);
});

test('automatic origin is observed only for a draft created by this session and clears after refresh or scope changes',async()=>{
  const data=catalog(),subject=courseSubject(1);subject.goals=[];data.subjects.push(subject);
  const bundle={context:{catalog:data,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}};
  const {input}=await buildDailyPlanningInput({...bundle,day:DAY,previous:null});
  const source=buildLongTermPlanningInput(input);
  bundle.longTermPlan=generateLongTermSchedule(source.inventory,{planId:'session-long',startDate:DAY,targetDeadline:DAY,dailyMinutesBudget:{workdayMin:0,workdayMax:3,weekendMax:3,minReviewRatio:0},subjectsConfig:input.catalog.subjects.map(s=>({subjectId:s.subjectId,priority:3,completionCriteria:'fixed-rounds'})),bufferRatio:0},{},{asOfDate:DAY,generatedAt:`${DAY}T00:00:00Z`});
  const drafts=new Map();
  const session=createTaskPlanningSession({loadDraft:async(workspace)=>drafts.get(workspace)??null,saveDraft:async(workspace,draft)=>drafts.set(workspace,structuredClone(draft)),loadBundle:async()=>structuredClone(bundle),putTaskEvent:async()=>{},now:()=>new Date('2026-08-31T06:00:00.000Z'),client:{suggestPlan:async()=>assert.fail('long term skips suggestions')},publish(){}});
  await session.open('first',DAY);assert.equal(session.snapshot().draftOrigin,null);
  assert.equal(await session.prepareAutomaticDay(bundle.longTermPlan),true);
  assert.equal(session.snapshot().draftOrigin,'automatic');
  await session.refresh();assert.equal(session.snapshot().draftOrigin,null);
  await session.generate();assert.equal(session.snapshot().draftOrigin,'manual');
  const other=drafts.get('first');drafts.set('other',other);
  await session.open('other',DAY);assert.equal(session.snapshot().draftOrigin,null);
  await session.prepareAutomaticDay(bundle.longTermPlan);assert.equal(session.snapshot().draftOrigin,null);
  await session.open('third','2026-09-01');assert.equal(session.snapshot().draftOrigin,null);
});

test('an older request cannot clear the progress of a newer generation after refresh',async()=>{
  const data=catalog(),subject=courseSubject(1);subject.goals=[];data.subjects.push(subject);
  const bundle={context:{catalog:data,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}};
  const pending=[],entered=[];
  const session=createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async()=>{},loadBundle:async()=>structuredClone(bundle),putTaskEvent:async()=>{},now:()=>new Date('2026-08-31T06:00:00.000Z'),client:{suggestPlan:request=>new Promise(resolve=>{pending.push(()=>resolve({...request,mode:'fallback',selections:[],message:''}));entered.shift()?.();})},publish(){}});
  const waitForCall=()=>new Promise(resolve=>entered.push(resolve));
  await session.open('same',DAY);const firstEntered=waitForCall(),first=session.generate();await firstEntered;
  await session.refresh();const secondEntered=waitForCall(),second=session.generate();await secondEntered;
  pending[0]();await first;assert.equal(session.snapshot().generationPhase,'suggesting');
  pending[1]();await second;assert.equal(session.snapshot().generationPhase,null);
});
