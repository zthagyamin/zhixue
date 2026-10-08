import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareStudyNavigation} from '../app/study-navigation-guard.ts';
import {withinDeadline} from '../app/action-deadline.ts';
import {dashboardDeclaredFunction} from './fixtures/dashboard-functions.mjs';
function fixture(){const trace=[],recovery={complete:true,pending:{coreUploads:[],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false},payload:{accountLibraries:[{libraryId:'retired'},{libraryId:'current'}],submissions:[]}};
  const env={signOutBusy:{current:false},prepareStudyNavigation,withinDeadline,accountWorkspaceId:'account:a',workspaceId:'account:a',storageReady:true,sessionResolved:true,deliveryOwnerRef:{current:'account:a'},currentDay:'2026-09-06',
    accountLoadedRef:{current:null},learningDrafts:{isPending:()=>false,hasBuffers:()=>false,clear:()=>trace.push('draft-clear')},exportStudyRecovery:async()=>recovery,
    hasPendingStudyRecovery:value=>value.pending.assistance.length>0,clearLocalAccountStudy:async(ws,lib)=>trace.push(['clear-view',ws,lib]),accountClient:{clearReadCache:async()=>trace.push('read-clear')},clearAccountWorkspaceRecords:async()=>trace.push('rebuildable-clear'),
    cancelAccountRead:()=>trace.push('cancel'),accountModeEpoch:{current:0},setAccountReadPaused:()=>trace.push('pause'),setAccountReadStatus:()=>trace.push('status'),
    setCloudMessage:value=>trace.push(['message',value]),setAccountLoaded:()=>{throw new Error('must retain current study frame');},setData:()=>{throw new Error('must retain current study frame');},
    window:{confirm:message=>{trace.push(['confirm',message]);return true;},location:{assign:url=>trace.push(['logout',url])}},document:{createElement:()=>({click:()=>trace.push('download')})},URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL:()=>{}},Blob,companionSession:null};
  return{env,recovery,trace,run:name=>dashboardDeclaredFunction(name,env)()};
}

function actionFixture(){
  const f=fixture();
  Object.assign(f.env,{
    settingsActionRef:{current:{requestId:0,owner:null,busy:false}},
    setSettingsActionOwner:value=>f.trace.push(['owner',value]),
    setSettingsActionMessage:value=>f.trace.push(['action-message',value]),
    setSettingsModal:value=>f.trace.push(['modal',value]),
  });
  f.env.exportAccountCache=()=>dashboardDeclaredFunction('exportAccountCache',f.env)();
  f.env.clearAccountCache=skip=>dashboardDeclaredFunction('clearAccountCache',f.env)(skip);
  f.env.runSettingsRecovery=operation=>dashboardDeclaredFunction('runSettingsRecovery',f.env)(operation);
  return f;
}

test('recovery actions report blocked conditions instead of successful no-ops',async()=>{
  const f=actionFixture();f.env.accountWorkspaceId=null;
  assert.equal((await f.run('exportAccountCache'))?.status,'blocked');
  await f.run('handleExportRecovery');
  assert.equal(f.trace.includes('download'),false);
  assert.equal(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='export-done'),false);
});

test('a failed export reports its error in the current settings dialog',async()=>{
  const f=actionFixture();f.env.exportStudyRecovery=async()=>{throw new Error('storage unavailable');};
  await f.run('handleExportRecovery');
  assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='failed'));
  assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='action-message'&&row[1].includes('未生成导出文件')));
  assert.equal(f.trace.includes('download'),false);
});

test('an incomplete export is a partial result, never a complete backup claim',async()=>{
  const f=actionFixture();f.recovery.complete=false;await f.run('handleExportRecovery');
  assert.ok(f.trace.includes('download'));
  assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='export-partial'));
  assert.equal(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='export-done'),false);
});

test('pending uploads block clearing and cannot produce a clear-done result',async()=>{
  const f=actionFixture();f.recovery.pending.coreUploads=['pending-attempt'];await f.run('handleClearCacheConfirmed');
  assert.equal(f.trace.includes('read-clear'),false);
  assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='blocked'));
  assert.equal(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='clear-done'),false);
});

test('successful clearing retains the original cache-only operation and reports completion',async()=>{
  const f=actionFixture();await f.run('handleClearCacheConfirmed');
  assert.equal(f.trace.filter(row=>row==='read-clear').length,1);
  assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='clear-done'));
});

test('repeated export clicks cannot start duplicate downloads while a read is pending',async()=>{
  const f=actionFixture();let release,reads=0;
  const pending=new Promise(resolve=>{release=resolve;});
  f.env.exportStudyRecovery=async()=>{reads++;await pending;return f.recovery;};
  const first=f.run('handleExportRecovery'),second=f.run('handleExportRecovery');
  release();await Promise.all([first,second]);
  assert.equal(reads,1);assert.equal(f.trace.filter(row=>row==='download').length,1);
});

test('an owner change during a settings export cannot display a late completion',async()=>{
  const f=actionFixture();f.env.exportStudyRecovery=async()=>{f.env.deliveryOwnerRef.current='account:b';return f.recovery;};
  await f.run('handleExportRecovery');
  assert.equal(f.trace.includes('download'),false);
  assert.equal(f.trace.some(row=>Array.isArray(row)&&row[0]==='modal'&&row[1]==='export-done'),false);
});
test('account recovery export works after identity confirmation even when no question bank is loaded',async()=>{
  const f=fixture();await f.run('exportAccountCache');assert.ok(f.trace.includes('download'));
});
test('read-cache clearing retains live study buffers and every library record while clearing only derived views',async()=>{
  const f=fixture();await f.run('clearAccountCache');assert.deepEqual(f.trace.filter(row=>Array.isArray(row)&&row[0]==='clear-view'),[['clear-view','account:a','retired'],['clear-view','account:a','current']]);
  assert.equal(f.trace.includes('draft-clear'),false);assert.ok(f.trace.includes('read-clear'));
});
test('a journal-only pending core blocks clearing even when no original-store queue is visible',async()=>{
  const f=fixture();f.recovery.pending.recovery=['journal-only'];await f.run('clearAccountCache');assert.equal(f.trace.includes('read-clear'),false);assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='message'));
});
test('an owner change during export prevents a late private download',async()=>{
  const f=fixture();f.env.exportStudyRecovery=async()=>{f.env.deliveryOwnerRef.current='account:b';return f.recovery;};await f.run('exportAccountCache');assert.equal(f.trace.includes('download'),false);
});
test('logout preserves auxiliary pending records from any library and never offers to erase their storage',async()=>{
  const f=fixture();f.recovery.pending.assistance=['pending-summary'];await f.run('signOut');assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='logout'));assert.equal(f.trace.includes('read-clear'),false);
  assert.equal(f.trace.filter(row=>Array.isArray(row)&&row[0]==='confirm').length,1);
});
test('failed recovery inspection does not prevent logout or trigger any cache cleanup',async()=>{
  const f=fixture();f.env.exportStudyRecovery=async()=>{throw new Error('storage unavailable');};await f.run('signOut');assert.ok(f.trace.some(row=>Array.isArray(row)&&row[0]==='logout'));assert.equal(f.trace.includes('read-clear'),false);
});
