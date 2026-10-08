// Read-only benchmark of actual old/current Dashboard callbacks with synthetic
// D1 + IndexedDB. No HTTP server, real account, Vault or provider calls.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {IDBFactory,IDBKeyRange,IDBDatabase,IDBObjectStore} from 'fake-indexeddb';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import * as local from '../app/local-account-study.ts';
import {foldCoreReceiptNotice} from '../app/study-submission-status.ts';
const baseline='33eae20312358e75836a52a605aefcfb16d893c1';
const oldText=execFileSync('git',['show',`${baseline}:app/study-dashboard.tsx`],{encoding:'utf8'}),newText=readFileSync(new URL('../app/study-dashboard.tsx',import.meta.url),'utf8');
function callback(text,env){const source=ts.createSourceFile('dashboard.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
  function walk(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='applyAccountLoaded')expression=node.initializer.arguments[0];ts.forEachChild(node,walk);}walk(source);
  const code=ts.transpileModule(`return (${expression.getText(source)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;return new Function(...Object.keys(env),code)(...Object.values(env));
}
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const origin='http://127.0.0.1:3004',fixture=await createAccountPreview({origin,scenario:'completed-15'});
try{
  const client=createAccountStudyClient({expectedUserId:fixture.userId,fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return fixture.handle(new Request(new URL(url,origin),{...init,headers}));}}),loaded=await client.load(),workspaceId=`account:${fixture.userId}`;
  await local.putLocalStudySnapshot(workspaceId,loaded.bundle,0);await local.materializeStudyHistory(workspaceId,loaded.bundle.snapshot.libraryId,loaded.bundles,loaded.records,loaded.writebacks);
  let notices=0;const env={accountWorkspaceId:workspaceId,workspaceId,accountModeEpoch:{current:0},accountApplyEpoch:{current:0},eventMutation:{current:0},taskWorkspaceRef:{current:workspaceId},accountLoadedRef:{current:loaded},accountBundlesRef:{current:new Map()},accountAttemptActiveRef:{current:true},accountPendingLoadedRef:{current:null},...local,foldCoreReceiptNotice,setLastStudyReceipts:fn=>{notices++;fn({});},setAccountReadStatus(){}};
  const before=callback(oldText,env),after=callback(newText,env),samples={before:[],after:[]},counts={before:null,after:null};
  const transaction=IDBDatabase.prototype.transaction,put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;let transactions=0,writes=0;
  IDBDatabase.prototype.transaction=function(...args){transactions++;return transaction.apply(this,args);};
  for(const [name,fn]of [['put',put],['add',add]])IDBObjectStore.prototype[name]=function(...args){writes++;return fn.apply(this,args);};
  try{for(let i=0;i<5;i++)for(const [name,fn]of i%2?[['after',after],['before',before]]:[['before',before],['after',after]]){
    transactions=0;writes=0;notices=0;const start=performance.now();await fn(loaded,0);samples[name].push(Number((performance.now()-start).toFixed(2)));counts[name]={transactions,writes,noticeUpdates:notices};
  }}finally{IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
  const median=values=>[...values].sort((a,b)=>a-b)[2];
  process.stdout.write(JSON.stringify({baseline,fixture:'completed-15, warmed cache, active question',items:loaded.bundle.items.length,records:loaded.records.length,iterations:5,samplesMs:samples,medianMs:{before:median(samples.before),after:median(samples.after)},counts,note:'In-memory local materialization only, not real-site load timing.'},null,2)+'\n');
}finally{await fixture.close();}
