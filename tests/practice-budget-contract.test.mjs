import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parsePracticeBudgetGroups,parseLongTermPlanSpec,parseLongTermDailyAllocation,applyLongTermPlan,reconcileDailyMinimums,generateTaskPlan,practiceBudgetView} from '../src/domain/planning/index.ts';
import {createCompanionPlanClient} from '../app/companion-plan-client.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/practice-budget.json',import.meta.url),'utf8'));
const spec={planId:'p',startDate:'2026-08-31',targetDeadline:'2026-09-30',dailyMinutesBudget:{workdayMin:0,workdayMax:30,weekendMax:30,minReviewRatio:0},subjectsConfig:[],bufferRatio:0};
const allocation={schemaVersion:1,planId:'p',day:spec.startDate,vocabularyTarget:0,items:[]};
test('shared JSON fixture has identical TS/Python validation at spec and issued allocation boundaries',()=>{
 const cases=[...fixture.valid,...fixture.invalid],expected=cases.map((_,i)=>i<fixture.valid.length);
 for(const [i,groups]of cases.entries())for(const parse of [value=>parsePracticeBudgetGroups(value),value=>parseLongTermPlanSpec({...spec,practiceBudgetGroups:value}),value=>parseLongTermDailyAllocation({...allocation,practiceBudgetGroups:value})]){
   if(expected[i])assert.doesNotThrow(()=>parse(groups));else assert.throws(()=>parse(groups));
 }
 assert.throws(()=>parsePracticeBudgetGroups(Array.from({length:9},(_,i)=>({id:String(i),title:'A',subjectIds:[String(i)],minutes:1,defaultItemMinutes:1}))));
 const code=`import json,sys\nsys.path.insert(0,'companion')\nfrom long_term_plan_schema import parse_practice_budget_groups,parse_long_term_plan_spec\nfrom task_plan_schema import validate_long_term_allocation\nv=json.load(sys.stdin)\nresult=[]\nfor groups in v['cases']:\n row=[]\n for fn,value in [(parse_practice_budget_groups,groups),(parse_long_term_plan_spec,{**v['spec'],'practiceBudgetGroups':groups}),(validate_long_term_allocation,{**v['allocation'],'practiceBudgetGroups':groups})]:\n  try: fn(value);row.append(True)\n  except (ValueError,TypeError):row.append(False)\n result.append(row)\nprint(json.dumps(result))`;
 const result=spawnSync(process.env.PYTHON,['-c',code],{input:JSON.stringify({cases,spec,allocation}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected.map(ok=>[ok,ok,ok]));
});
test('issued day retains old budget snapshot and legacy day remains legacy after spec changes',async()=>{
 const input=vocabularyInput(0),plan=await generateTaskPlan(input),groups=fixture.valid[1];
 plan.longTermAllocation={...allocation,practiceBudgetGroups:groups};input.previous=plan;
 assert.deepEqual(applyLongTermPlan(input,{spec:{...spec,practiceBudgetGroups:[]}}).longTermAllocation.practiceBudgetGroups,groups);
 delete plan.longTermAllocation;assert.equal(applyLongTermPlan(input,{spec:{...spec,practiceBudgetGroups:groups}}).longTermAllocation,undefined);
});
test('minimum reconciliation retains budget snapshot while preserving academic20 and speaking5',async()=>{
 const input=vocabularyInput(30),academic=input.catalog.subjects[0];academic.subjectId='academic';academic.words=academic.words.map(word=>({...word,subjectId:'academic'}));
 const speaking={...academic,subjectId:'speaking',name:'Speaking',words:academic.words.slice(0,5).map((word,i)=>({...word,subjectId:'speaking',itemKey:`speaking:${i}`,word:`speech${i}`}))};input.catalog.subjects.push(speaking);
 input.words.push(...speaking.words.map(word=>({lexemeKey:`en:${word.word}`,itemKeys:[word.itemKey],status:'unseen'})));
 const groups=[{...fixture.valid[1][0],subjectIds:['academic','speaking'],minutes:0}];
 input.longTermAllocation={...allocation,practiceBudgetGroups:groups};
 const next=reconcileDailyMinimums(input,{spec:{...spec,timeBudgetMode:'advisory',subjectsConfig:[{subjectId:'academic',dailyMinimumTarget:20},{subjectId:'speaking',dailyMinimumTarget:5}]}});
 const plan=await generateTaskPlan(next),view=practiceBudgetView(plan.tasks,undefined,0,[],[],[],groups);
 assert.deepEqual(next.longTermAllocation.practiceBudgetGroups,groups);
 assert.equal(view.visible.filter(t=>t.category==='new-word'&&t.subjectId==='academic').reduce((sum,t)=>sum+t.quantity,0),20);
 assert.equal(view.visible.filter(t=>t.category==='new-word'&&t.subjectId==='speaking').reduce((sum,t)=>sum+t.quantity,0),5);
});
test('old Companion cannot publish a budget-bearing allocation; capable server receives exact snapshot',async()=>{
 for(const capable of [false,true]){
   const calls=[],client=createCompanionPlanClient({baseUrl:'http://local',sessionToken:'synthetic',capabilities:['task-planning-v1','daily-plan-policy-v1'],fetcher:async(url,init={})=>{calls.push({url,init});return{ok:true,status:200,json:async()=>url.endsWith('/health')?{capabilities:capable?['practice-budget-v1']:[]}:{revision:{revision:1}}};}});
   const input=vocabularyInput(0);input.longTermAllocation={...allocation,practiceBudgetGroups:fixture.valid[1]};const plan=await generateTaskPlan(input);
   if(capable){await client.applyTaskPlan(plan,0,'synthetic');assert.deepEqual(JSON.parse(calls[1].init.body).candidate.longTermAllocation,plan.longTermAllocation);}
   else{await assert.rejects(client.applyTaskPlan(plan,0,'synthetic'),/共享练习预算/);assert.equal(calls.length,1);}
 }
});
