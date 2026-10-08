import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {dashboardDeclaredFunction} from './fixtures/dashboard-functions.mjs';
const {CompanionSettingsCard}=loadTsx(new URL('../app/companion-settings-card.tsx',import.meta.url));
const base={endpoint:'http://127.0.0.1:43125',signedIn:false,paired:false,connected:false,detected:'unknown',version:null,message:'',code:'',refreshing:false,onCode(){},onLaunch(){},onDetect(){},onPair(){},onSync(){}};
test('update and diagnostic actions stay visible before sign-in and after pairing',()=>{
 for(const paired of [false,true])for(const connected of [false,true]){
 const html=renderToStaticMarkup(h(CompanionSettingsCard,{...base,signedIn:paired,paired,connected}));
 assert.match(html,/下载更新 Companion/);assert.match(html,/href="\/downloads\/Zhixue-Companion-Setup.exe" download/);
 assert.match(html,/检测连接/);assert.match(html,/43125/);assert.match(html,/本地网络访问/);
 assert.match(html,/http:\/\/127.0.0.1:43125\/v1\/health/);assert.doesNotMatch(html,/确定.*未运行/);
 }
});
function detector(fetch){const result={};return {result,run:dashboardDeclaredFunction('detectExistingCompanion',{sessionUser:null,companionUrl:base.endpoint,companionSession:null,fetch,AbortSignal,setCompanionDetected:value=>result.detected=value,setPairingMessage:value=>result.message=value,setCompanionVersion:value=>result.version=value,setCompanionSession(){},setCompanionRetryToken(){}})};}
test('signed-out user can verify a real Companion and read its version',async()=>{
 const x=detector(async()=>new Response(JSON.stringify({serverVersion:'StudyLoopCompanion/1.22.2',capabilities:['note-sources-v1']})));await x.run();assert.equal(x.result.detected,'online');assert.equal(x.result.version,'1.22.2');
});
test('HTTP 200 from an unrelated service is not called a working Companion',async()=>{
 const x=detector(async()=>new Response('{}'));await x.run();assert.equal(x.result.detected,'offline');assert.match(x.result.message,/不是 Companion/);
});
test('network refusal is actionable without asserting that the process is stopped',async()=>{
 const x=detector(async()=>{throw new TypeError('Failed to fetch')});await x.run();assert.equal(x.result.detected,'offline');assert.match(x.result.message,/尚不能判断/);assert.match(x.result.message,/本地网络权限/);
});

function pairedPage({account=false,active=true,read=async()=>Response.json({status:'connected',subjects:[{id:'fixture',items:[]}]})}={}){
 const result={message:'',detected:'unknown',sync:'offline',applied:0,flushed:0,session:{token:'fixture'},retries:0};
 const env={active,companionUrl:base.endpoint,companionHeaders:{},companionSession:result.session,sessionUser:{userId:'fixture'},workspaceId:'fixture',accountLoadedRef:{current:account?{bundle:{}}:null},AbortSignal,
  fetch:async url=>url.endsWith('/v1/health')?Response.json({serverVersion:'StudyLoopCompanion/1.35.0',capabilities:[]}):read(),
  setCompanionDetected:value=>{result.detected=value;},setCompanionVersion:value=>{result.version=value;},setSyncState:value=>{result.sync=value;},
  setPairingMessage:update=>{result.message=typeof update==='function'?update(result.message):update;},
  setCompanionSession:update=>{result.session=typeof update==='function'?update(result.session):update;},setCompanionRetryToken:update=>{result.retries=update(result.retries);},
  applyLocalStudySource:()=>{result.applied++;return true;},flushPendingActivities:()=>{result.flushed++;}};
 return{result,detect:dashboardDeclaredFunction('detectExistingCompanion',env),poll:dashboardDeclaredFunction('fetchStudyData',env)};
}

test('successful local data read replaces the real paired detection progress message',async()=>{
 const x=pairedPage();await x.detect();assert.match(x.result.message,/正在/);
 await x.poll();assert.match(x.result.message,/已连接.*资料已读取/);assert.doesNotMatch(x.result.message,/正在恢复|正在读取/);
 assert.equal(x.result.applied,1);assert.equal(x.result.flushed,1);assert.equal(x.result.sync,'connected');
 const html=renderToStaticMarkup(h(CompanionSettingsCard,{...base,signedIn:true,paired:true,connected:true,message:x.result.message}));
 assert.match(html,/资料已读取/);assert.doesNotMatch(html,/正在恢复|正在读取/);
});

test('successful account-mode poll settles the message without replacing the account source',async()=>{
 const x=pairedPage({account:true});await x.detect();await x.poll();
 assert.match(x.result.message,/已连接/);assert.match(x.result.message,/账号题库.*单独核对/);assert.doesNotMatch(x.result.message,/正在恢复|正在读取/);
 assert.equal(x.result.applied,0);assert.equal(x.result.flushed,0);
});

test('a delayed successful poll preserves a newer manual action error',async()=>{
 let finish;const wait=new Promise(resolve=>{finish=resolve;});const x=pairedPage({read:()=>wait});await x.detect();const pending=x.poll();
 x.result.message='手动刷新失败：资料来源已变化';finish(Response.json({status:'connected',subjects:[{id:'fixture',items:[]}]}));await pending;
 assert.equal(x.result.message,'手动刷新失败：资料来源已变化');
});

test('failed data reads end the progress hint and later polling can recover it',async()=>{
 let failed=true;const x=pairedPage({read:async()=>{if(failed)throw new TypeError('Failed to fetch');return Response.json({status:'connected',subjects:[{id:'fixture',items:[]}]});}});
 await x.detect();await x.poll();assert.doesNotMatch(x.result.message,/正在恢复|正在读取/);assert.match(x.result.message,/失败|无法/);assert.match(x.result.message,/重试/);
 failed=false;await x.poll();assert.match(x.result.message,/已连接.*资料已读取/);assert.equal(x.result.sync,'connected');
});

test('a later poll failure cannot leave the earlier connected message on screen',async()=>{
 let failed=false;const x=pairedPage({read:async()=>{if(failed)throw new TypeError('Failed to fetch');return Response.json({status:'connected',subjects:[{id:'fixture',items:[]}]});}});
 await x.detect();await x.poll();assert.match(x.result.message,/资料已读取/);
 failed=true;await x.poll();assert.match(x.result.message,/失败.*重试/);assert.equal(x.result.detected,'offline');
 failed=false;await x.poll();assert.match(x.result.message,/已连接.*资料已读取/);
});

test('a poll from an inactive view cannot finish the current connection message',async()=>{
 const x=pairedPage({active:false});await x.detect();const before=x.result.message;await x.poll();
 assert.equal(x.result.message,before);assert.equal(x.result.applied,0);assert.equal(x.result.flushed,0);
});

test('empty local data keeps its actionable notice instead of claiming loaded study content',async()=>{
 const x=pairedPage({read:async()=>Response.json({status:'connected',subjects:[]})});await x.detect();await x.poll();
 assert.match(x.result.message,/没有返回可用/);assert.doesNotMatch(x.result.message,/资料已读取/);assert.equal(x.result.applied,0);
});

test('expired pairing still clears the session and asks for a new pairing code',async()=>{
 const x=pairedPage({read:async()=>Response.json({message:'unauthorized'},{status:401})});await x.detect();await x.poll();
 assert.equal(x.result.session,null);assert.equal(x.result.sync,'offline');assert.match(x.result.message,/本机会话已失效/);assert.equal(x.result.applied,0);
});
