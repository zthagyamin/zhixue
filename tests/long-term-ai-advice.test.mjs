import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../app/long-term-ai-advice.ts').catch(()=>({}));
const spec={planId:'p',startDate:'2026-09-09',targetDeadline:'2026-11-08',dailyMinutesBudget:{workdayMin:30,workdayMax:60,weekendMax:90,minReviewRatio:.35},subjectsConfig:[{subjectId:'s',priority:3,completionCriteria:'fixed-rounds',requiredRounds:2}],bufferRatio:.15};
const advice={days:30,dailyMinutes:40,weekendMinutes:60,dailyReviewTarget:15,subjects:[{subjectId:'s',dailyNewTarget:20,priority:5,retention:90}]};
test('AI suggestion changes allowed daily controls only, preserving original identity and advanced requirements',()=>{
 assert.equal(typeof api.applyLongTermAIAdvice,'function');
 const next=api.applyLongTermAIAdvice(JSON.stringify(advice),spec,'2026-09-09');
 assert.equal(next.planId,'p');assert.equal(next.startDate,spec.startDate);assert.equal(next.targetDeadline,'2026-10-08');assert.equal(next.dailyReviewTarget,15);assert.equal(next.subjectsConfig[0].requiredRounds,2);assert.equal(next.subjectsConfig[0].priority,5);assert.equal(next.subjectsConfig[0].dailyQuotaTarget,20);assert.equal(spec.subjectsConfig[0].priority,3);
 for(const changed of [{...advice,dailyReviewTarget:-1},{...advice,subjects:[{...advice.subjects[0],subjectId:'invented'}]},{...advice,subjects:[]},{...advice,days:0},{...advice,subjects:[{...advice.subjects[0],retention:101}]}])assert.throws(()=>api.applyLongTermAIAdvice(JSON.stringify(changed),spec,'2026-09-09'));
});
test('AI prompt transmits aggregate workload and explicit request, never source bodies or runtime data',()=>{
 const prompt=api.longTermAdvicePrompt('每天30分钟',spec,[{subjectId:'s',name:'词汇',vocabularyCount:12,itemCount:12,privateBody:'DO NOT COPY'}],'2026-09-09');
 assert.match(prompt,/每天30分钟/);assert.match(prompt,/12/);assert.ok(!prompt.includes('DO NOT COPY'));assert.match(prompt,/JSON/);
});

test('AI future duration is anchored to tomorrow while an old target retains its original start',()=>{
 const old={...spec,startDate:'2026-05-01'};
 const next=api.applyLongTermAIAdvice(JSON.stringify(advice),old,'2026-09-09');
 assert.equal(next.startDate,'2026-05-01');assert.equal(next.targetDeadline,'2026-10-08');
 const prompt=api.longTermAdvicePrompt('未来30天',old,[],'2026-09-09');assert.match(prompt,/2026-09-08/);assert.match(prompt,/2026-09-09/);
});
