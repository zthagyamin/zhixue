import assert from 'node:assert/strict';
import test from 'node:test';
import {parseAccountSyncStatus,accountSyncNotice,accountSyncError} from '../src/domain/sources/index.ts';
import {createAccountStudyClient} from '../app/account-study-client.ts';

const now=Date.parse('2026-10-13T00:00:00.000Z');
const authorization={expiresAt:'2026-10-20T00:00:00.000Z',checkedAt:'2026-10-12T00:00:00.000Z'};
const link=overrides=>({grantId:'grant-a',libraryId:'library-a',label:'Computer',state:'active',workerStatus:'synced',...overrides});
const status=(value=link())=>parseAccountSyncStatus({links:[value]}).links[0];

test('legacy status remains usable without inventing a grant expiry',()=>{
  const value=status();assert.equal(value.authorization,undefined);
  assert.equal(accountSyncNotice(value,now).expiryNotice,undefined);
  assert.deepEqual(parseAccountSyncStatus({}),{links:[]});
});
test('status permits only validated optional observations and returns no credentials or arbitrary errors',()=>{
  const value=status(link({authorization:{...authorization,token:'private'},secret:'private',error:'private upstream message'}));
  assert.deepEqual(value.authorization,authorization);
  assert.equal(value.error,undefined);assert.equal(JSON.stringify(value).includes('private'),false);
});
for(const value of [null,{}, {expiresAt:'tomorrow',checkedAt:authorization.checkedAt},
  {...authorization,checkedAt:authorization.expiresAt}, {...authorization,expiresAt:'2026-02-31T00:00:00.000Z'},
  {...authorization,expiresAt:23}, {...authorization,checkedAt:'2026-10-21T00:00:00.000Z'}]){
  test(`invalid optional authorization is unknown: ${JSON.stringify(value)}`,()=>{
    assert.equal(status(link({authorization:value})).authorization,undefined);
  });
}
test('current library filtering retains identities and rejects an unrelated Companion library',()=>{
  const own=link(),other=link({grantId:'grant-b',libraryId:'library-b'});
  assert.deepEqual(parseAccountSyncStatus({links:[other,own]},'library-a').links,[own]);
  assert.throws(()=>parseAccountSyncStatus({links:[other]},'library-a'),/account-library-changed/);
  assert.throws(()=>parseAccountSyncStatus({links:[{...own,grantId:null}]}),/status-invalid/);
  assert.throws(()=>parseAccountSyncStatus({links:'bad'}),/status-invalid/);
});
for(const [workerStatus,kind] of [['retry','retry'],['blocked','blocked'],['partial','partial'],['starting','starting'],['stopping','stopping'],['stopped','stopped'],['synced','synced']]){
  test(`${workerStatus} is reported distinctly`,()=>assert.equal(accountSyncNotice(status(link({workerStatus})),now).kind,kind));
}
test('authorization failure, changed binding and explicit pause retain distinct actions',()=>{
  assert.equal(accountSyncNotice(status(link({state:'paused',workerStatus:'paused',error:'account-authorization-required'})),now).action,'reauthorize');
  assert.equal(accountSyncNotice(status(link({state:'paused',workerStatus:'paused',error:'account-cloud-link-changed'})),now).action,'none');
  assert.equal(accountSyncNotice(status(link({state:'paused',workerStatus:'paused',error:'account-local-configuration-required'})),now).action,'none');
  assert.equal(accountSyncNotice(status(link({state:'paused',workerStatus:'stopped'})),now).action,'resume');
});
test('a prepared local link still needs registration rather than a blind worker resume',()=>{
  assert.equal(accountSyncNotice(status(link({state:'prepared',workerStatus:'stopped'})),now).action,'connect');
});
test('seven-day and reached deadlines are advisory, including while stopped',()=>{
  const value=status(link({authorization,state:'paused',workerStatus:'stopped'}));
  assert.match(accountSyncNotice(value,now).expiryNotice,/上次核对.*7 天/);
  assert.equal(accountSyncNotice(value,now-1).expiryNotice,undefined);
  const due=accountSyncNotice(value,Date.parse(authorization.expiresAt));
  assert.equal(due.kind,'authorization-required');assert.equal(due.action,'reauthorize');assert.match(due.message,/已停止/);
  assert.match(due.message,/已到上次核对/);assert.doesNotMatch(due.message,/有效|正在运行/);
  assert.equal(due.expiresAt,authorization.expiresAt);
});
test('a reached known deadline replaces running or synced claims and keeps the exact timestamp',()=>{
  for(const workerStatus of ['running','synced','retry']){
    const due=accountSyncNotice(status(link({workerStatus,authorization})),Date.parse(authorization.expiresAt));
    assert.equal(due.kind,'authorization-required');assert.equal(due.action,'reauthorize');
    assert.doesNotMatch(due.message,/正在处理|已完成|有效/);assert.equal(due.expiresAt,authorization.expiresAt);
  }
});
test('local pairing, account identity, unavailable cloud and unknown errors never masquerade as expired grants',()=>{
  for(const code of ['companion-pairing-required','authentication-required','account-cloud-unavailable','private token error','account-cloud-link-not-ready']){
    const notice=accountSyncError(new Error(code));
    assert.notEqual(notice.action,'reauthorize');assert.ok(!notice.message.includes(code));
  }
  assert.equal(accountSyncError(new Error('companion-pairing-required')).action,'pair');
  assert.equal(accountSyncError(new Error('account-authorization-required')).action,'reauthorize');
  assert.equal(accountSyncError(new Error('account-cloud-link-changed')).kind,'binding-changed');
});

