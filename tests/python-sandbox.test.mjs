import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isRuntimeAssetName, runtimeAssetURL,createPythonSandboxWorker} from '../app/python-sandbox.ts';
const bridge=readFileSync(new URL('../public/workers/python-sandbox-frame.html',import.meta.url),'utf8');
const hook=readFileSync(new URL('../app/hooks/use-pyodide.ts',import.meta.url),'utf8');
const runtime=readFileSync(new URL('../public/workers/python-runtime.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../app/python-sandbox.ts',import.meta.url),'utf8');

test('asset broker accepts only exact immutable lockfile filenames',()=>{
 const file='numpy-2.4.0-cp314-cp314-pyodide_2026_0_wasm32.whl';
 const assets=new Map([[file,{file_name:file,sha256:'a'.repeat(64)}]]);
 assert.equal(isRuntimeAssetName(file),true);
 assert.equal(runtimeAssetURL(file,assets),`https://cdn.jsdelivr.net/pyodide/v314.0.5/full/${file}`);
 for(const value of ['https://example.invalid/'+file,'../'+file,file+'?secret=x',file+'#x','/api/session','%2e%2e%2f'+file,'other.whl',null,{}])assert.equal(runtimeAssetURL(value,assets),null);
});
test('Python entry has no main-origin fallback and the bridge denies direct networking',()=>{
 assert.match(hook,/createPythonSandboxWorker\(\)/);assert.doesNotMatch(hook,/new Worker/);
 assert.match(host,/setAttribute\('sandbox', 'allow-scripts'\)/);assert.doesNotMatch(host,/allow-same-origin/);
 assert.match(bridge,/connect-src 'none'/);assert.match(bridge,/frame-src 'none'/);
 assert.match(bridge,/worker-src blob:/);assert.match(bridge,/event\.source !== parent/);
 assert.match(bridge,/self\.origin !== 'null'/);assert.match(bridge,/type: 'classic'/);assert.match(bridge,/Opaque origin required/);assert.match(runtime,/必须通过隔离环境/);
 assert.doesNotMatch(runtime,/cdn\.jsdelivr\.net|import\('\/vendor/);
});
test('runtime requests omit credentials, forbid redirects and verify package hashes',()=>{
 assert.match(host,/credentials: 'omit'/);assert.match(host,/redirect: 'error'/);
 assert.match(host,/crypto\.subtle\.digest\('SHA-256'/);
 assert.match(host,/MAX_TOTAL_BYTES/);assert.match(host,/packageCache\.size >= 32/);
});
test('the actual opaque relay preserves bounded diagnostics and drops arbitrary worker fields',async()=>{
 const originals={fetch:globalThis.fetch,document:globalThis.document,MessageChannel:globalThis.MessageChannel};
 let channel,attached;const ready=new Promise(resolve=>attached=resolve),messages=[];
 const frame={style:{},setAttribute(){},addEventListener(){},remove(){},contentWindow:{postMessage(){}}};
 globalThis.document={createElement:()=>frame,body:{appendChild(){attached();}}};
 globalThis.MessageChannel=class{constructor(){this.port1={onmessage:null,postMessage(){},close(){}};this.port2={close(){}};channel={port1:this.port1};}};
 globalThis.fetch=async url=>{assert.match(String(url),/^\/vendor\/|^\/workers\//);return String(url).endsWith('pyodide-lock.json')?Response.json({packages:{}}):new Response('synthetic runtime bytes');};
 const worker=createPythonSandboxWorker();worker.onmessage=event=>messages.push(event.data);
 try{
  await ready;channel.port1.onmessage({data:{type:'error',id:1,error:'bad test',executionPhase:'test-definition',assertionFailure:false,testDefinitionError:true,secret:'drop'}});
  assert.equal(messages.at(-1).executionPhase,'test-definition');assert.equal(messages.at(-1).testDefinitionError,true);assert.equal(messages.at(-1).secret,undefined);
  channel.port1.onmessage({data:{type:'error',id:1,executionPhase:{injected:true},assertionFailure:'true',testDefinitionError:1}});
  assert.equal(messages.at(-1).executionPhase,undefined);assert.equal(messages.at(-1).assertionFailure,false);assert.equal(messages.at(-1).testDefinitionError,false);
 }finally{worker.terminate();Object.assign(globalThis,originals);}
});

test('the opaque report boundary preserves only valid closed reports and blocks malformed report downgrades',async()=>{
 const originals={fetch:globalThis.fetch,document:globalThis.document,MessageChannel:globalThis.MessageChannel};let channel,attached;const ready=new Promise(resolve=>attached=resolve),messages=[];
 const frame={setAttribute(){},addEventListener(){},remove(){},contentWindow:{postMessage(){}}};
 globalThis.document={createElement:()=>frame,body:{appendChild(){attached();}}};
 globalThis.MessageChannel=class{constructor(){this.port1={onmessage:null,postMessage(){},close(){}};this.port2={};channel={port1:this.port1};}};
 globalThis.fetch=async url=>String(url).endsWith('pyodide-lock.json')?Response.json({packages:{}}):new Response('synthetic bytes');
 const worker=createPythonSandboxWorker();worker.onmessage=event=>messages.push(event.data);
 try{await ready;const report={schemaVersion:1,runId:1,status:'passed',phase:'tests',outcome:'success',assertionsPassed:2,assertionsExecuted:2,mapping:{prefixLineCount:0,originalLineCount:1}};
 channel.port1.onmessage({data:{type:'result',id:1,report,secret:'drop'}});assert.deepEqual(messages.at(-1).report,report);assert.equal(messages.at(-1).secret,undefined);
 channel.port1.onmessage({data:{type:'result',id:1,report:{...report,arbitrary:'drop'},assertionsPassed:5}});assert.equal(messages.at(-1).report,null);
 }finally{worker.terminate();Object.assign(globalThis,originals);}
});
