import test from 'node:test';import assert from 'node:assert/strict';
const mod=await import('../app/long-term-review-forecast.ts').catch(()=>({}));
const pacing=await import('../app/long-term-pacing.ts').catch(()=>({}));
const inventory=[{itemId:'a:0',subjectId:'a',sourceHash:'h',estimatedMinutes:10,reviewMinutes:2,completedRounds:1}];
const card={due:'2026-09-07T00:00:00Z',stability:2,difficulty:5,elapsed_days:1,scheduled_days:1,learning_steps:0,reps:2,lapses:0,state:2,last_review:'2026-09-06T00:00:00Z'};
const options={asOfDate:'2026-09-07',generatedAt:'2026-09-07T00:00:00Z'};

test('subject retention changes only that subject forecast and survives the plan contract',()=>{
 const items=[inventory[0],{...inventory[0],itemId:'b:0',subjectId:'b'}],cards={'a:0':card,'b:0':structuredClone(card)},before=structuredClone(cards);
 const spec={planId:'per-subject',startDate:'2026-09-07',targetDeadline:'2026-10-30',dailyMinutesBudget:{workdayMin:0,workdayMax:60,weekendMax:60,minReviewRatio:.35},subjectsConfig:[{subjectId:'a',priority:1,completionCriteria:'fixed-rounds',forecastRetention:.97},{subjectId:'b',priority:1,completionCriteria:'fixed-rounds',forecastRetention:.8}],bufferRatio:0};
 const plan=pacing.generateLongTermSchedule(items,spec,cards,options),dates=id=>plan.schedule.filter(slot=>slot.reviewItemIds.includes(id)).map(slot=>slot.date);
 assert.ok(dates('a:0').length>dates('b:0').length);assert.deepEqual(plan.forecastAssumptions.requestRetentionBySubject,{a:.97,b:.8});assert.deepEqual(cards,before);
 assert.throws(()=>pacing.generateLongTermSchedule(items,{...spec,subjectsConfig:spec.subjectsConfig.map(s=>({...s,forecastRetention:1}))},cards,options),/retention|number/);
});
test('forecast uses real FSRS Good intervals, explicit retention and preserves actual cards',()=>{
 assert.equal(typeof mod.forecastLongTermReviews,'function');const map={'a:0':card},before=structuredClone(map);
 const a=mod.forecastLongTermReviews(inventory,map,'2026-09-30',options);const b=mod.forecastLongTermReviews(inventory,map,'2026-09-30',{...options,requestRetention:.97});
 assert.equal(a.assumptions.rating,'Good');assert.equal(a.assumptions.requestRetention,.9);assert.ok(a.reviews.length>1);assert.notDeepEqual(a.reviews,b.reviews);assert.deepEqual(map,before);
 assert.deepEqual(mod.forecastLongTermReviews(inventory,map,'2026-09-30',options),a);
});
test('completed learning still has reviews; oversized review load is carried explicitly within capacity',()=>{
 assert.equal(typeof pacing.generateLongTermSchedule,'function');const many=Array.from({length:3},(_,i)=>({...inventory[0],itemId:`a:${i}`,reviewMinutes:10}));
 const spec={planId:'p',startDate:'2026-09-07',targetDeadline:'2026-09-09',dailyMinutesBudget:{workdayMin:0,workdayMax:20,weekendMax:20,minReviewRatio:.35},subjectsConfig:[{subjectId:'a',priority:1,completionCriteria:'fixed-rounds'}],bufferRatio:0};
 const p=pacing.generateLongTermSchedule(many,spec,Object.fromEntries(many.map(i=>[i.itemId,card])),options);
 assert.equal(p.schedule[0].learningMinutes,0);assert.equal(p.schedule[0].reviewMinutes,20);assert.equal(p.schedule[0].unservedReviewMinutes,10);assert.ok(p.schedule[1].reviewItemIds.includes('a:2'));
});
test('malformed FSRS dates and invalid retention fail rather than poisoning projections',()=>{
 assert.equal(typeof mod.forecastLongTermReviews,'function');assert.throws(()=>mod.forecastLongTermReviews(inventory,{'a:0':{...card,due:'bad'}},'2026-09-09',options));assert.throws(()=>mod.forecastLongTermReviews(inventory,{},'2026-09-09',{...options,requestRetention:1}));
});
