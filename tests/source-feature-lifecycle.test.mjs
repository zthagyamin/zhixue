import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,deferred,tick} from './helpers/causal-harness.mjs';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {createLegacyCloudSession} from '../src/application/sync/index.ts';
const timers={setTimeout:()=>1,clearTimeout(){},setInterval:()=>2,clearInterval(){}};
const recovery={complete:true,pending:{coreUploads:[],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false},payload:{accountLibraries:[]}};
function mount(file,name,options){
 const hooks=createHooks(),use=loader(hooks.api,{},timers)(file)[name];hooks.mount(use,options);hooks.flush();
 return{hooks,options,api:()=>hooks.view(),render(){hooks.render(options);hooks.flush();}};
}
test('actual Root connection scope and hook preserve pairing when only account-library metadata arrives',async()=>{
 const waiting=deferred(),entered=deferred(),notices=[];
 const rootScope=accountWanted=>dashboardFunction('companionSource',{workspaceId:'A',accountWanted,accountLibraryId:accountWanted?'library':null,publishCompanionNotice(){}}).scope;
 const options={scope:rootScope(false),connection:null,retry:0,retryMs:5000,capture:()=>({key:'A',connection:null,current:()=>true,user:{userId:'a'},code:'test',account:()=>false}),
  pair:()=>{entered.resolve();return waiting.promise;},publish:notice=>notices.push(notice),health:async()=>({version:'test',capabilities:[]}),source:async()=>{},apply:()=>true,flushActivities:async()=>{}};
 const f=mount('src/features/sources/use-companion-source.ts','useCompanionSource',options),pending=f.api().pair();await entered.promise;options.scope=rootScope(true);f.render();waiting.resolve({token:'synthetic'});
 assert.equal(await pending,true);assert.equal(notices.filter(value=>value.kind==='paired').length,1);f.hooks.unmount();
});
test('an old refresh cannot expire a replacement connection or clear its busy state',async()=>{
 const old=deferred(),latest=deferred(),entered=deferred(),notices=[];let connection={token:'old'},reads=0;
 const options={scope:'A',connection,retry:0,retryMs:5000,capture:()=>{const captured=connection;return{key:'A',connection:captured,current:()=>connection===captured,user:{userId:'a'},code:'',account:()=>false};},
  source:()=>{entered.resolve();return ++reads===1?old.promise:latest.promise;},publish:notice=>notices.push(notice),health:async()=>{},pair:async()=>{},apply:()=>true,flushActivities:async()=>{}};
 const f=mount('src/features/sources/use-companion-source.ts','useCompanionSource',options),first=f.api().refresh();await entered.promise;connection={token:'new'};options.connection=connection;f.render();const second=f.api().refresh();await tick();
 old.resolve({httpStatus:401,ok:false,payload:{}});await first;f.render();assert.equal(f.api().busy.refresh,true);assert.equal(notices.some(value=>value.kind==='expired'),false);
 latest.resolve({httpStatus:200,ok:true,payload:{status:'connected',subjects:[{}]}});await second;f.render();assert.equal(f.api().busy.refresh,false);f.hooks.unmount();
});
test('logout survives read-client metadata refresh and retains its captured connection',async()=>{
 const wait=deferred(),entered=deferred(),trace=[];let connection='old';
 const options={scope:'A',client:{},capture:()=>({owner:'A',ready:true,current:()=>true,pending:()=>false,buffers:()=>false,version:()=>0}),confirm:()=>true,export:async()=>recovery,
  download(){},clearLibrary:async()=>{},clearRead:async()=>{},clearWorkspace:async()=>{},cancelRead(){},pauseRead(){},message(){},prepareNavigation:()=>()=>true,clearViews:async()=>{},retire:()=>trace.push('retire'),
  captureConnection:()=>{const captured=connection;return{revoke:()=>{trace.push('revoke:'+captured);entered.resolve();return wait.promise;},clear:()=>{if(connection===captured)trace.push('clear');}};},redirect:()=>trace.push('redirect')};
 const f=mount('src/features/sources/use-source-maintenance.ts','useSourceMaintenance',options),pending=f.api().signOut();await entered.promise;options.client={};connection='new';f.render();wait.resolve();await pending;
 assert.deepEqual(trace,['retire','revoke:old','redirect']);f.hooks.unmount();
});
test('a reader cancelled by unmount cannot publish a late error or clear replacement loading',async()=>{
 const waiting=deferred(),trace=[],options={scope:'A',capture:()=>({ready:true,current:()=>true}),read:()=>waiting.promise,publish:value=>trace.push(value),error:error=>trace.push(error)};
 const f=mount('src/features/sources/use-source-reader.ts','useSourceReader',options),pending=f.api().read();f.hooks.unmount();waiting.reject(Error('late'));await pending;assert.deepEqual(trace,[]);
});
test('a prepared grant from a retired connection cannot start its background worker',async()=>{
 const waiting=deferred(),entered=deferred(),trace=[],options={client:{},status:async()=>({links:[]}),prepare:()=>{entered.resolve();return waiting.promise;},start:async id=>trace.push(id),stop:async()=>{},read:async()=>null,count:()=>0,replacementRequired:()=>false};
 const f=mount('src/features/sources/use-account-connection.ts','useAccountConnection',options),pending=f.api().prepare();await entered.promise;options.client={};f.render();waiting.resolve({grantId:'retired'});await pending;
 assert.deepEqual(trace,[]);f.hooks.unmount();
});

