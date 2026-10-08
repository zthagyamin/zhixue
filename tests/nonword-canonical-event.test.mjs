import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudyAttemptSession} from '../src/application/study-attempt/session.ts';

test('reserved nonword event identity survives failed saves; old writers retain defaults',async()=>{
  let defaultIds=0, defaults=0;
  const session=createStudyAttemptSession({binding:{scopeKey:'scope',itemBinding:'item',mode:'quiz'},gate:{begin:()=>1,commit:()=>true,fail(){}},newId:()=>{defaultIds++;return 'default';},now:()=>{defaults++;return '2026-10-05T01:00:00Z';}});
  const identity={eventId:'reserved-first',reviewedAt:'2026-10-05T00:00:00Z'}, captures=[];
  const first=await session.submit({identity,intent:'again',current:()=>true,execute(request){captures.push(request.identity);throw Error('save failed');}});
  assert.equal(first.status,'failed');
  const changed=await session.submit({identity:{...identity,eventId:'replacement'},intent:'again',current:()=>true,execute(){assert.fail('must not persist a different event');}});
  assert.equal(changed.status,'conflict');
  const retry=await session.submit({identity,intent:'again',current:()=>true,execute(request,control){captures.push(request.identity);control.durable();}});
  assert.equal(retry.status,'saved');
  assert.deepEqual(captures,[identity,identity]);
  assert.equal(defaultIds+defaults,0);
});
