import assert from 'node:assert/strict';
import test from 'node:test';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';

test('reference preview has a real twenty-word plan, two subject tasks and eight completed words',async t=>{
 const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin,scenario:'visual-reference'});t.after(()=>f.close());
 const c=createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
 const state=await c.getPlanState(f.day),loaded=await c.load();
 assert.equal(state.approvedPlan.tasks.find(t=>t.category==='new-word').quantity,20);
 assert.equal(state.approvedPlan.tasks.filter(t=>t.category==='subject').length,2);
 assert.equal(loaded.records.filter(r=>r.record.event.attempt?.stageAfter===3).length,8);
});