test('explicit local-mode intent cancels a pending account connection before its auto refresh',async()=>{
 const waiting=deferred(),entered=deferred(),trace=[],options={client:{},status:async()=>({links:[]}),prepare:()=>{entered.resolve();return waiting.promise;},start:async()=>trace.push('start'),stop:async()=>{},read:async()=>{trace.push('read');return null;},count:()=>0,replacementRequired:()=>false};
 const f=mount('src/features/sources/use-account-connection.ts','useAccountConnection',options),pending=f.api().prepare();await entered.promise;
 f.api().cancel();waiting.resolve({grantId:'old'});await pending;f.render();assert.equal(f.api().busy,false);assert.deepEqual(trace,[]);f.hooks.unmount();
});

test('replacing a source-change connection retires its view lock without letting its old finally unlock new work',async()=>{
 const old=deferred(),latest=deferred();let requests=0,deciding=null;
 const options={scope:'A',connection:{},current:()=>true,connected:()=>true,account:()=>false,list:async()=>({changes:[]}),scan:async()=>({changes:[]}),
  decide:()=>++requests===1?old.promise:latest.promise,source:async()=>({}),apply:()=>true,publish(){},loading(){},deciding:id=>{deciding=id;},message(){},scanError(){}};
 const f=mount('src/features/sources/use-source-changes.ts','useSourceChanges',options),first=f.api().decide('first','rejected');await tick();assert.equal(deciding,'first');
 options.connection={};f.render();assert.equal(deciding,null);const second=f.api().decide('second','rejected');await tick();old.resolve();await first;assert.equal(deciding,'second');
 latest.resolve();await second;assert.equal(deciding,null);f.hooks.unmount();
});

test('Root legacy initialization belongs to the account, so a source-mode switch does not strand checking',async()=>{
 const wait=deferred(),trace=[],epoch={current:0},owner={current:'account:A'},busy={current:()=>false};
 const options=dashboardFunction('legacyCloud',{workspaceId:'account:A',deliveryOwnerRef:owner,accountModeEpoch:epoch,sourceTransitionBusy:busy,
  progress:{itemStages:{},answered:0,correct:0},cloudRetryToken:0,runV3Bootstrap:async()=>{},setCloudStatus(){},setCloudMessage(){}});
 const session=createLegacyCloudSession({...options,read:()=>wait.promise,restore:()=>trace.push('restored')}),pending=session.read();
 epoch.current++;busy.current=()=>true;wait.resolve({});await pending;assert.deepEqual(trace,['restored']);session.dispose();
});
