import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmPlanAndPrepareStart,createPlanConfirmationSession} from '../src/application/planning/index.ts';
const draft={day:'2026-09-17',cloudPlanHash:'shown-plan',catalogHash:'catalog',tasks:[{taskId:'one',title:'Q',action:{kind:'practice'}}]};
function fixture(options={}){
 const state={day:draft.day,revision:4,currentPlan:draft,approvedPlan:null,approvedOperationId:null},trace=[];let active=true,reads=0;
 const approved={...state,revision:5,approvedPlan:draft,approvedOperationId:'approval'};
 const source={cloud:draft,plan:{planHash:'engine'},catalog:{sourceHash:'source'}};
 const ports={validateDraft:async()=>trace.push('source'),assertEvidence:async()=>trace.push('evidence'),
  approve:async command=>{trace.push(command);return{status:options.status??'accepted'};},
  readState:async()=>{trace.push('read');reads++;return options.read?.(reads,approved)??approved;},
  prepareSource:async()=>source,loadActivity:async()=>({completedTaskIds:options.done?['one']:[],startedTaskIds:[],pendingItemByTask:{one:'item-b'}}),...options.ports};
 return {trace,state,ports,setCurrent:value=>active=value,run:()=>confirmPlanAndPrepareStart({state,day:draft.day,isCurrent:()=>active,newId:()=> 'approval'},ports)};
}
test('confirm and start verifies evidence and matching receipt twice before selecting a resumable task',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.taskId,'one');assert.equal(result.resumeItemKey,'item-b');
 assert.equal(f.trace.filter(x=>x==='evidence').length,2);assert.equal(f.trace.filter(x=>x==='read').length,2);
 assert.deepEqual(f.trace.find(x=>typeof x==='object'),{action:'approve',operationId:'approval',expectedRevision:4,day:draft.day,planHash:'shown-plan',predecessorOperationId:null});
});
for(const read of [(_n,s)=>({...s,approvedOperationId:'other'}),(_n,s)=>({...s,revision:4}),(_n,s)=>({...s,approvedPlan:{...draft,cloudPlanHash:'other'}}),(n,s)=>n===2?{...s,revision:6}:s])test('unmatched or changed approval receipt cannot produce an entry',async()=>{
 await assert.rejects(fixture({read}).run());
});
test('cancelled confirmation cannot continue from a late successful approval',async()=>{
 const f=fixture({ports:{approve:async()=>{f.setCurrent(false);return{status:'accepted'};}}});assert.equal(await f.run(),null);assert.equal(f.trace.includes('read'),false);
});
test('no executable task remains a confirmed plan, never a fabricated start',async()=>{await assert.rejects(fixture({done:true}).run(),/没有未完成/);});

test('the confirmation session reuses its logical approval ID after a lost response',async()=>{
 let ids=0,lost=true;const commands=[],session=createPlanConfirmationSession(()=> 'approval-'+(++ids));
 const f=fixture({read:(_n,state)=>({...state,approvedOperationId:'approval-1'}),ports:{approve:async command=>{commands.push(command);if(lost){lost=false;throw Error('reply lost');}return{status:'duplicate'};}}});
 const input={scope:'owner/library',state:f.state,day:draft.day,isCurrent:()=>true};
 await assert.rejects(session.run(input,f.ports),/reply lost/);const result=await session.run(input,f.ports);
 assert.equal(result.taskId,'one');assert.equal(ids,1);assert.deepEqual(commands[0],commands[1]);
});

test('approval cannot start a withheld material as though it were a question',async()=>{
 const f=fixture({ports:{loadActivity:async()=>({completedTaskIds:[],startedTaskIds:[],pendingItemByTask:{},withheldTaskIds:['one']})}});
 await assert.rejects(f.run(),/没有未完成/);
});

test('confirmed account start applies shared capacity before choosing its first task',async()=>{
 const plan={...draft,tasks:[{...draft.tasks[0],subjectId:'papers',category:'review'},{...draft.tasks[0],taskId:'other',subjectId:'other',category:'review'}],longTermAllocation:{practiceBudgetGroups:[{id:'g',title:'shared',subjectIds:['papers'],minutes:0,defaultItemMinutes:3}]}};
 const f=fixture({ports:{prepareSource:async()=>({cloud:plan})}});
 assert.equal((await f.run()).taskId,'other');
});
