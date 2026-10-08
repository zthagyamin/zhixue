import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAccountStudyClient} from '../app/account-study-client.ts';
test('AI settings can discover the account library without downloading learning materials or changing the client binding',async()=>{
  const requests=[];const fetcher=async raw=>{const url=new URL(raw,'https://example.test');requests.push(url);return new Response(JSON.stringify(url.searchParams.get('action')==='bootstrap'?{profile:{libraryId:'library-mobile'}}:{settings:{}}),{headers:{'Content-Type':'application/json'}});};
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-mobile',cache:null,fetcher});
  assert.equal(await client.currentLibrary(),'library-mobile');
  assert.equal(requests.length,1);assert.equal(requests[0].searchParams.get('expectedUserId'),'user-mobile');
  await client.aiWorkspaceRequest('settings');assert.equal(requests[1].searchParams.get('libraryId'),null);
  const settingsClient=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-mobile',libraryId:'library-mobile',cache:null,fetcher});
  await settingsClient.aiWorkspaceRequest('settings');assert.equal(requests[2].searchParams.get('libraryId'),'library-mobile');
});
test('a new account has an explicit missing-library state instead of a made-up scope',async()=>{
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-mobile',cache:null,fetcher:async()=>new Response(JSON.stringify({profile:{libraryId:null}}))});
  assert.equal(await client.currentLibrary(),null);
});
