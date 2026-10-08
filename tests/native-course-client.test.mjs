import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeCourseClient} from '../src/infrastructure/course-study/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {resolveCourseTask,courseTaskHash} from '../src/domain/course-study/index.ts';
import {readFileSync} from 'node:fs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/course-study-diagnostics-v1.json',import.meta.url)));
async function capture(){
  const identity={schemaVersion:1,libraryId:'local-vault:'+'d'.repeat(64),itemKey:'practice:course',contentHash:'a'.repeat(64),localBindingHash:'b'.repeat(64)};
  const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:identity.itemKey,contentHash:identity.contentHash,
    learningSupport:fixture.supports.definition,practice:{questionType:'recall',prompt:fixture.supports.definition.task.prompt,domain:'course'}};
  const body={schemaVersion:1,identity,item,taskHash:await courseTaskHash(resolveCourseTask(item))};
  return {...body,captureId:await studyHash(body)};
}
const options={baseUrl:'http://127.0.0.1:5195',sessionToken:'isolated-test-token',capabilities:['native-course-v1']};
test('source transport uses paired scoped endpoint and verifies durable identity/capture receipts',async()=>{
  const source=await capture(),calls=[];
  const client=createNativeCourseClient({...options,fetcher:async(url,init)=>{
    calls.push({url,init});return {ok:true,status:200,json:async()=>({schemaVersion:1,durable:true,capture:source})};
  }});
  assert.deepEqual(await client.capture(source.identity),source);
  assert.deepEqual(await client.read(source.identity,source.captureId),source);
  assert.equal(calls[0].url,options.baseUrl+'/v1/course/source/capture');
  assert.equal(calls[0].init.headers['X-Study-Loop-Session'],options.sessionToken);
  assert.deepEqual(JSON.parse(calls[0].init.body),{schemaVersion:1,identity:source.identity});
  for(const patch of [{durable:false},{capture:{...source,captureId:'f'.repeat(64)}},{extra:true}]){
    const bad=createNativeCourseClient({...options,fetcher:async()=>({ok:true,status:200,json:async()=>({schemaVersion:1,durable:true,capture:source,...patch})})});
    await assert.rejects(bad.capture(source.identity));
  }
});
test('old capability and nonloopback credential targets stop before transport',async()=>{
  const source=await capture();let calls=0;
  for(const patch of [{capabilities:[]},{baseUrl:'https://other.example'},{baseUrl:'http://127.0.0.1:5195/other'},
    {baseUrl:'http://user:password@127.0.0.1:5195'},{baseUrl:'http://127.0.0.1:5195/?token=wrong'}]){
    const client=createNativeCourseClient({...options,...patch,fetcher:async()=>{calls++;throw Error('must not call');}});
    await assert.rejects(client.capture(source.identity));
  }
  assert.equal(calls,0);
});
test('cancellation ends a signal-blind response body and never returns late capture',async()=>{
  const source=await capture(),controller=new AbortController();let finish,entered;
  const bodyReady=new Promise(resolve=>{entered=resolve;});
  const client=createNativeCourseClient({...options,fetcher:async()=>({ok:true,status:200,json:()=>{
    entered();return new Promise(resolve=>{finish=resolve;});
  }})});
  const work=client.capture(source.identity,controller.signal);await bodyReady;controller.abort();
  await assert.rejects(work,/cancelled/);finish({schemaVersion:1,durable:true,capture:source});
  const before=createNativeCourseClient({...options,fetcher:async()=>assert.fail('already cancelled')});
  await assert.rejects(before.capture(source.identity,controller.signal),/cancelled/);
});
