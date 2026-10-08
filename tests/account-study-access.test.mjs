import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {openD1} from './helpers/sqlite-d1.mjs';
let auth,api;
try {auth=await import('../app/account-study-auth.ts');api=await import('../db/account-study-access-store.ts');}
catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const secret=n=>Buffer.alloc(32,n).toString('base64url');
const registration=(n=1,overrides={})=>({grantId:`grant-${n}`,libraryId:'library-a',tokenHash:createHash('sha256').update(secret(n)).digest('hex'),
  label:'Desktop',expectedProfileRevision:0,replaceLibrary:false,...overrides});
async function setup(t){assert.equal(typeof api?.AccountStudyAccessStore,'function','Machine-grant store must exist');
  const db=await openD1();t.after(()=>db.sqlite.close());const clock={now:Date.parse('2026-09-01T00:00:00.000Z')};
  return {...db,clock,access:new api.AccountStudyAccessStore(db.binding,()=>new Date(clock.now))};}
test('machine authorization stores only a hash and pending registration does not switch the library',async t=>{
  const {access,sqlite}=await setup(t);assert.equal(await auth.machineTokenHash(secret(1)),registration().tokenHash);
  await access.register('user-a',registration());const pending=await access.authenticate(secret(1));
  assert.equal(pending.userId,'user-a');assert.equal(pending.state,'pending');
  assert.deepEqual(await access.profile('user-a'),{libraryId:null,revision:0});
  assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM account_study_grants').all()).includes(secret(1)),false);
});
test('activation and revocation are scoped without disturbing another account',async t=>{
  const {access}=await setup(t);await access.register('user-a',registration());await access.activate(secret(1));
  assert.deepEqual(await access.profile('user-a'),{libraryId:'library-a',revision:1});
  assert.equal((await access.authenticate(secret(1))).state,'active');
  assert.equal(await access.revoke('user-b','grant-1'),false);assert.equal((await access.authenticate(secret(1))).state,'active');
  assert.equal(await access.revoke('user-a','grant-1'),true);assert.equal(await access.authenticate(secret(1)),null);
});
test('expired and malformed tokens do not authenticate or extend registration',async t=>{
  const {access,clock}=await setup(t);await access.register('user-a',registration());const pending=await access.authenticate(secret(1));
  clock.now=Date.parse(pending.expiresAt);assert.equal(await access.authenticate(secret(1)),null);
  await assert.rejects(access.activate(secret(1)),/grant/);assert.equal(await access.authenticate('short'),null);
  await assert.rejects(auth.machineTokenHash('short'),/token/);
});
test('library replacement requires explicit approval and a matching profile version',async t=>{
  const {access}=await setup(t);await access.register('user-a',registration());await access.activate(secret(1));
  const next=registration(2,{libraryId:'library-b',expectedProfileRevision:1});
  await assert.rejects(access.register('user-a',next),/replace/);
  await access.register('user-a',{...next,replaceLibrary:true});await access.activate(secret(2));
  assert.deepEqual(await access.profile('user-a'),{libraryId:'library-b',revision:2});
  assert.equal(await access.authenticate(secret(1)),null);assert.equal((await access.authenticate(secret(2))).libraryId,'library-b');
});
test('concurrent activations cannot both take ownership of one profile revision',async t=>{
  const {access,sqlite}=await setup(t);await access.register('user-a',registration(1));await access.register('user-a',registration(2));
  const outcomes=await Promise.allSettled([access.activate(secret(1)),access.activate(secret(2))]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM account_study_grants WHERE user_id='user-a' AND state='active'").get().n,1);
  assert.equal((await access.profile('user-a')).revision,1);
});
test('same registration can retry but changed binding cannot reuse its grant ID',async t=>{
  const {access,sqlite}=await setup(t);await access.register('user-a',registration());await access.register('user-a',registration());
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_grants').get().n,1);
  await assert.rejects(access.register('user-a',registration(1,{label:'Changed'})),/conflict/);
  await access.activate(secret(1));await access.register('user-a',registration());
  assert.equal((await access.profile('user-a')).revision,1);
});
test('another account cannot seize an existing grant ID or token hash',async t=>{
  const {access}=await setup(t);await access.register('user-a',registration());
  await assert.rejects(access.register('user-b',registration(2,{grantId:'grant-1'})),/conflict/);
  await assert.rejects(access.register('user-b',registration(1,{grantId:'other-grant'})),/conflict/);
  assert.equal((await access.authenticate(secret(1))).userId,'user-a');
});
test('registration rejects unexpected secrets, weak hash shapes and nonboolean replacement',async t=>{
  const {access}=await setup(t);await assert.rejects(access.register('user-a',{...registration(),secret:secret(1)}),/field/);
  await assert.rejects(access.register('user-a',registration(1,{tokenHash:'bad'})),/hash/);
  await assert.rejects(access.register('user-a',registration(1,{replaceLibrary:['true']})),/replace/);
});
test('pending authorization count is bounded and duplicate retry uses no extra slot',async t=>{
  const {access,sqlite}=await setup(t);for(let i=1;i<=5;i++) await access.register('user-a',registration(i));
  await access.register('user-a',registration(1));await assert.rejects(access.register('user-a',registration(6)),/limit/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_grants').get().n,5);
});
