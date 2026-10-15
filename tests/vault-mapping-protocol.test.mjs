import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVaultMappingClient} from '../app/vault-mapping-client.ts';

test('V2 shared mapping fixture uses actual paired client request contract',async()=>{
  const f=JSON.parse(await readFile(new URL('./fixtures/vault-mapping-context-v2.json',import.meta.url),'utf8'));
  const requests=[];
  const client=createVaultMappingClient({companionUrl:'http://127.0.0.1:8765',sessionToken:'synthetic',fetcher:async(_url,init)=>{
    const body=init.body?JSON.parse(init.body):null;
    if(body)requests.push(body);
    return Response.json({...f,itemCount:1,items:[],revision:body?.action==='confirm'?1:0});
  }});
  await client.inspect();const proof=await client.preview(f.rules,f.contextId);await client.save(f.rules,0,proof);
  assert.deepEqual(requests,[f.previewRequest,f.confirmRequest]);
});
