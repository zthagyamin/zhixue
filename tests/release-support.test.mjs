import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {parseRelease,makeDiagnosticReport} from '../app/release-support-model.ts';
import {openStudyDb,saveWorkspaceRecord} from '../app/local-study-db.ts';

test('release checks reject malformed and unsupported responses',()=>{
  assert.equal(parseRelease({schemaVersion:2,version:'1.2.3'}),null);
  assert.equal(parseRelease({schemaVersion:1,version:'<script>'}),null);
  assert.equal(parseRelease({schemaVersion:1,version:'1.2.3'}),'1.2.3');
});
test('diagnostics only contain allowlisted values, never raw input or route identifiers',()=>{
  const report=makeDiagnosticReport({version:'1.2.3',companionVersion:'token-secret',pathname:'/study/private-note?token=secret',userAgent:'Mozilla Chrome/140.0 secret-value',digest:'secret value',now:new Date('2026-09-09T00:00:00Z')});
  assert.match(report,/Chrome 140/);assert.doesNotMatch(report,/secret|private-note|token/);
  assert.match(report,/未知/);
});
test('open database yields to an upgrade without deleting saved records',async()=>{
  globalThis.indexedDB=new IDBFactory();
  await saveWorkspaceRecord('test','progress',{answer:'retained'});
  const held=await openStudyDb();
  const newer=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-local-study-v1',4);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('upgrade blocked'));});
  const row=await new Promise((resolve,reject)=>{const r=newer.transaction('workspace-records').objectStore('workspace-records').get('test:progress');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  assert.deepEqual(row.value,{answer:'retained'});held.close();newer.close();
});
test('blocked open rejects promptly and closes its late connection',async()=>{
  globalThis.indexedDB=new IDBFactory();
  const old=await new Promise(resolve=>{const r=indexedDB.open('zhixue-local-study-v1',1);r.onsuccess=()=>resolve(r.result);});
  await assert.rejects(openStudyDb(),/其他标签页/);old.close();
  const newest=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-local-study-v1',4);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('leaked connection'));});newest.close();
});
