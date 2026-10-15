import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {attachPracticeDriver} from '../src/infrastructure/practice-evidence/host-runtime.ts';
import {sourceCodeReports} from '../src/infrastructure/source-admission/code-reports.ts';
import {createHooks,loader,text,tick,waitForObservation} from './helpers/causal-harness.mjs';

globalThis.indexedDB=new IDBFactory();
const scope={workspaceId:'source-hint-host',ownerId:'hint-host-owner',libraryId:'hint-host-library',
 snapshotId:'snapshot',itemKey:'code',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false};
const report=runtime=>({schemaVersion:1,runId:1,status:'failed',phase:'program',outcome:'unknown',
 assertionsPassed:0,assertionsExecuted:0,mapping:{prefixLineCount:0,originalLineCount:1},
 identity:{attemptId:runtime.session.snapshot().attemptId,revision:runtime.session.snapshot().submitted.answerRevision,
 sourceVersion:scope.contentHash,testVersion:scope.contentHash}});

test('controlled hints revalidate an old local model cache through their service',async()=>{
 const runtime=await createNonWordRuntime({...scope,roundId:'cache'},'code');await runtime.session.submit('original');
 const legacy=await attachPracticeDriver({runtime},runtime,{requestHint:async()=> 'Old legacy hint.'}),run=report(runtime);
 await legacy.runtime.practice.recordCodeReport(run);
 await legacy.runtime.practice.requestCodeHint(run);
 let controlled=0;
 const restored=await attachPracticeDriver({runtime},runtime,{revalidateHint:true,requestHint:async()=>{
   controlled++;throw Error('source-admission-code-hint-unsupported');
 }});
 assert.equal((await restored.runtime.practice.codeFeedback()).hint,undefined);
 const hooks=createHooks(),load=loader(hooks.api);
 const {CodeCaseFeedback}=load('src/features/code-study/feedback.tsx');
 let observed=false;
 const practice={...restored.runtime.practice,codeFeedback:async()=>{
   const value=await restored.runtime.practice.codeFeedback();observed=true;return value;
 }};
 const props={report:run,practice,requestHint:()=>practice.requestCodeHint(run)};
 hooks.mount(CodeCaseFeedback,props);hooks.flush();
 await waitForObservation(async()=>{await tick();hooks.render(props);hooks.flush();},()=>observed,
   {label:'controlled feedback read'});await tick();hooks.render(props);
 assert.doesNotMatch(text(hooks.view()),/Old legacy hint/);
 hooks.unmount();
 await assert.rejects(restored.runtime.practice.requestCodeHint(run),/unsupported/);
 assert.equal(controlled,1);
 assert.equal(runtime.session.snapshot().formal,null);
});

test('a controlled hint remains visible after validation and requires receipt recovery after reopen',async()=>{
 const runtime=await createNonWordRuntime({...scope,roundId:'validated'},'code');await runtime.session.submit('original');
 let calls=0;
 const options={revalidateHint:true,requestHint:async()=>{calls++;return 'A controlled hint.';}};
 const first=await attachPracticeDriver({runtime},runtime,options),run=report(runtime);
 await first.runtime.practice.recordCodeReport(run);
 assert.equal((await first.runtime.practice.codeFeedback()).hint,undefined);
 await first.runtime.practice.requestCodeHint(run);
 assert.equal((await first.runtime.practice.codeFeedback()).hint.text,'A controlled hint.');
 const reopened=await attachPracticeDriver({runtime},runtime,options);
 assert.equal((await reopened.runtime.practice.codeFeedback()).hint,undefined);
 await reopened.runtime.practice.requestCodeHint(run);
 assert.equal((await reopened.runtime.practice.codeFeedback()).hint.text,'A controlled hint.');
 assert.equal(calls,2);
 assert.equal(runtime.session.snapshot().formal,null);
});

test('the parent reader fetches exact saved child reports without replacing parent evidence',async()=>{
 const parentRuntime=await createNonWordRuntime({...scope,roundId:'child'},'code');await parentRuntime.session.submit('parent');
 const parent=await attachPracticeDriver({runtime:parentRuntime},parentRuntime),first=report(parentRuntime);
 await parent.runtime.practice.recordCodeReport(first);
 const childRuntime=await createNonWordRuntime({...scope,roundId:'child'},'code',{purpose:'remediation',
   parentAttemptId:parentRuntime.session.snapshot().attemptId,instanceId:'inline-child'});
 await childRuntime.session.submit('child');
 const child=await attachPracticeDriver({runtime:childRuntime},childRuntime),latest=report(childRuntime);
 await child.runtime.practice.recordCodeReport(latest);
 await parent.runtime.practice.recordPrepared({instanceId:'inline-child',attemptId:childRuntime.session.snapshot().attemptId});
 assert.deepEqual(await sourceCodeReports(parent.runtime.practice)(childRuntime.session.snapshot()),[latest]);
 assert.equal(parent.runtime.practice.snapshot().attemptId,parentRuntime.session.snapshot().attemptId);
 assert.deepEqual(parent.runtime.practice.snapshot().execution.first,first);
 assert.equal(parentRuntime.session.snapshot().submitted.answer,'parent');
});
