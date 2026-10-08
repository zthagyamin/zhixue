import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pacing = await import('../app/long-term-pacing.ts').catch(() => ({}));
const types = await import('../app/long-term-plan-types.ts').catch(() => ({}));
const options = {asOfDate:'2026-09-07',generatedAt:'2026-09-07T00:00:00.000Z',maxProposalExtensionDays:10,maxProposalExtraMinutes:20};
const spec = (patch={}) => ({planId:'p',startDate:'2026-09-07',targetDeadline:'2026-09-09',dailyMinutesBudget:{workdayMin:10,workdayMax:20,weekendMax:10,minReviewRatio:.35},subjectsConfig:[{subjectId:'a',priority:1,completionCriteria:'fixed-rounds'}],bufferRatio:0,...patch});
const items = (n=4) => Array.from({length:n},(_,i)=>({itemId:`a:${i}`,sourceHash:'h1',subjectId:'a',estimatedMinutes:10}));
const generate = (...args) => {assert.equal(typeof pacing.generateLongTermSchedule,'function');return pacing.generateLongTermSchedule(...args);};
test('ten minute items respect twenty minute budget after reserve and remain accounted for',()=>{
 const p=generate(items(),spec(),{},options);
 assert.deepEqual(p.schedule.map(s=>s.newItemIds.length),[1,1,1]);assert.equal(p.backlog.length,1);
 assert.equal(new Set([...p.schedule.flatMap(s=>s.newItemIds),...p.backlog.map(i=>i.itemId)]).size,4);
 for(const s of p.schedule) assert.ok(s.learningMinutes+Math.max(s.reviewMinutes,s.reviewReserveMinutes)<=s.budgetMinutes);
});
test('strict dates, horizons, budgets, priorities and IDs reject malformed inputs',()=>{
 generate([],spec({startDate:'2024-02-29',targetDeadline:'2024-02-29'}),{},{...options,asOfDate:'2024-02-29'});
 for(const patch of [{startDate:'2023-02-29'},{startDate:'2026-02-30'},{targetDeadline:'2026-09-06'},{targetDeadline:'2035-09-06'},{subjectsConfig:[{subjectId:'a',priority:0,completionCriteria:'fixed-rounds'}]}]) assert.throws(()=>generate(items(),spec(patch),{},options));
 for(const n of [-1,NaN,Infinity]) {assert.throws(()=>generate([{...items(1)[0],estimatedMinutes:n}],spec(),{},options));assert.throws(()=>generate([],spec({dailyMinutesBudget:{...spec().dailyMinutesBudget,workdayMax:n}}),{},options));}
 assert.throws(()=>generate([items(1)[0],items(1)[0]],spec(),{},options));
});
test('replay is deterministic and leaves input references untouched',()=>{
 const input=items(),s=spec(),before=JSON.stringify([input,s,options]);const p=generate(input,s,{},options);
 assert.deepEqual(generate([...input].reverse(),s,{},options),p);assert.equal(JSON.stringify([input,s,options]),before);
 p.inventory[0].sourceHash='changed';assert.equal(input[0].sourceHash,'h1');
});
test('empty inventory reports underfill without fabricated work',()=>{const p=generate([],spec(),{},options);assert.ok(p.schedule.every(s=>s.learningMinutes===0));assert.ok(p.schedule[0].warnings.includes('underfilled-workday'));});
test('weekend budgets, buffer days, oversized items and mastered exclusions are explicit',()=>{
 const p=generate([...items(12),{itemId:'big',subjectId:'a',sourceHash:'h',estimatedMinutes:100},{itemId:'mastered',subjectId:'a',sourceHash:'h',estimatedMinutes:10,mastered:true}],spec({targetDeadline:'2026-09-13',bufferRatio:2/7}),{},options);
 assert.equal(p.schedule.filter(s=>s.isBufferDay).length,2);assert.ok(p.schedule.filter(s=>s.isBufferDay).every(s=>s.newItemIds.length===0));
 assert.equal(p.schedule[5].budgetMinutes,10);assert.ok(p.backlog.some(i=>i.itemId==='big'));assert.ok(p.excludedItemIds.includes('mastered'));
});
test('weighted subjects get scarce time and daily caps cannot be exceeded',()=>{
 const s=spec({targetDeadline:'2026-09-07',dailyMinutesBudget:{workdayMin:0,workdayMax:50,weekendMax:50,minReviewRatio:0},subjectsConfig:[{subjectId:'a',priority:1,dailyQuotaTarget:1,completionCriteria:'fixed-rounds'},{subjectId:'b',priority:5,completionCriteria:'all-mastered'}]});
 const p=generate([...items(5),...items(5).map(i=>({...i,itemId:i.itemId.replace('a','b'),subjectId:'b'}))],s,{},options);
 assert.equal(p.schedule[0].newItemIds[0],'b:0');assert.equal(p.schedule[0].expectedNewItems.a,1);assert.equal(p.schedule[0].expectedNewItems.b,4);
});
test('overflow alternatives are proposals, feasible only when recalculation clears backlog',()=>{
 const s=spec({targetDeadline:'2026-09-07'}),p=generate(items(4),s,{},options);assert.equal(p.spec.targetDeadline,'2026-09-07');
 assert.ok(p.adjustmentProposals.some(a=>a.kind==='extend-deadline'&&a.feasible&&a.remainingBacklogCount===0));
 const impossible=generate([{...items(1)[0],estimatedMinutes:5000}],s,{},options);assert.ok(impossible.adjustmentProposals.every(a=>!a.feasible));
});
test('three missed days freeze past slots, requeue work and mark negative drift',()=>{
 const p=generate(items(8),spec({targetDeadline:'2026-09-14'}),{},options),before=structuredClone(p);
 assert.equal(typeof pacing.rebalanceScheduleOnDelta,'function');const q=pacing.rebalanceScheduleOnDelta(p,items(9),[],{},{...options,asOfDate:'2026-09-10',generatedAt:'2026-09-10T00:00:00Z'});
 assert.deepEqual(q.schedule.slice(0,3),p.schedule.slice(0,3));assert.equal(q.activeDriftDays,-3);assert.deepEqual(p,before);
 assert.ok(q.warnings.includes('three-missed-days'));assert.ok([...q.schedule.slice(3).flatMap(s=>s.newItemIds),...q.backlog.map(i=>i.itemId)].includes('a:8'));
});
test('ahead completion satisfies fixed rounds but not all-mastered, and stale hash evidence is ignored',()=>{
 const s=spec({targetDeadline:'2026-09-14',subjectsConfig:[{subjectId:'a',priority:1,completionCriteria:'all-mastered'}]});const p=generate(items(6),s,{},options);
 const history=items(3).map(i=>({itemId:i.itemId,sourceHash:i.sourceHash,date:'2026-09-07',completedRounds:1}));
 const q=pacing.rebalanceScheduleOnDelta(p,items(6),history,{},{...options,asOfDate:'2026-09-08'});assert.ok(q.activeDriftDays>0);assert.equal(q.excludedItemIds.length,0);
 const fixed=generate(items(2),spec(),{},options);const f=pacing.rebalanceScheduleOnDelta(fixed,items(2),[history[0],{...history[1],sourceHash:'old'}],{},{...options,asOfDate:'2026-09-08'});assert.deepEqual(f.excludedItemIds,['a:0']);
});
test('shared snapshot validates and inconsistent totals or duplicate active IDs fail',()=>{
 assert.equal(typeof types.parseLongTermPlanSnapshot,'function');const fixture=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url)));
 assert.deepEqual(types.parseLongTermPlanSnapshot(fixture.snapshot),fixture.snapshot);
 for(const mutate of [p=>p.totalInventoryCount++,p=>p.schedule[0].newItemIds.push(p.schedule[0].newItemIds[0]),p=>p.schedule[0].learningMinutes=99,p=>p.schedule[0].date='2026-02-30']) {const p=structuredClone(fixture.snapshot);mutate(p);assert.throws(()=>types.parseLongTermPlanSnapshot(p));}
});
test('unknown learning state stays in explicit backlog and dependencies precede acquisition',()=>{
 const input=[{...items(1)[0],blockedReason:'history-unknown'},{...items(1)[0],itemId:'dependent',prerequisiteItemIds:['a:0']}];
 const p=generate(input,spec(),{},options);assert.equal(p.backlog.length,2);assert.ok(p.backlog.some(i=>i.reason==='history-unknown'));
 const ready=generate([{...items(1)[0],itemId:'z:prerequisite'},{...items(1)[0],itemId:'a:dependent',prerequisiteItemIds:['z:prerequisite']}],spec(),{},options);assert.equal(ready.schedule[0].newItemIds[0],'z:prerequisite');assert.equal(ready.schedule[1].newItemIds[0],'a:dependent');
 assert.throws(()=>generate([{...items(1)[0],prerequisiteItemIds:['missing']}],spec(),{},options));
});
test('fixed rounds require actual rounds and future Good forecasts never satisfy them',()=>{
 const p=generate([{...items(1)[0],completedRounds:1}],spec({targetDeadline:'2026-09-30',subjectsConfig:[{subjectId:'a',priority:1,completionCriteria:'fixed-rounds',requiredRounds:3}]}),{},options);
 assert.deepEqual(p.learningCompletedItemIds,['a:0']);assert.deepEqual(p.excludedItemIds,[]);assert.equal(p.remainingRequiredRounds['a:0'],2);assert.ok(p.schedule.some(s=>s.reviewItemIds.includes('a:0')));
});
test('generated snapshot parser rejects duplicate or missing active inventory accounting',()=>{
 const p=generate(items(),spec(),{},options);
 for(const mutate of [q=>q.backlog.push(q.backlog[0]),q=>q.backlog.splice(0),q=>q.schedule[1].newItemIds.push('a:0')]) {const q=structuredClone(p);mutate(q);assert.throws(()=>types.parseLongTermPlanSnapshot(q));}
});
test('snapshot cannot forge completion or increase declared budget or remove reserve',()=>{
 const p=generate(items(),spec(),{},options);
 for(const mutate of [q=>{q.learningCompletedItemIds.push(q.backlog[0].itemId);q.backlog=[];},q=>q.schedule[0].budgetMinutes=999,q=>q.schedule[0].reviewReserveMinutes=0]) {const q=structuredClone(p);mutate(q);assert.throws(()=>types.parseLongTermPlanSnapshot(q));}
});
test('rebalance cannot move observation date backwards and dates exclude year zero',()=>{
 const p=generate(items(),spec(),{},options);
 assert.throws(()=>pacing.rebalanceScheduleOnDelta(p,items(),[],{},{...options,asOfDate:'2026-09-06'}));
 assert.throws(()=>generate([],spec({startDate:'0000-01-01',targetDeadline:'0000-01-01'}),{},{...options,asOfDate:'0000-01-01'}));
});
test('three missed days recover overdue reviews before new work and buffer days absorb them',()=>{
 const input=items(8).map(i=>({...i,reviewMinutes:10}));const s=spec({targetDeadline:'2026-09-14',bufferRatio:.25});const p=generate(input,s,{},options);
 const card={due:'2026-09-07T00:00:00Z',stability:2,difficulty:5,elapsed_days:1,scheduled_days:1,learning_steps:0,reps:2,lapses:0,state:2,last_review:'2026-09-06T00:00:00Z'};
 const q=pacing.rebalanceScheduleOnDelta(p,input,[],Object.fromEntries(input.slice(0,4).map(i=>[i.itemId,card])),{...options,asOfDate:'2026-09-10'});
 assert.equal(q.schedule[3].isBufferDay,true);assert.equal(q.schedule[3].reviewMinutes,20);assert.equal(q.schedule[3].learningMinutes,0);assert.ok(q.schedule[3].unservedReviewMinutes>=20);
});
test('runtime validation rejects scheduling blocked or unmet prerequisite work',()=>{
 const p=generate(items(),spec(),{},options);const q=structuredClone(p);q.inventory[0].blockedReason='history-unknown';assert.throws(()=>types.parseLongTermPlanSnapshot(q));
 const r=structuredClone(p);r.inventory[0].prerequisiteItemIds=['a:3'];assert.throws(()=>types.parseLongTermPlanSnapshot(r));
});
test('preexisting completion and repeated historical assignments do not distort drift',()=>{
 const input=[...items(4),{...items(1)[0],itemId:'already',completedRounds:1}];const p=generate(input,spec({targetDeadline:'2026-09-14'}),{},options);
 const q=pacing.rebalanceScheduleOnDelta(p,input,[],{},{...options,asOfDate:'2026-09-08'});assert.equal(q.activeDriftDays,-1);
 const r=pacing.rebalanceScheduleOnDelta(q,input,[],{},{...options,asOfDate:'2026-09-09'});assert.equal(r.activeDriftDays,-1);
});
test('snapshot validation enforces subject caps using shared malformed cases',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url)));
 for(const c of fixture.invalidSnapshotCases){const p=structuredClone(fixture.snapshot);let parent=p;for(const key of c.path.slice(0,-1))parent=parent[key];parent[c.path.at(-1)]=c.value;assert.throws(()=>types.parseLongTermPlanSnapshot(p),c.name);}
});
test('removed and replaced source identities do not remain in active drift',()=>{
 const input=items(3),s=spec({dailyMinutesBudget:{...spec().dailyMinutesBudget,minReviewRatio:0}}),p=generate(input,s,{},options);
 for(const inventory of [[],input.map(i=>({...i,sourceHash:'replacement'}))]) {
  const q=pacing.rebalanceScheduleOnDelta(p,inventory,[],{},{...options,asOfDate:'2026-09-08'});assert.equal(q.activeDriftDays,0);assert.deepEqual(q.schedule[0],p.schedule[0]);
 }
 const q=pacing.rebalanceScheduleOnDelta(p,[input[0]],[],{},{...options,asOfDate:'2026-09-08'});assert.equal(q.activeDriftDays,-1);
});
test('inherited property names are valid item and subject IDs with own counters',()=>{
 const input=[{...items(1)[0],itemId:'toString',subjectId:'valueOf'},{...items(1)[0],itemId:'valueOf',subjectId:'valueOf'}];
 const s=spec({targetDeadline:'2026-09-30',subjectsConfig:[{subjectId:'valueOf',priority:1,completionCriteria:'fixed-rounds'}]});const p=generate(input,s,{},options);
 assert.deepEqual(p.schedule[0].newItemIds,['toString']);assert.equal(p.schedule[0].expectedNewItems.valueOf,1);assert.ok(p.schedule.some(day=>Object.hasOwn(day.projectedReviews,"valueOf")&&day.projectedReviews.valueOf>=1));
 assert.deepEqual(generate(input,s,{},options),p);
});
test('fractional maximum budget does not produce an invalid fractional proposal',()=>{
 const s=spec({dailyMinutesBudget:{workdayMin:0,workdayMax:1439.5,weekendMax:1439.5,minReviewRatio:0}});
 const p=generate([{...items(1)[0],estimatedMinutes:5000}],s,{},{...options,maxProposalExtensionDays:0});
 assert.equal(p.backlog.length,1);assert.ok(p.adjustmentProposals.every(a=>Number.isInteger(a.extraDailyMinutes)));assert.deepEqual(types.parseLongTermPlanSnapshot(p),p);
});
test('replaying rebalance preserves frozen assignment source identity after replacement',()=>{
 const input=items(3),s=spec({dailyMinutesBudget:{...spec().dailyMinutesBudget,minReviewRatio:0}}),p=generate(input,s,{},options);
 const replaced=input.map(i=>({...i,sourceHash:'replacement'})),o={...options,asOfDate:'2026-09-08'};
 const first=pacing.rebalanceScheduleOnDelta(p,replaced,[],{},o);
 const second=pacing.rebalanceScheduleOnDelta(first,replaced,[],{},o);
 assert.equal(first.activeDriftDays,0);assert.equal(second.activeDriftDays,0);assert.deepEqual(second,first);
 assert.deepEqual(second.schedule[0],p.schedule[0]);
 assert.equal(second.schedule[0].newItemSourceHashes['a:0'],'h1');
 assert.equal(second.schedule[1].newItemSourceHashes['a:0'],'replacement');
 const next=pacing.rebalanceScheduleOnDelta(second,replaced,[],{},{...o,asOfDate:'2026-09-09'});
 const nextReplay=pacing.rebalanceScheduleOnDelta(next,replaced,[],{},{...o,asOfDate:'2026-09-09'});
 assert.equal(nextReplay.activeDriftDays,next.activeDriftDays);assert.ok(next.activeDriftDays<0);
});
