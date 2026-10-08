import test from 'node:test';
import assert from 'node:assert/strict';
import {createVaultMappingClient} from '../app/vault-mapping-client.ts';
import {knowledgeStarterPrompts} from '../app/knowledge-starter-prompts.ts';
import {readFile} from 'node:fs/promises';
const options={companionUrl:'http://127.0.0.1:8765',sessionToken:'paired'};
test('mapping client transmits paired local requests and conflicts',async()=>{
  const calls=[]; const client=createVaultMappingClient({...options,fetcher:async(url,init)=>{calls.push({url:String(url),...init});return Response.json({revision:2,rules:[]});}});
  await client.inspect();await client.preview([]);await client.save([],1);
  assert.equal(calls[0].headers['X-Study-Loop-Session'],'paired');assert.equal(calls[0].method,'GET');assert.deepEqual(JSON.parse(calls[2].body),{action:'confirm',rules:[],revision:1});
  const stale=createVaultMappingClient({...options,fetcher:async()=>Response.json({message:'stale-mapping'},{status:409})});await assert.rejects(stale.save([],1),/重新读取/);
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
