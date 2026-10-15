import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as afterMicrotasks} from 'node:timers/promises';
import {createAccountConnection} from '../src/application/sources/index.ts';
import {createAccountStudyClient} from '../app/account-study-client.ts';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const link = overrides => ({grantId: 'grant-a', libraryId: 'library-a', label: 'Computer', state: 'active', workerStatus: 'synced', ...overrides});
function fixture() {
  let view = {label: 'Computer', message: '', busy: false, replacement: false, grant: null, sync: null};
  let current = true;
  const calls = [];
  const ports = {
    current: () => current, view: () => view, publish: patch => {view = {...view, ...patch};}, now: () => Date.parse('2026-10-13T00:00:00.000Z'),
    status: async () => ({links: [link()]}),
    prepare: async (label, options) => {calls.push(['prepare', label, options]); return {grantId: 'grant-new'};},
    start: async id => {calls.push(['start', id]);}, stop: async id => {calls.push(['stop', id]);},
    read: async kind => {calls.push(['read', kind]); return {items: 4};}, count: value => value.items,
    replacementRequired: () => false,
  };
  return {ports, calls, view: () => view, retire: () => {current = false;}, create: () => createAccountConnection(ports)};
}

test('retry status is not reported as running and survives successful account reads', async () => {
  const f = fixture(); f.ports.status = async () => ({links: [link({workerStatus: 'retry', error: 'account-network-or-storage-unavailable'})]});
  const connection = f.create(); await connection.status(); await connection.refresh();
  assert.equal(f.view().sync?.kind, 'retry');
  assert.match(f.view().sync?.message ?? '', /重试/);
  assert.match(f.view().message, /4/);
  assert.doesNotMatch(f.view().message, /正在运行/);
});

test('an older status read cannot erase a newer authorization failure', async () => {
  const f = fixture(), first = deferred(), second = deferred(); let count = 0;
  f.ports.status = () => (++count === 1 ? first.promise : second.promise);
  const connection = f.create(), older = connection.status(), newer = connection.status();
  second.resolve({links: [link({state: 'paused', workerStatus: 'paused', error: 'account-authorization-required'})]}); await newer;
  first.resolve({links: [link()]}); await older;
  assert.equal(f.view().sync?.kind, 'authorization-required');
});

