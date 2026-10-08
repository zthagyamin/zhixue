import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {saveWorkspaceRecord,loadWorkspaceRecord,clearAccountWorkspaceRecords} from '../app/local-study-db.ts';
test('clearing derived account caches preserves original rules, drafts, device identity and outboxes',async()=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const keep=['progress','module-catalog','pending-activities','cloud-outbox','plugin-overrides','plan-constraints','task-plan-drafts','task-plan-backups','account-study-preference','account-study-device','account-plan-ai-requests','account-question-ai-requests'];
  const derived=['practice-cache','task-planning-cache'];
  for(const kind of [...keep,...derived])await saveWorkspaceRecord('account:a',kind,{sentinel:kind});
  await saveWorkspaceRecord('account:b','practice-cache',{sentinel:'other account'});await clearAccountWorkspaceRecords('account:a');
  for(const kind of keep)assert.deepEqual(await loadWorkspaceRecord('account:a',kind,null),{sentinel:kind},kind+' is not disposable cache');
  for(const kind of derived)assert.equal(await loadWorkspaceRecord('account:a',kind,null),null);
  assert.deepEqual(await loadWorkspaceRecord('account:b','practice-cache',null),{sentinel:'other account'});
});
