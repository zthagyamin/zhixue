import test from 'node:test';
import assert from 'node:assert/strict';
import {startAutomaticDayPreview} from './fixtures/automatic-day-preview.mjs';

test('automatic-plan fixture seeds actual account goals on the learning day across midnight and four',async()=>{
 const cases=[
  ['2026-10-08T15:59:59.999Z','2026-10-08'],
  ['2026-10-08T16:00:00.000Z','2026-10-08'],
  ['2026-10-08T19:59:59.999Z','2026-10-08'],
  ['2026-10-08T20:00:00.000Z','2026-10-09']
 ];
 for(const [index,[now,day]] of cases.entries()){
  const preview=await startAutomaticDayPreview({port:46310+index,devPort:46320,now});
  try{
   assert.equal(preview.day,day);
   const state=await preview.state();assert.equal(state.day,day);
   const goals=await preview.goals();assert.equal(goals.enabled,true);assert.equal(goals.snapshot.spec.planId,'automatic-browser');
   assert.equal(preview.inspect().records,0);assert.deepEqual(preview.inspect().aiRequests,[]);
  }finally{await preview.close();}
 }
});
