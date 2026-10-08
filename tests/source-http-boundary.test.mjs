import assert from 'node:assert/strict';
import test from 'node:test';
import {createCompanionHttp} from '../src/infrastructure/sources/index.ts';
import {sendLegacyBoundEvent} from '../src/infrastructure/sync/index.ts';
test('Companion cancellation covers response decoding even when a fetcher ignores the signal',async()=>{
 const control=new AbortController();let decode;const started=new Promise(resolve=>{decode=resolve;});
 const http=createCompanionHttp('http://synthetic.invalid',async()=>({ok:true,json:()=>{decode();return new Promise(()=>{});}}));
 const pending=http.health(control.signal);await started;control.abort(new Error('retired'));
 await assert.rejects(pending,/retired/);
});
test('retirement while reading an import file prevents a later generate request',async()=>{
 const control=new AbortController();let calls=0;const http=createCompanionHttp('http://synthetic.invalid',async()=>{calls++;});
 await assert.rejects(http.generate({token:'synthetic'},{name:'x.md',size:20,text:async()=>{control.abort();return'original';}},control.signal));assert.equal(calls,0);
});
test('legacy projection conflicts remain readable while non-conflict HTTP failures reject',async()=>{
 const body={error:'projection-mismatch',accepted:[],projectionMismatches:[{eventId:'e'}]},event={eventId:'e'};
 assert.deepEqual(await sendLegacyBoundEvent('account:synthetic',event,async()=>Response.json(body,{status:409})),body);
 await assert.rejects(sendLegacyBoundEvent('account:synthetic',event,async()=>Response.json({message:'offline'},{status:503})),/offline/);
});
