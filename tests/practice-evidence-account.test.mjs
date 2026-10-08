import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {mutation,report} from './fixtures/practice-evidence-fixtures.mjs';
const auth={principal:{kind:'browser',userId:'owner'}};
function fixture(){const calls=[],store={supported:async()=>true,read:async(scope,id)=>{calls.push({scope,id});return null;},list:async(scope,page)=>{calls.push({scope,page});return {records:[],nextCursor:null,complete:true};},mutate:async(scope,m)=>{calls.push({scope,m});return {status:'conflict',durable:false,operationId:m.operationId,revision:0,record:null};}},deps={getAccessStore:async()=>({profile:async()=>({libraryId:'library'})}),getPracticeEvidenceStore:async()=>store},app=createAccountStudyApplication(deps);return {app,store,calls};}
test('account actions reject account/library/device/closed body mismatches and missing capability',async()=>{
 const f=fixture(),send=(body,a=auth)=>f.app.post(body,a,new AbortController().signal);
 assert.equal((await send({action:'practice-evidence-read',attemptId:'attempt',expectedUserId:'owner'})).value.record,null);
 await assert.rejects(send({action:'practice-evidence-read',attemptId:'attempt',expectedUserId:'foreign'}),/account-mismatch/);
 await assert.rejects(send({action:'practice-evidence-read',attemptId:'attempt',libraryId:'foreign'}),/library-mismatch/);
 await assert.rejects(send({action:'practice-evidence-read',attemptId:'attempt',trust:true}),/invalid/);
 await assert.rejects(send({action:'practice-evidence-read',attemptId:'attempt'},{principal:{kind:'device',userId:'owner',libraryId:'library',state:'pending'}}),/action-not-allowed/);
 await assert.rejects(send({action:'practice-evidence-mutate',mutation:{...mutation('code-report',{report:report()}),binding:{...mutation('code-report').binding,ownerId:'foreign'}}}),/scope/);
 await send({action:'practice-evidence-list',limit:1,cursor:'attempt'});assert.deepEqual(f.calls.at(-1).page,{limit:1,cursor:'attempt'});
 await assert.rejects(send({action:'practice-evidence-list',limit:201}),/limit/);
 f.store.supported=async()=>false;await assert.rejects(send({action:'practice-evidence-list'}),/unsupported/);
});
