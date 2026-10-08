import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createDailyPlanSession,prepareMissingDailyPlan} from '../src/application/planning/index.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8'));
const snapshot=fixture.snapshot??fixture,day=snapshot.spec.startDate;
const goals={revision:1,enabled:true,snapshot,lastOperationId:'initial'};
const daily=(revision=0)=>({day,revision,currentPlan:null,approvedPlan:null,decision:'none'});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const project=async state=>({revision:state.revision});

test('background reads join one pending preparation for the same goal revision',async()=>{
 const gate=deferred();let reads=0,prepared=0;const views=[];
 const session=createDailyPlanSession({scope:'owner/library/day',day,read:async()=>{reads++;return daily();},project,
  prepare:async(state,revision,isCurrent)=>{prepared++;await gate.promise;assert.equal(isCurrent(),true);return {...state,revision};},publish:value=>views.push(value)});
 const a=session.refresh(1),b=session.refresh(1),background=session.refresh();gate.resolve();await Promise.all([a,b,background]);
 assert.equal(reads,1);assert.equal(prepared,1);assert.equal(views.at(-1).state.revision,1);assert.equal(session.snapshot().ready,true);
});

test('a superseded read rejects and never publishes its older day state',async()=>{
 const old=deferred();let calls=0;const session=createDailyPlanSession({scope:'owner/library/day',day,read:()=>++calls===1?old.promise:Promise.resolve(daily(3)),project,publish(){}});
 const first=session.refresh(),rejected=assert.rejects(first,/planning-scope-changed/);await session.refresh();old.resolve(daily(1));await rejected;
 assert.equal(session.snapshot().state.revision,3);
});

test('polling a lower revision cannot regress the approved source',async()=>{
 let value=daily(4);const session=createDailyPlanSession({scope:'owner/library/day',day,read:async()=>value,project,publish(){}});
 await session.refresh();value=daily(2);const read=await session.refresh();
 assert.equal(read.revision,4);assert.equal(session.snapshot().source.revision,4);
});

test('disposed scope cannot publish a late read or start another preparation',async()=>{
 const gate=deferred(),views=[];const session=createDailyPlanSession({scope:'old',day,read:()=>gate.promise,project,prepare:async()=>assert.fail('retired preparation'),publish:value=>views.push(value)});
 const pending=session.refresh(1),rejected=assert.rejects(pending,/planning-scope-changed/);session.dispose();const count=views.length;gate.resolve(daily());await rejected;
 assert.equal(views.length,count);await assert.rejects(session.refresh(),/planning-scope-changed/);
});

function automatic(overrides={}){
 const state=daily(),calls={writes:0,checks:0,goalReads:0};
 const ports={day,state,expectedLongTermRevision:1,isCurrent:()=>true,newId:()=> 'daily-operation',
  readGoals:async()=>{calls.goalReads++;return goals;},assertEvidence:async()=>{calls.checks++;},build:async()=>({plan:'synthetic'}),
  saveDraft:async()=>{calls.writes++;return {status:'accepted'};},readDay:async()=>({...daily(1),decision:'draft',currentPlan:{id:'draft'}}),...overrides};
 return {ports,calls};
}
test('automatic preparation uses two evidence checks and creates only an unapproved draft',async()=>{
 const f=automatic(),result=await prepareMissingDailyPlan(f.ports);
 assert.equal(f.calls.writes,1);assert.equal(f.calls.checks,2);assert.equal(f.calls.goalReads,2);assert.equal(result.decision,'draft');assert.equal(result.approvedPlan,null);
});
test('existing, rejected and cancelled days never reach the automatic write port',async()=>{
 for(const decision of ['draft','approved','rejected','cancelled']){
  const state={...daily(2),decision},f=automatic({state,readGoals:()=>assert.fail('must preserve existing day')});
  assert.equal(await prepareMissingDailyPlan(f.ports),state);assert.equal(f.calls.writes,0);
 }
});
test('a changed goal revision or cancelled source prevents the prepared daily write',async()=>{
 let reads=0;const f=automatic({readGoals:async()=>({...goals,revision:++reads})});
 assert.equal((await prepareMissingDailyPlan(f.ports)).revision,0);assert.equal(f.calls.writes,0);
 let current=true;const g=automatic({isCurrent:()=>current,build:async()=>{current=false;return {plan:'old'};}});
 assert.equal((await prepareMissingDailyPlan(g.ports)).revision,0);assert.equal(g.calls.writes,0);
});

test('account preparation honors the coordinator lease while its last goal read is pending',async()=>{
 const gate=deferred(),entered=deferred();let active=true,reads=0;
 const f=automatic({readGoals:async()=>{if(++reads===2){entered.resolve();await gate.promise;}return goals;}});
 const session=createDailyPlanSession({scope:'owner/library/day',day,read:async()=>daily(),project,publish(){},
  prepare:(state,revision,isCurrent)=>prepareMissingDailyPlan({...f.ports,state,expectedLongTermRevision:revision,isCurrent})});
 const pending=session.refresh(1,()=>active);await entered.promise;active=false;gate.resolve();await pending;
 assert.equal(f.calls.writes,0);assert.equal(session.snapshot().state.revision,0);
});

test('a new valid lease does not join a retired preparation promise',async()=>{
 const first=deferred();let reads=0,oldCurrent=true;
 const session=createDailyPlanSession({scope:'owner/library/day',day,read:()=>++reads===1?first.promise:Promise.resolve(daily()),project,publish(){},prepare:async state=>({...state,revision:1})});
 const old=session.refresh(1,()=>oldCurrent);oldCurrent=false;const fresh=session.refresh(1,()=>true);
 const outcomes=Promise.allSettled([old,fresh]);await Promise.resolve();assert.equal(reads,2);
 first.resolve(daily());const values=await outcomes;assert.deepEqual(values.map(value=>value.status),['rejected','fulfilled']);assert.equal(values[1].value.revision,1);
});
