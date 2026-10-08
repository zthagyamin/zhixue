import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {stableStudyItemKey,resolveStudyItemProgressKey,normalizeDynamicSubjects} from '../app/dynamic-ui-model.ts';
import {filterPlanSubject,selectPlannedPractice} from '../app/plan-runtime.ts';
import {assertPlanningStudySources} from '../app/task-plan-runtime.ts';
import {accountStudyPayload} from '../app/account-study-payload.ts';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {ensureAccountStudyRecord} from '../app/account-study-record-client.ts';
import {putLocalStudySnapshot} from '../app/local-account-study.ts';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
const item={id:'source-id',itemId:'source-id',accountItemKey:'opaque-question',accountSnapshotId:'snapshot',contentHash:'a'.repeat(64),prompt:'Question',options:['A','B'],answer:'A'};
test('account item identity is never reconstructed from an item ID or a legacy progress alias',()=>{
  assert.equal(stableStudyItemKey(item),'opaque-question');
  assert.equal(resolveStudyItemProgressKey(item,0,{itemStages:{'word:source-id':3,'practice:source-id':3},fsrsData:{}}),'opaque-question');
});
test('planned account questions use exact manifest identities rather than prefix aliases',()=>{
  const first={...item,accountItemKey:'practice:opaque'},second={...item,accountItemKey:'opaque',contentHash:'b'.repeat(64)};
  const subject={id:'reading',name:'Reading',pluginType:'quiz',items:[first,second]},entry={itemKey:'practice:opaque',kind:'study',domain:'reading',estimatedMinutes:0,reasons:[],title:'Q',practice:{kind:'question',subjectId:'reading',count:1,itemKeys:['practice:opaque'],itemIds:['opaque']}};
  assert.deepEqual(filterPlanSubject(subject,{items:[entry]},[subject]),[first]);
});
test('source validation and practice conversion preserve an explicit account key',()=>{
  const subject={id:'reading',name:'Reading',pluginType:'quiz',items:[item]};
  const catalog={subjects:[{subjectId:'reading',words:[]}],practiceSources:[{subjectId:'reading',itemKey:'opaque-question',sourceHash:item.contentHash}]};
  const task={subjectId:'reading',action:{kind:'practice',itemKeys:['opaque-question']}};
  assert.doesNotThrow(()=>assertPlanningStudySources(catalog,[subject],task));
  const entry={itemKey:'opaque-question',kind:'study',domain:'reading',estimatedMinutes:0,reasons:[],title:'Q',practice:{kind:'question',subjectId:'reading',count:1,itemKeys:['opaque-question']}};
  const [converted]=selectPlannedPractice(entry,[subject],[]);assert.equal(converted.accountItemKey,'opaque-question');assert.equal(converted.accountSnapshotId,'snapshot');
});
test('a rendered non-prefixed reading key can produce a durable record accepted by the real account API',async t=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin,scenario:'all-plugins'});t.after(()=>f.close());
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
  const loaded=await client.load();await putLocalStudySnapshot('account:test',loaded.bundle,0);
  const subject=normalizeDynamicSubjects(accountStudyPayload(loaded,'workspace').subjects).find(subject=>subject.id==='reading'),shown=subject.items[0];
  const key=resolveStudyItemProgressKey(shown,0,{itemStages:{},fsrsData:{}}),event=await attempt('identity-ui-event',new Date().toISOString(),0,3,true,{item:{kind:'due',key}});
  const record=await ensureAccountStudyRecord({workspaceId:'account:test',bundle:loaded.bundle,event,originDeviceId:'identity-device',practiceMode:'quiz'});
  const result=await client.appendRecords([record]);assert.equal(result.results[0].durable,true);
  assert.equal((await client.load()).records[0].record.event.item.key,'question-one');
});
