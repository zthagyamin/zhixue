import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const sample=JSON.parse(await readFile(new URL('./fixtures/task-event-v1.json',import.meta.url),'utf8'));
let api;
try {api=await import('../app/task-event-v1.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
function parse(value) {assert.equal(typeof api?.parseTaskEvent,'function');return api.parseTaskEvent(value);}
test('task event wire contract and canonical hash match the shared golden fixture',async()=>{
  assert.deepEqual(parse(sample),sample);
  const {coreHash,...body}=sample;
  assert.equal(await api.hashTaskEvent(body),coreHash);
});
test('task reports reject extra mastery, malformed dates, duplicate units and invented evidence shapes',()=>{
  assert.equal(typeof api?.parseTaskEvent,'function');
  for(const change of [{mastery:'mastered'},{schemaVersion:3},{eventType:'practice-attempt'},
    {day:'2026-08-30'},{occurredAt:'2026-08-31T02:00:00Z'},{unitIds:['u','u']},{eventId:'a'},
    {source:'evidence',evidenceRefs:[]},{source:'evidence',evidenceRefs:['event-001'],unitIds:[]},
    {source:'self-report',evidenceRefs:['event-001']},{coreHash:'bad'},{eventId:[sample.eventId]}]) {
    assert.throws(()=>parse({...sample,...change}));
  }
});
test('Shanghai day is verified independently of UTC date',()=>{
  assert.equal(parse({...sample,occurredAt:'2026-08-30T16:00:00.000Z'}).day,'2026-08-31');
  assert.throws(()=>parse({...sample,occurredAt:'2026-08-30T15:59:59.999Z'}));
});
