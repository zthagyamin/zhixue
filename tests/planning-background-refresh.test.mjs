import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import * as planning from '../src/application/planning/index.ts';
const file=new URL('../app/account-study-controls.tsx',import.meta.url);
async function cancellation(){const session=planning.createDailyPlanSession({scope:'old',day:'2026-09-19',read:async()=>{},project:async()=>null,publish(){}});session.dispose();return session.refresh().catch(error=>error);}
function refresh(read){
 const writes=[],epoch={current:0},bindings={refreshEpoch:epoch,refreshPlanState:()=>read(epoch),day:'2026-09-19',loaded:{facts:{contentCandidates:[]}},
  isPlanningReadCancelled:planning.isPlanningReadCancelled,client:{getPlanExecutions:async()=>({executions:[]}),getPlanOperations:async()=>({operations:[]}),getAiSettings:async()=>({serverAvailable:false,settings:{enabled:false}}),getContentDecisions:async()=>({operations:[]})},
  setExecution:value=>writes.push(value),setRestoreTarget:value=>writes.push(value),setAiServerAvailable:value=>writes.push(value),setAiEnabled:value=>writes.push(value),setCandidateDecisions:value=>writes.push(value)};
 return {writes,run:()=>tsxFunction(file,'refresh',bindings,{within:'AccountStudyPlan'})()};
}
test('a retired daily reader does not become a visible background plan error',async()=>{
 const retired=await cancellation(),f=refresh(async()=>{throw retired;});await f.run();assert.deepEqual(f.writes,[]);
});
test('a superseded background refresh cannot publish its late failure',async()=>{
 const f=refresh(async epoch=>{epoch.current++;throw Error('old read failure');});await f.run();assert.deepEqual(f.writes,[]);
});
test('a real failure of the current background refresh remains visible to its caller',async()=>{
 const f=refresh(async()=>{throw Error('connection unavailable');});await assert.rejects(f.run(),/connection unavailable/);assert.deepEqual(f.writes,[]);
});
