import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,nodes,text,deferred,tick} from './helpers/causal-harness.mjs';
import {dashboardDeclaredFunction,dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {createSourceChanges} from '../src/application/sources/index.ts';

test('every AI status entry opens the dedicated settings panel without entering the daily planner',()=>{
 for(const state of [{settingsUsesAccount:false,accountLoaded:null},{settingsUsesAccount:true,accountLoaded:null},{settingsUsesAccount:true,accountLoaded:{}}]){
  const trace=[];
  dashboardDeclaredFunction('openSettingsAi',{...state,accountWorkspaceId:'account:synthetic',setAiEntryOpen:v=>trace.push(['ai',v]),setAccountAiEntryOwner:v=>trace.push(['planner',v]),setTab:v=>trace.push(['tab',v]),setSourceView:v=>trace.push(['source',v])})();
  assert.deepEqual(trace,[['ai',true]]);
 }
});

test('unpaired note entry executes its connection navigation callback rather than a missing hash target',()=>{
 const hooks=createHooks(),mod=loader(hooks.api)('app/note-sources-panel.tsx');let connected=0;
 const props={endpoint:'http://127.0.0.1:59999',token:null,capabilities:[],onChanged(){},onDetected(){},onConnect:()=>connected++};
 const wrapper=mod.NoteSourcesPanel(props);hooks.mount(wrapper.type,wrapper.props);hooks.flush();
 const action=[...nodes(hooks.view())].find(n=>text(n)==='先安装并配对 →');
 assert.ok(action);assert.equal(action.type,'button');action.props.onClick();assert.equal(connected,1);hooks.unmount();
});

function changesFixture(overrides={}){
 const messages=[],errors=[],loading=[],published=[];
 const ports={current:()=>true,connected:()=>true,account:()=>false,list:async()=>({changes:[]}),scan:async()=>({changes:[],scannedAt:'2026-10-26T00:00:00Z'}),decide:async()=>{},source:async()=>({}),apply:()=>true,publish:v=>published.push(v),loading:v=>loading.push(v),deciding(){},message:v=>messages.push(v),scanError:v=>errors.push(v),...overrides};
 return{ports,api:createSourceChanges(ports),messages,errors,loading,published};
}
test('an unconnected scan explains its prerequisite without issuing a request',async()=>{
 let reads=0;const f=changesFixture({connected:()=>false,scan:async()=>{reads++;return{changes:[]};}});await f.api.scan();
 assert.equal(reads,0);assert.match(f.messages.at(-1),/连接/);assert.equal(f.loading.length,0);
});
test('a completed scan distinguishes no changes from changes found and reports completion locally',async()=>{
 const empty=changesFixture();await empty.api.scan();assert.match(empty.messages.at(-1),/未发现|没有/);assert.deepEqual(empty.loading,[true,false]);
 const changed=changesFixture({scan:async()=>({changes:[{changeId:'synthetic'}]})});await changed.api.scan();assert.match(changed.messages.at(-1),/1/);assert.equal(changed.published[0].changes.length,1);
});
test('background source lists cannot supersede an explicit scan or clear its progress',async()=>{
 const pending=deferred();let lists=0;
 const f=changesFixture({list:async()=>{lists++;return{changes:[]};},scan:()=>pending.promise});
 const scan=f.api.scan();await tick();const background=f.api.read();await tick();
 assert.equal(lists,0);assert.deepEqual(f.loading,[true]);
 pending.resolve({changes:[{changeId:'new-source'}]});await Promise.all([scan,background]);
 assert.equal(f.published.at(-1).changes.length,1);assert.match(f.messages.at(-1),/1/);assert.deepEqual(f.loading,[true,false]);
});
test('a scan failure still reaches its page after a background read attempted to run',async()=>{
 const pending=deferred(),f=changesFixture({scan:()=>pending.promise});
 const scan=f.api.scan();await tick();const background=f.api.read();pending.reject(Error('synthetic access denied'));await Promise.all([scan,background]);
 assert.deepEqual(f.errors,['synthetic access denied']);assert.deepEqual(f.loading,[true,false]);
});
test('a decision waits for an older scan then reads fresh candidates instead of reusing its stale list',async()=>{
 const pending=deferred();let lists=0;
 const f=changesFixture({scan:()=>pending.promise,list:async()=>{lists++;return{changes:[]};}});
 const scan=f.api.scan();await tick();const decision=f.api.decide('approved-source','approved');await tick();
 pending.resolve({changes:[{changeId:'approved-source'}]});await Promise.all([scan,decision]);
 assert.equal(lists,1);assert.deepEqual(f.published.at(-1).changes,[]);assert.match(f.messages.at(-1),/已批准/);
});
test('a scan error is routed to the current sources message rather than the hidden daily-plan message',async()=>{
 const sourceMessages=[],planMessages=[],connection={};
 const ports=dashboardFunction('sourceChanges',{workspaceId:'account:a',companionPlanClient:{scanChanges:async()=>{throw Error('synthetic permission failure');}},companionSession:connection,getCompanionSession:()=>connection,taskWorkspaceRef:{current:'account:a'},accountLoadedRef:{current:null},setChangeCandidates(){},setLastChangeScan(){},setChangesLoading(){},setChangeDecisionId(){},setChangeDecisionMessage:v=>sourceMessages.push(v),setPlanMessage:v=>planMessages.push(v)});
 await createSourceChanges(ports).scan();assert.match(sourceMessages.at(-1),/synthetic permission failure/);assert.deepEqual(planMessages,[]);
});

function aiFixture(options){
 const hooks=createHooks(),use=loader(hooks.api)('src/features/sources/use-settings-ai-read.ts').useSettingsAiRead;
 const render=()=>{hooks.render(options);hooks.flush();};hooks.mount(use,options);hooks.flush();
 return{hooks,options,render,api:()=>hooks.view()};
}
test('entering connection settings reads current AI configuration without recovery exports or model requests',async()=>{
 let reads=0;const value={serverAvailable:true,settings:{revision:1,enabled:true,configured:true}};
 const f=aiFixture({scope:'account:A/library:A',resource:{},enabled:true,active:true,read:async()=>{reads++;return value;}});
 await tick();f.render();assert.equal(reads,1);assert.equal(f.api().phase,'ready');assert.deepEqual(f.api().value,value);assert.ok(f.api().checkedAt);f.hooks.unmount();
});
test('an inactive/local AI view does not read account configuration',async()=>{
 let reads=0;const f=aiFixture({scope:'local:A',resource:{},enabled:false,active:true,read:async()=>{reads++;return{};}});await tick();f.render();assert.equal(reads,0);assert.equal(f.api().value,null);f.hooks.unmount();
});
test('AI read failure remains unknown and can be explicitly retried',async()=>{
 let failed=true;const f=aiFixture({scope:'A',resource:{},enabled:true,active:true,read:async()=>{if(failed)throw Error('offline');return{configured:false};}});
 await tick();f.render();assert.equal(f.api().phase,'failed');assert.equal(f.api().value,null);failed=false;await f.api().refresh();f.render();assert.equal(f.api().phase,'ready');assert.deepEqual(f.api().value,{configured:false});f.hooks.unmount();
});
test('AI results cannot cross owners or replace a later successful read',async()=>{
 const old=deferred();const options={scope:'A',resource:{},enabled:true,active:true,read:()=>old.promise};const f=aiFixture(options);
 options.scope='B';options.resource={};options.read=async()=>({owner:'B'});f.render();await tick();f.render();assert.deepEqual(f.api().value,{owner:'B'});
 old.resolve({owner:'A'});await tick();f.render();assert.deepEqual(f.api().value,{owner:'B'});f.hooks.unmount();
});
test('saving a new settings revision refreshes the connection view without visiting sync',async()=>{
 let reads=0;const options={scope:'A',resource:{},enabled:true,active:true,revision:1,read:async()=>({revision:++reads})};const f=aiFixture(options);
 await tick();f.render();assert.equal(f.api().value.revision,1);options.revision=2;f.render();await tick();f.render();assert.equal(f.api().value.revision,2);f.hooks.unmount();
});
test('local AI overview observes current workspace settings and rereads them without account traffic',async()=>{
 const hooks=createHooks();let reloads=0,accountReads=0;
 const workspace={scope:{mode:'local',ownerId:'A',libraryId:'L'},settings:{revision:1,configured:true,enabled:true},error:'',reload:async()=>{reloads++;}};
 const load=loader(hooks.api,{'app/components/ai-sidebar/study-ai-workspace.tsx':{useOptionalStudyAIWorkspace:()=>workspace},'app/components/ai-sidebar/index.ts':{StudyAISettings:()=>null}});
 const Component=load('app/study-dashboard/settings-ai-panels.tsx').SettingsAiOverview;
 const props={scope:'A/L',resource:{},account:false,signedIn:true,localOnline:true,read:async()=>{accountReads++;throw Error('must not read account');},fallback:{label:'已配置',detail:'old study-data status',tone:'good'},onOpen(){}};
 hooks.mount(Component,props);hooks.flush();await tick();hooks.render(props);hooks.flush();
 workspace.settings={revision:2,configured:true,enabled:false};hooks.render(props);hooks.flush();
 assert.match(text(hooks.view()),/未启用/);assert.equal(accountReads,0);assert.equal(reloads,1);
 const refresh=[...nodes(hooks.view())].find(n=>n.type==='button'&&text(n)==='重新核对 AI 状态');assert.ok(refresh);await refresh.props.onClick();assert.equal(reloads,2);hooks.unmount();
});