test('client parses local observations, preserves paired headers and filters current library',async()=>{
  const calls=[];
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',expectedUserId:'user-a',libraryId:'library-a',cache:null,
    fetcher:async(url,options)=>{calls.push([url,options]);return Response.json({links:[link({authorization}),link({libraryId:'library-b'})]});}});
  const result=await client.localStatus();assert.equal(result.links.length,1);assert.deepEqual(result.links[0].authorization,authorization);
  assert.equal(calls[0][1].headers['X-Study-Loop-Session'],'synthetic-paired');assert.equal(calls[0][1].method,'GET');
  assert.equal(calls.length,1);
});
test('client cancels an old status response after current library changes',async()=>{
  let resolve;const delayed=new Promise(done=>{resolve=done;});const calls=[];
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',expectedUserId:'user-a',libraryId:'library-a',cache:null,
    fetcher:async(url)=>{calls.push(String(url));return String(url).includes('/v1/account-sync/status')?delayed:Response.json({profile:{libraryId:'library-b'}});}});
  const pending=client.localStatus();const adopt=await client.prepareLibraryAdoption();adopt();
  resolve(Response.json({links:[link()]}));await assert.rejects(pending,error=>error.name==='AbortError');
  assert.ok(calls.find(url=>url.includes('expectedUserId=user-a')));
});
test('discovering the current library from cache also retires an unscoped status read',async()=>{
  let resolve;const pendingResponse=new Promise(done=>{resolve=done;});
  const cache={latest:async()=>({scope:{libraryId:'library-b'},model:{loaded:{}}})};
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',expectedUserId:'user-a',cache,fetcher:async()=>pendingResponse});
  const pending=client.localStatus();await client.cached();resolve(Response.json({links:[link()]}));
  await assert.rejects(pending,error=>error.name==='AbortError');
});
test('client requires local pairing before any status request',async()=>{
  let calls=0;const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',cache:null,fetcher:async()=>{calls++;throw Error('unexpected');}});
  await assert.rejects(client.localStatus(),/companion-pairing-required/);assert.equal(calls,0);
});
test('legacy local HTTP 401 means local pairing, while cloud HTTP 401 remains account login',async()=>{
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',cache:null,
    fetcher:async url=>String(url).startsWith('http://')?Response.json({message:'arbitrary secret text'},{status:401}):Response.json({error:'authentication-required'},{status:401})});
  await assert.rejects(client.localStatus(),/companion-pairing-required/);
  await assert.rejects(client.currentLibrary(),/authentication-required/);
});
test('legacy local origin rejection maps safely without exposing arbitrary server text',async()=>{
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',cache:null,
    fetcher:async()=>Response.json({message:'arbitrary secret text'},{status:403})});
  await assert.rejects(client.localStatus(),/companion-origin-not-allowed/);
});