test('ordinary pause resumes the same grant only after an explicit click',async()=>{
  const f=fixture();let running=false;
  f.ports.status=async()=>({links:[link(running?{}:{state:'paused',workerStatus:'stopped'})]});
  f.ports.start=async id=>{f.calls.push(['start',id]);running=true;};
  const connection=f.create();await connection.status();assert.deepEqual(f.calls,[]);
  assert.equal(f.view().sync.kind,'stopped');await connection.resume();
  assert.deepEqual(f.calls,[['start','grant-a'],['read','refresh']]);assert.equal(f.view().sync.kind,'synced');
});
test('expired authorization rotates only on explicit request and shares duplicate clicks',async()=>{
  const f=fixture(),gate=deferred();let current=link({state:'paused',workerStatus:'paused',error:'account-authorization-required'});
  f.ports.status=async()=>({links:[current]});
  f.ports.prepare=async(label,options)=>{f.calls.push(['prepare',label,options]);await gate.promise;return {grantId:'grant-new'};};
  f.ports.start=async id=>{f.calls.push(['start',id]);current=link({grantId:id});};
  const connection=f.create();await connection.status();assert.deepEqual(f.calls,[]);
  const first=connection.prepare(false,true),second=connection.prepare(false,true);await second;
  assert.equal(f.calls.length,1);gate.resolve();await first;
  assert.deepEqual(f.calls[0],['prepare','Computer',{replaceLibrary:false,rotateGrant:true}]);
  assert.equal(f.view().grant,'grant-new');assert.equal(f.view().sync.kind,'synced');
});
test('stop reads the resulting paused state and preserves an explicit stopped message',async()=>{
  const f=fixture();let stopped=false;
  f.ports.status=async()=>({links:[link(stopped?{state:'paused',workerStatus:'stopped'}:{})]});
  f.ports.stop=async id=>{f.calls.push(['stop',id]);stopped=true;};
  const connection=f.create();await connection.status();await connection.stop();
  assert.equal(f.view().sync.kind,'stopped');assert.match(f.view().sync.message,/已停止/);
  assert.equal(f.calls.some(call=>call[0]==='prepare'||call[0]==='start'),false);
});
test('failed authorization start is still visible after local metadata returns an old paused state',async()=>{
  const f=fixture();f.ports.status=async()=>({links:[link({state:'paused',workerStatus:'stopped'})]});
  f.ports.start=async()=>{throw Error('account-authorization-required');};
  const connection=f.create();await connection.status();await connection.resume();
  assert.equal(f.view().sync.kind,'authorization-required');assert.equal(f.view().message,'');
  assert.equal(f.view().busy,false);
});
test('failed account read does not turn a successful local start into a machine-grant failure',async()=>{
  const f=fixture();f.ports.read=async()=>{throw Error('authentication-required');};
  const connection=f.create();await connection.prepare(false,true);
  assert.equal(f.view().sync.kind,'synced');assert.match(f.view().message,/登录账号/);
});
test('pairing expiry and offline status clear the old running claim without renewing credentials',async()=>{
  const f=fixture(),connection=f.create();await connection.status();
  f.ports.status=async()=>{throw Error('companion-pairing-required');};await connection.status();
  assert.equal(f.view().sync.action,'pair');await connection.resume();assert.deepEqual(f.calls,[]);
  f.ports.status=async()=>{throw Error('private path token text');};await connection.status();
  assert.equal(f.view().sync.kind,'unknown');assert.doesNotMatch(f.view().sync.message,/private|token/);
});
for(const retirement of ['retire','cancel','dispose'])test(`late setup is ignored after ${retirement}`,async()=>{
  const f=fixture(),gate=deferred();f.ports.prepare=()=>gate.promise;
  const connection=f.create(),pending=connection.prepare(false,true);
  if(retirement==='retire')f.retire();else connection[retirement]();
  gate.resolve({grantId:'late-grant'});await pending;
  assert.equal(f.calls.some(call=>call[0]==='start'),false);assert.notEqual(f.view().grant,'late-grant');
});
test('a status request started before stop cannot restore a running message after the stop receipt',async()=>{
  const f=fixture(),gate=deferred();let count=0;
  f.ports.status=()=>++count===2?gate.promise:Promise.resolve({links:[link(count>2?{state:'paused',workerStatus:'stopped'}:{})]});
  const connection=f.create();await connection.status();const stale=connection.status();await connection.stop();
  gate.resolve({links:[link()]});await stale;assert.equal(f.view().sync.kind,'stopped');
});
test('a cancelled cloud read does not publish or reload status for the retired view',async()=>{
  const f=fixture(),gate=deferred();let statusCalls=0;
  f.ports.read=()=>gate.promise;f.ports.status=async()=>{statusCalls++;return {links:[]};};
  const connection=f.create(),pending=connection.refresh();connection.cancel();gate.resolve({items:99});await pending;
  assert.equal(f.view().message,'');assert.equal(statusCalls,0);assert.equal(f.view().busy,false);
});
test('a nonresponsive local status cannot lock a completed cloud refresh or overwrite its data',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),response=deferred(),entered=deferred();let fetchSignal;
  t.after(()=>response.resolve(Response.json({links:[link()]})));
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-paired',cache:null,
    fetcher:async(_url,options)=>{fetchSignal=options.signal;entered.resolve();return response.promise;}});
  f.ports.status=()=>client.localStatus();
  const connection=f.create(),refresh=connection.refresh();await entered.promise;
  assert.equal(f.view().busy,true);assert.match(f.view().message,/4/);
  t.mock.timers.tick(10000);await afterMicrotasks();
  assert.equal(f.view().busy,false);assert.match(f.view().message,/4/);
  await refresh;
  assert.equal(f.view().sync.kind,'unknown');assert.notEqual(f.view().sync.action,'reauthorize');assert.equal(fetchSignal.aborted,true);
  response.resolve(Response.json({links:[link()]}));await Promise.resolve();await Promise.resolve();
  assert.equal(f.view().sync.kind,'unknown');assert.deepEqual(f.calls,[['read','refresh']]);
});
