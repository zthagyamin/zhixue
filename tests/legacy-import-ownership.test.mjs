import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {migrateLegacyLocalStorage,loadWorkspaceRecord,saveWorkspaceRecord,exportRecoveryWorkspaceRecords,openStudyDb} from '../app/local-study-db.ts';
import {importLegacyLocalRecord} from '../src/infrastructure/sources/index.ts';
import {readWorkspaceSnapshot} from '../src/application/sources/index.ts';
import {createHooks,loader} from './helpers/causal-harness.mjs';

function fixture(){
  globalThis.indexedDB=new IDBFactory();
  const values=new Map([['study-loop-progress-v3',JSON.stringify({marker:'synthetic-legacy'})]]);
  globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};
  return values;
}

test('one legacy source can be imported by only one concurrent workspace',async()=>{
  fixture();const owners=['account:synthetic-a','account:synthetic-b'];
  await Promise.all(owners.map(owner=>migrateLegacyLocalStorage(owner,'study-loop-progress-v3','progress',null)));
  const stored=await Promise.all(owners.map(owner=>loadWorkspaceRecord(owner,'progress',null)));
  assert.equal(stored.filter(Boolean).length,1);
});

test('actual workspace hydration snapshots do not duplicate a legacy progress value across identities',async()=>{
  fixture();
  const hooks=createHooks(),load=loader(hooks.api,{
    'app/local-study-db.ts':{migrateLegacyLocalStorage,loadWorkspaceRecord},
    'app/study-dashboard/prelude.ts':{emptyProgress:{marker:'empty'},emptyCloudSyncMetadata:{},pendingActivityKey:'synthetic-pending',companionUrl:'http://127.0.0.1:43121'},
    'app/plugin-routing.ts':{emptyPluginOverrides:{}},
  });
  const storage=load('app/study-dashboard/workspace-source-adapter.ts').readWorkspaceSource;
  const results=await Promise.all(['a','b'].map(userId=>readWorkspaceSnapshot({
    identity:async()=>({userId}),owner:identity=>'account:synthetic-'+identity.userId,storage,identified:()=>{},
  },new AbortController().signal)));
  assert.equal(results.filter(row=>row.stored.savedProgress.marker==='synthetic-legacy').length,1);
});

test('existing destination data and existing legacy owner remain intact',async()=>{
  const values=fixture();values.set('zhixue-migration-owner:study-loop-progress-v3','account:synthetic-a');
  await saveWorkspaceRecord('account:synthetic-a','progress',{marker:'newer-data'});
  assert.deepEqual(await migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null),{marker:'newer-data'});
  assert.equal(await migrateLegacyLocalStorage('account:synthetic-b','study-loop-progress-v3','progress',null),null);
  assert.equal(values.get('zhixue-migration-owner:study-loop-progress-v3'),'account:synthetic-a');
});

test('missing durable storage cannot claim or return an imported record',async()=>{
  const values=fixture();delete globalThis.indexedDB;
  assert.equal(await migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null),null);
  assert.equal(values.has('zhixue-migration-owner:study-loop-progress-v3'),false);
  assert.equal(values.get('study-loop-progress-v3'),JSON.stringify({marker:'synthetic-legacy'}));
});

test('failed compatibility marker write retains the durable answer and ownership',async()=>{
  const values=fixture();globalThis.localStorage.setItem=()=>{throw Error('synthetic-storage-full');};
  const value=await migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null);
  assert.deepEqual(value,{marker:'synthetic-legacy'});
  assert.equal(values.has('zhixue-migration-owner:study-loop-progress-v3'),false);
  assert.equal(await migrateLegacyLocalStorage('account:synthetic-b','study-loop-progress-v3','progress',null),null);
  globalThis.IDBKeyRange=IDBKeyRange;
  const exported=await exportRecoveryWorkspaceRecords('account:synthetic-a');
  assert.equal(exported.length,1);assert.equal(exported[0].kind,'progress');
});

test('an aborted import leaves no destination or owner claim and can be retried',async()=>{
  const values=fixture(),original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(row,...rest){
    const request=original.call(this,row,...rest);
    if(row.kind==='progress')this.transaction.abort();
    return request;
  };
  try{assert.equal(await migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null),null);}
  finally{IDBObjectStore.prototype.put=original;}
  assert.equal(await loadWorkspaceRecord('account:synthetic-a','progress',null),null);
  assert.equal(values.has('zhixue-migration-owner:study-loop-progress-v3'),false);
  assert.deepEqual(await migrateLegacyLocalStorage('account:synthetic-b','study-loop-progress-v3','progress',null),{marker:'synthetic-legacy'});
});

test('same-owner retries preserve source bytes and return the same durable value',async()=>{
  const values=fixture(),raw=values.get('study-loop-progress-v3');
  const results=await Promise.all(Array.from({length:4},()=>migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null)));
  assert.deepEqual(results,Array.from({length:4},()=>({marker:'synthetic-legacy'})));
  assert.equal(values.get('study-loop-progress-v3'),raw);
});

test('a destination saved while import is opening wins over the old source',async()=>{
  fixture();
  const result=await importLegacyLocalRecord({
    open:async()=>{await saveWorkspaceRecord('account:synthetic-a','progress',{marker:'newer-data'});return openStudyDb();},
    storeName:'workspace-records',workspaceId:'account:synthetic-a',destinationId:'account:synthetic-a:progress',
    kind:'progress',legacyKey:'study-loop-progress-v3',raw:JSON.stringify({marker:'synthetic-legacy'}),
    value:{marker:'synthetic-legacy'},fallback:null,storage:globalThis.localStorage,
  });
  assert.deepEqual(result,{marker:'newer-data'});
  assert.deepEqual(await loadWorkspaceRecord('account:synthetic-a','progress',null),{marker:'newer-data'});
});

test('source or old owner changes before commit leave both destination and claim untouched',async()=>{
  for(const change of ['source','owner']){
    const values=fixture();
    const result=await importLegacyLocalRecord({
      open:async()=>{
        if(change==='source')values.set('study-loop-progress-v3',JSON.stringify({marker:'updated-source'}));
        else values.set('zhixue-migration-owner:study-loop-progress-v3','account:synthetic-b');
        return openStudyDb();
      },
      storeName:'workspace-records',workspaceId:'account:synthetic-a',destinationId:'account:synthetic-a:progress',
      kind:'progress',legacyKey:'study-loop-progress-v3',raw:JSON.stringify({marker:'synthetic-legacy'}),
      value:{marker:'synthetic-legacy'},fallback:null,storage:globalThis.localStorage,
    });
    assert.equal(result,null);assert.equal(await loadWorkspaceRecord('account:synthetic-a','progress',null),null);
    assert.deepEqual(await migrateLegacyLocalStorage('account:synthetic-b','study-loop-progress-v3','progress',null),
      {marker:change==='source'?'updated-source':'synthetic-legacy'});
  }
});

test('unknown internal ownership versions cannot be reinterpreted as unowned',async()=>{
  fixture();const db=await openStudyDb();
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction('workspace-records','readwrite');
    tx.objectStore('workspace-records').put({id:['legacy-local-import',1,'study-loop-progress-v3'],schemaVersion:2,owner:'account:synthetic-a'});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  assert.equal(await migrateLegacyLocalStorage('account:synthetic-a','study-loop-progress-v3','progress',null),null);
});
