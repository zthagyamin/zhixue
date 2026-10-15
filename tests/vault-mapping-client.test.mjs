import test from 'node:test';
import assert from 'node:assert/strict';
import {createVaultMappingClient} from '../app/vault-mapping-client.ts';
import {knowledgeStarterPrompts} from '../app/knowledge-starter-prompts.ts';
import {readFile} from 'node:fs/promises';
import {deferred} from './helpers/causal-harness.mjs';
const options={companionUrl:'http://127.0.0.1:8765',sessionToken:'paired'};
const contextId='a'.repeat(64),previewId='b'.repeat(32);
const inspection={schemaVersion:2,contextId,revision:1,rules:[]};
const proof={schemaVersion:2,contextId,previewId,revision:1,itemCount:0,items:[]};
test('mapping client transmits paired local requests and conflicts',async()=>{
  const calls=[]; const client=createVaultMappingClient({...options,fetcher:async(url,init)=>{calls.push({url:String(url),...init});return Response.json(init.method==='GET'?inspection:JSON.parse(init.body).action==='preview'?proof:{...inspection,revision:2});}});
  await client.inspect();const preview=await client.preview([],contextId);await client.save([],1,preview);
  assert.equal(calls[0].headers['X-Study-Loop-Session'],'paired');assert.equal(calls[0].method,'GET');
  assert.deepEqual(JSON.parse(calls[1].body),{action:'preview',rules:[],schemaVersion:2,contextId});
  assert.deepEqual(JSON.parse(calls[2].body),{action:'confirm',rules:[],revision:1,schemaVersion:2,contextId,previewId});
  const stale=createVaultMappingClient({...options,fetcher:async(_url,init)=>init.method==='GET'?Response.json(inspection):Response.json({message:'stale-mapping'},{status:409})});await stale.inspect();await assert.rejects(stale.save([],1,proof),/重新读取/);
});
test('missing context or preview proof stops before any write',async()=>{
  let calls=0;const client=createVaultMappingClient({...options,fetcher:async()=>{calls++;return Response.json(inspection);}});
  await client.inspect();
  await assert.rejects(client.preview([]),/重新读取/);
  await assert.rejects(client.save([],1),/重新预览/);
  await assert.rejects(client.save([],2,proof),/重新预览/);
  await assert.rejects(client.save([],1,{...proof,previewId:'invalid'}),/重新预览/);
  await assert.rejects(client.preview([],'c'.repeat(64)),/重新读取/);
  assert.equal(calls,1);
});
test('old Companion inspection remains readable without allowing preview or save',async()=>{
  let calls=0;const client=createVaultMappingClient({...options,fetcher:async()=>{calls++;return Response.json({revision:1,rules:[]});}});
  assert.deepEqual(await client.inspect(),{revision:1,rules:[]});
  await assert.rejects(client.preview([],contextId),/更新.*Companion/);
  await assert.rejects(client.save([],1,proof),/更新.*Companion/);
  assert.equal(calls,1);
});
test('preview and save reject downgraded or different-context success responses',async()=>{
  for(const reply of [{...proof,schemaVersion:1},{...proof,contextId:'c'.repeat(64)},{...proof,previewId:'invalid'}]){
    const client=createVaultMappingClient({...options,fetcher:async(_url,init)=>Response.json(init.method==='GET'?inspection:reply)});await client.inspect();
    await assert.rejects(client.preview([],contextId),/预览|Companion|重新读取/);
  }
  for(const reply of [{revision:2,rules:[]},{...inspection,contextId:'c'.repeat(64),revision:2}]){
    const client=createVaultMappingClient({...options,fetcher:async(_url,init)=>Response.json(init.method==='GET'?inspection:reply)});await client.inspect();
    await assert.rejects(client.save([],1,proof),/Companion|重新读取/);
  }
});
test('new inspection retires pending preview proof on the same client',async()=>{
  const wait=deferred();let reads=0;
  const client=createVaultMappingClient({...options,fetcher:async(_url,init)=>init.method==='GET'?Response.json({...inspection,contextId:++reads===1?contextId:'c'.repeat(64)}):wait.promise});
  await client.inspect();const pending=client.preview([],contextId);await client.inspect();wait.resolve(Response.json(proof));
  await assert.rejects(pending,/重新读取/);await assert.rejects(client.save([],1,proof),/重新读取/);
});
test('mapping client rejects remote endpoints and missing session',()=>{
  assert.throws(()=>createVaultMappingClient({...options,companionUrl:'https://example.org'}),/本机/);
  assert.throws(()=>createVaultMappingClient({...options,sessionToken:''}),/配对/);
});
test('starter prompts and all downloads available without credentials',async()=>{
  assert.deepEqual(knowledgeStarterPrompts.map(item=>item.id),['vocabulary','python','concepts','course','paper']);
  for(const item of knowledgeStarterPrompts){assert.match(item.prompt,/generated: true/); const body=await readFile(new URL(`../public/knowledge-starter-kit/${item.file}`,import.meta.url),'utf8');assert.match(body,/learning_status: unattempted/);}
  assert.ok((await readFile(new URL('../public/knowledge-starter-kit/structure.zip',import.meta.url))).length>500);
});
