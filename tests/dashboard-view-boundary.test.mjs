import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardDeclaredFunction,dashboardFunction,dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
test('the extracted view keeps private workspace content behind identity and storage readiness',()=>{
 const Gate=()=>null,render=dashboardDeclaredFunction('DashboardView',{StudyWorkspaceGate:Gate});
 for(const phase of ['checking-identity','loading-local','identity-error','storage-error']){const retry=()=>{},node=render({model:{workspacePhase:phase,retryWorkspace:retry}});assert.equal(node.type,Gate);assert.equal(node.props.phase,phase);assert.equal(node.props.onRetry,retry);}
});
test('workspace retry remains controller-owned and invalidates old readers before restarting',()=>{
 const calls=[],accountModeEpoch={current:4},fallbackData={publicFixture:true};let identity=2;
 const retry=dashboardFunction('retryWorkspace',{accountSources:{cancel:()=>calls.push('cancel-account')},workspaceReader:{cancel:()=>calls.push('cancel-workspace')},companionSource:{cancel(){}},syncCoordinator:{invalidate(){}},legacyCloud:{invalidate(){}},accountModeEpoch,setStorageReady:v=>calls.push(['storage',v]),setSessionResolved:v=>calls.push(['session',v]),setSessionUser:v=>calls.push(['user',v]),setWorkspacePhase:v=>calls.push(['phase',v]),setData:v=>calls.push(['data',v]),fallbackData,setIdentityRetry:fn=>identity=fn(identity)});
 assert.equal(dashboardJsxProp('StudyWorkspaceGate','onRetry',{retryWorkspace:retry}),retry);retry();assert.equal(calls[0],'cancel-account');assert.equal(calls.filter(value=>value==='cancel-account').length,1);assert.ok(calls.includes('cancel-workspace'));assert.equal(accountModeEpoch.current,5);assert.equal(identity,3);assert.deepEqual(calls.at(-1),['data',fallbackData]);
});
