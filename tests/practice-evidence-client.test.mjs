import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountPracticeEvidenceClient} from '../src/infrastructure/practice-evidence/account-client.ts';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';
import {attempt,mutation,report} from './fixtures/practice-evidence-fixtures.mjs';
const m=mutation('code-report',{report:report()});
const client=fetcher=>createAccountPracticeEvidenceClient({ownerId:'owner',libraryId:'library',fetcher});
test('browser transport binds auth scope, strict receipts and durable fingerprints',async()=>{
 const receipt=await applyPracticeEvidenceMutation(null,m,{attempt:attempt()});receipt.durable=true;let sent;
 const c=client(async(url,options)=>{sent={url,options};return Response.json(receipt);});
 assert.equal((await c.mutate(m)).status,'accepted');
 assert.equal(sent.options.credentials,'same-origin');assert.equal(sent.url,'/api/account-study');
 assert.deepEqual(Object.keys(JSON.parse(sent.options.body)).sort(),['action','expectedUserId','libraryId','mutation']);
 assert.equal(JSON.parse(sent.options.body).expectedUserId,'owner');
 for(const bad of [{...receipt,operationId:'wrong'},{...receipt,revision:5},{...receipt,record:null},{...receipt,extra:true},{...receipt,record:{...receipt.record,binding:{...m.binding,ownerId:'foreign'}}},{...receipt,record:{...receipt.record,operations:[{...receipt.record.operations[0],fingerprint:'b'.repeat(64)}]}}])
  await assert.rejects(client(async()=>Response.json(bad)).mutate(m),/receipt|scope/);
 assert.equal((await client(async()=>Response.json({...receipt,status:'conflict',durable:false})).mutate(m)).status,'conflict');
});
test('capabilities remain unsupported/incompatible and list never silently omits pages',async()=>{
 assert.deepEqual(await client(async()=>Response.json({error:'unsupported-action'},{status:409})).mutate(m),{status:'unsupported'});
 assert.deepEqual(await client(async()=>Response.json({error:'practice-evidence-unsupported-version'},{status:409})).mutate(m),{status:'incompatible'});
 const receipt=await applyPracticeEvidenceMutation(null,m,{attempt:attempt()}),record=receipt.record;
 const c=client(async()=>Response.json({records:[record],complete:false,nextCursor:record.attemptId}));
 assert.equal((await c.listPage()).complete,false);await assert.rejects(c.list(),/truncated/);
 assert.equal((await client(async()=>Response.json({records:[record],complete:true,nextCursor:null})).list()).length,1);
 await assert.rejects(client(async()=>Response.json({records:[record],complete:true,nextCursor:'attempt'})).list(),/page/);
 await assert.rejects(client(async()=>Response.json({record:{...record,schemaVersion:99}})).read('attempt'),/version/);
});
