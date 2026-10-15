import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReadingRemote} from '../src/infrastructure/paper-reading/remote.ts';
import {applyPaperReadingMutation} from '../src/domain/paper-reading/workspace.ts';
const scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Source.'}]}};
const mutation={schemaVersion:1,operationId:'r',unitId:'unit',expectedRevision:0,kind:'register',unit};
const workspace=applyPaperReadingMutation(null,mutation).workspace;
test('remote writes bind existing authentication and validate exact durable receipts',async()=>{
 let sent;const remote=createPaperReadingRemote({scope,fetcher:async(url,init)=>{assert.equal(url,'/api/account-study');sent=JSON.parse(init.body);return Response.json({schemaVersion:1,status:'accepted',durable:true,operationId:'r',workspace});}});
 const result=await remote.mutate(mutation);assert.equal(result.durable,true);assert.equal(sent.expectedUserId,'u');assert.equal(sent.libraryId,'l');assert.equal(sent.action,'mutate-paper-reading');
});
test('foreign sources or unconfirmed receipts cannot hydrate a local answer',async()=>{
 const make=value=>createPaperReadingRemote({scope,fetcher:async()=>Response.json(value)});
 await assert.rejects(make({workspace:{...workspace,unit:{...unit,source:{...unit.source,ownerId:'other'}}}}).read('unit'),/binding|corrupt/);
 await assert.rejects(make({schemaVersion:1,status:'accepted',durable:false,operationId:'r',workspace}).mutate(mutation),/receipt/);
 await assert.rejects(make({schemaVersion:1,status:'accepted',durable:true,operationId:'wrong',workspace}).mutate(mutation),/receipt/);
});
test('old services and late cancelled requests are explicit limitations',async()=>{
 const old=createPaperReadingRemote({scope,fetcher:async()=>new Response('Not found',{status:404})});await assert.rejects(old.read('unit'),/unsupported/);
 let current=true;const late=createPaperReadingRemote({scope,isCurrent:()=>current,fetcher:async()=>{current=false;return Response.json({workspace});}});
 await assert.rejects(late.read('unit'),/cancel/);
});
