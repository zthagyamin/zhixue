import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareMissingDailyPlan} from '../src/application/planning/automatic-day.ts';
const snapshot=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8')).snapshot;
const day=snapshot.spec.startDate,initial={day,revision:4,decision:'none',currentPlan:null,approvedPlan:null};
const candidate={cloudPlanHash:'one'},read={...initial,revision:5,decision:'draft',currentPlan:candidate};
function setup({status='accepted',after=read,current=()=>true}={}){
 const seen=[];
 return {seen,ports:{state:initial,day,expectedLongTermRevision:1,isCurrent:current,newId:()=> 'id',readGoals:async()=>({enabled:true,revision:1,snapshot}),assertEvidence:async()=>{},build:async()=>candidate,saveDraft:async()=>({status}),readDay:async()=>after,
  matchesCreated:(plan,result,before)=>result.day===before.day&&result.revision===before.revision+1&&result.currentPlan?.cloudPlanHash===plan.cloudPlanHash,
  onCreated:(plan,result)=>seen.push({plan,result})}};
}
test('only an accepted save with matching readback and current scope publishes origin evidence',async()=>{
 const ok=setup();await prepareMissingDailyPlan(ok.ports);assert.equal(ok.seen.length,1);
 for(const c of [{status:'stale'},{status:'duplicate'},{after:{...read,revision:6}},{after:{...read,currentPlan:{cloudPlanHash:'other'}}},{current:()=>false}]){
   const scenario=setup(c);await prepareMissingDailyPlan(scenario.ports);assert.equal(scenario.seen.length,0);
 }
});
test('retired scope after accepted write cannot publish origin',async()=>{
 let current=true;const scenario=setup({current:()=>current});
 scenario.ports.readDay=async()=>{current=false;return read;};
 await prepareMissingDailyPlan(scenario.ports);assert.equal(scenario.seen.length,0);
});
