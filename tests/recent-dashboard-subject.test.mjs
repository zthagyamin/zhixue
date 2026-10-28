import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createHooks,loader,deferred,tick} from './helpers/causal-harness.mjs';
const {recentDashboardSubject}=loadTsx(new URL('../app/study-dashboard/planning-source-adapter.ts',import.meta.url));
const subjects=[{id:'s',items:[{accountItemKey:'a',contentHash:'v1'}]},{id:'t',items:[{accountItemKey:'b',contentHash:'v1'}]}];
const record=(key,time='2026-10-28T10:00:00Z')=>({provenanceMode:'verified-round',libraryId:'lib',snapshotId:'snap',contentHash:'v1',event:{eventType:'practice-attempt',eventId:key,coreHash:key,occurredAt:time,item:{key}}});
const account=records=>({bundle:{snapshot:{libraryId:'lib'}},bundles:[{snapshot:{libraryId:'lib',snapshotId:'snap'},items:[{itemKey:'a',contentHash:'v1'},{itemKey:'b',contentHash:'v1'}]}],records:records.map(record=>({record}))});
test('recent subject adapter keeps current library and exact historical content binding',()=>{
 assert.deepEqual(recentDashboardSubject(account([record('a')]),subjects,true),{kind:'available',subjectId:'s'});
 assert.deepEqual(recentDashboardSubject(account([{...record('a'),contentHash:'old'}]),subjects,true),{kind:'unavailable'});
 assert.deepEqual(recentDashboardSubject(account([{...record('a'),libraryId:'another'}]),subjects,true),{kind:'none'});
 assert.deepEqual(recentDashboardSubject(account([record('a')]),subjects,false),{kind:'checking'});
});
test('latest durable but not-yet-uploaded account answer wins over older cloud history',()=>{
 const local=[{payload:{route:{kind:'account',record:record('b','2026-10-28T11:00:00Z')}}}];
 assert.deepEqual(recentDashboardSubject(account([record('a')]),subjects,true,local),{kind:'available',subjectId:'t'});
});
test('local recent subject requires exact native binding instead of the word key alone',()=>{
 const event={eventType:'practice-attempt',eventId:'native',coreHash:'core',occurredAt:'2026-10-28T11:00:00Z',item:{key:'a'}};
 const binding={eventId:'native',coreHash:'core',contentHash:'v1',localBindingHash:'bound'};
 const local=[{payload:{core:{event},route:{kind:'local',binding}}}];
 const current=[{id:'s',items:[{accountItemKey:'a',contentHash:'v1',localBindingHash:'bound'}]}];
 assert.deepEqual(recentDashboardSubject(null,current,true,local),{kind:'available',subjectId:'s'});
 assert.deepEqual(recentDashboardSubject(null,subjects,true,local),{kind:'unavailable'});
 assert.deepEqual(recentDashboardSubject(null,current,true,local,[{...event,eventId:'newer-unbound',occurredAt:'2026-10-28T12:00:00Z'}]),{kind:'unavailable'});
});
test('late recent-history results cannot replace a different current workspace',async()=>{
 const hooks=createHooks(),useRecent=loader(hooks.api)('app/study-dashboard/planning-source-adapter.ts').useRecentDashboardSubject;
 const old=deferred(),latest=deferred();
 const journal={list:owner=>owner==='account:a'?old.promise:latest.promise};
 const props={account:account([]),subjects,historyVerified:true,workspaceId:'account:a',sourceScope:'scope',journal,revision:1};
 hooks.mount(useRecent,props);hooks.flush();
 hooks.render({...props,workspaceId:'account:b'});hooks.flush();
 latest.resolve([{payload:{route:{kind:'account',record:record('b')}}}]);await tick();hooks.render({...props,workspaceId:'account:b'});
 assert.deepEqual(hooks.view(),{kind:'available',subjectId:'t'});
 old.resolve([{payload:{route:{kind:'account',record:record('a')}}}]);await tick();hooks.render({...props,workspaceId:'account:b'});
 assert.deepEqual(hooks.view(),{kind:'available',subjectId:'t'});hooks.unmount();
});
test('previous verified subject is withheld while source scope or history changes',async()=>{
 const hooks=createHooks(),useRecent=loader(hooks.api)('app/study-dashboard/planning-source-adapter.ts').useRecentDashboardSubject;
 const props={account:account([record('a')]),subjects,historyVerified:true,workspaceId:'account:a',sourceScope:'scope',journal:{list:async()=>[]},revision:1};
 hooks.mount(useRecent,props);hooks.flush();await tick();hooks.render();assert.deepEqual(hooks.view(),{kind:'available',subjectId:'s'});
 hooks.render({...props,sourceScope:'new-source'});assert.equal(hooks.view().kind,'checking');
 hooks.render({...props,historyVerified:false});assert.equal(hooks.view().kind,'checking');hooks.unmount();
});
