import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {createSourceReader,readWorkspaceSnapshot,WorkspaceReadError} from '../src/application/sources/index.ts';
import {readStudyIdentity} from '../app/account-study-load-state.ts';
test('the real workspace effect does not hydrate personal storage after a failed identity response',async()=>{
  let reads=0;const phases=[],resolved=[],storage=[];
  const env={readStudyIdentity,fetch:async()=>Response.json({authenticated:false,user:null},{status:503}),workspaceIdForUser:()=>{reads++;return'guest:local';},migrateLegacyLocalStorage:()=>{reads++;},loadWorkspaceRecord:()=>{reads++;},
    setWorkspacePhase:value=>phases.push(value),setSessionResolved:value=>resolved.push(value),setStorageReady:value=>storage.push(value)};
  const ports=dashboardFunction('workspaceReader',{...env,identityRetry:0,readWorkspaceSnapshot,WorkspaceReadError,readWorkspaceSource:async()=>{reads++;}});
  const reader=createSourceReader({...ports,busy(){}});await reader.read();reader.dispose();
  assert.equal(reads,0);assert.equal(phases.at(-1),'identity-error');assert.ok(!resolved.includes(true));assert.ok(!storage.includes(true));
});
