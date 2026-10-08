import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardSourceSync} from './helpers/dashboard-source.mjs';
const m=await import('../app/sandbox-pacing.ts').catch(()=>({}));
test('public sandbox is deterministic, bounded by global quotas, and produces actual FSRS reviews',()=>{
 assert.equal(typeof m.simulateSandboxPacing,'function');
 for(const days of [3,7,14])for(const quota of [3,6,9]){
  const input={today:'2026-09-08',days,quota,scenario:'normal'},p=m.simulateSandboxPacing(input);
  assert.deepEqual(p,m.simulateSandboxPacing(input));assert.equal(p.snapshot.totalInventoryCount,18);
  assert.equal(p.snapshot.schedule.length,days);
  assert.ok(p.snapshot.schedule.every(s=>s.newItemIds.length<=quota));
  assert.equal(p.playableIds.length,quota);
  if(days===14)assert.ok(p.snapshot.schedule.some(s=>s.reviewItemIds.length>0));
 }
});
test('applying slices public fixtures only and the exercise entry shares the filtered source',()=>{
 const source=[{id:'ielts-vocabulary',items:Array.from({length:12},(_,i)=>({word:`word${i}`}))},{id:'python-basics',items:Array.from({length:6},(_,i)=>({id:`py${i}`}))}];
 const copy=structuredClone(source),ids=m.simulateSandboxPacing({today:'2026-09-08',days:7,quota:6,scenario:'normal'}).playableIds;
 assert.deepEqual(m.sandboxVisibleSubjects(source,source,ids,true).map(s=>s.items.length),[4,2]);
 assert.strictEqual(m.sandboxVisibleSubjects(copy,source,ids,true),copy);
 assert.strictEqual(m.sandboxVisibleSubjects(source,source,ids,false),source);
 assert.strictEqual(m.sandboxVisibleSubjects(source,source,null,true),source);
 assert.deepEqual(source,copy);
 const dashboard=readDashboardSourceSync();
 assert.match(dashboard,/const moduleSubjects=accountLoaded&&accountModuleSource[\s\S]*?: demoVisibleSubjects;/);
});
test('adding notes and missing a day rebalance simulated history only',()=>{
 const input={today:'2026-09-08',days:7,quota:6};
 const base=m.simulateSandboxPacing({...input,scenario:'normal'});
 const added=m.simulateSandboxPacing({...input,scenario:'add'});
 assert.equal(added.snapshot.totalInventoryCount,24);
 assert.deepEqual(added.snapshot.schedule[0],base.snapshot.schedule[0]);
 const missed=m.simulateSandboxPacing({...input,scenario:'miss'});
 assert.equal(missed.snapshot.asOfDate,'2026-09-10');
 assert.ok(missed.snapshot.activeDriftDays<0);
 assert.ok(missed.playableIds.every(id=>!id.includes('extra')));
 assert.equal(m.simulateSandboxPacing({...input,scenario:'normal'}).snapshot.totalInventoryCount,18);
 assert.throws(()=>m.simulateSandboxPacing({...input,quota:100,scenario:'normal'}));
});
