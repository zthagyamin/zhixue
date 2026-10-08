import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/application/sources/index.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(){
 let owner='A',epoch=0,pending=false,version=0;const calls=[],messages=[];
 const ports={capture:()=>{const capturedOwner=owner,capturedEpoch=epoch;return{owner,connection:true,current:()=>owner===capturedOwner&&epoch===capturedEpoch,
  pending:()=>pending,buffers:()=>true,draftVersion:()=>version};},
  confirm:()=>true,begin:()=>{epoch++;calls.push('reserve');},clearDrafts:()=>calls.push('clear'),readLocal:async()=>({source:'local'}),adoptAccount:async()=>{calls.push('adopt');},
  commitLocal:value=>calls.push(['local',value]),commitAccount:()=>calls.push('account'),reloadAccount:async()=>{calls.push('reload');return{source:'account'};},message:value=>messages.push(value),busy:()=>{}};
 return{ports,calls,messages,create:()=>api.createSourceTransitions(ports),owner:()=>{owner='B';epoch++;},answer:()=>{pending=true;version++;},edit:()=>version++};
}
test('local mode only commits after a complete source is ready',async()=>{
 const f=fixture();assert.equal(await f.create().switchLocal(),true);assert.deepEqual(f.calls,['reserve','clear',['local',{source:'local'}]]);
});

test('cancelling adoption after a new edit does not retarget the shared account client',async()=>{
 const {createAccountStudyClient}=await import('../app/account-study-client.ts');
 const gate=deferred(),entered=deferred(),sent=[];
 const client=createAccountStudyClient({companionUrl:'http://synthetic.invalid',expectedUserId:'user',libraryId:'library-a',cache:null,fetcher:async(url,options)=>{
  if(options?.method==='POST'){sent.push(JSON.parse(options.body));return Response.json({results:[]});}
  entered.resolve();await gate.promise;return Response.json({profile:{libraryId:'library-b'}});
 }});
 const f=fixture();f.ports.adoptAccount=()=>client.prepareLibraryAdoption();const pending=f.create().adoptAccount();await entered.promise;
 f.edit();gate.resolve();assert.equal(await pending,null);await client.appendRecords([]);assert.equal(sent[0].libraryId,'library-a');
});
test('an owner change while reading local material never clears or replaces the new space',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();f.ports.readLocal=()=>{entered.resolve();return gate.promise;};const pending=f.create().switchLocal();await entered.promise;f.owner();gate.resolve({source:'old'});await pending;
 assert.deepEqual(f.calls,['reserve']);
});
for(const change of ['answer','edit'])test(`a new ${change} during local preparation preserves the current input and source`,async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();f.ports.readLocal=()=>{entered.resolve();return gate.promise;};const pending=f.create().switchLocal();await entered.promise;f[change]();gate.resolve({source:'local'});await pending;
 assert.deepEqual(f.calls,['reserve']);assert.match(f.messages.at(-1),/作答|输入/);
});
test('unavailable local material does not clear the account source',async()=>{
 const f=fixture();f.ports.readLocal=async()=>{throw Error('offline');};assert.equal(await f.create().switchLocal(),false);assert.deepEqual(f.calls,['reserve']);
});
test('account reload starts only after the mode transition releases its own busy lease',async()=>{
 const f=fixture(),session=f.create();f.ports.reloadAccount=async()=>{assert.equal(session.isBusy(),false);f.calls.push('reload');return{source:'account'};};
 const result=await session.adoptAccount();assert.deepEqual(result,{source:'account'});assert.deepEqual(f.calls,['reserve','adopt','clear','account','reload']);
});

test('duplicate intent shares the preparation without repeating consent; opposite intent does not join it',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();let confirms=0;
 f.ports.confirm=()=>{confirms++;return true;};f.ports.adoptAccount=()=>{entered.resolve();return gate.promise;};
 const session=f.create(),first=session.adoptAccount();await entered.promise;
 const duplicate=session.adoptAccount();assert.equal(await session.switchLocal(),false);assert.equal(confirms,1);
 gate.resolve();assert.deepEqual(await first,{source:'account'});assert.deepEqual(await duplicate,{source:'account'});
 assert.equal(f.calls.filter(value=>value==='account').length,1);
});
