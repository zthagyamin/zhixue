// Real browser, real pinned Pyodide, synthetic state. Never touches production.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire,stripTypeScriptTypes} from 'node:module';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const out=resolve(process.env.UX_EVIDENCE||'scratch/security-python');
await mkdir(out,{recursive:true});
const origin='http://127.0.0.1:4193';
let sensitiveRequests=0;
const records=[],errors=[];
const html='<!doctype html><meta charset="utf-8"><title>Security fixture</title><script type="module">import {createPythonSandboxWorker} from "/sandbox.js";import {createPythonWorkerClient} from "/client.js";window.makeClient=(options)=>{window.client?.dispose();window.client=createPythonWorkerClient(createPythonSandboxWorker,options);return window.client.ready();};</script>';
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/api/')){sensitiveRequests++;res.end('SYNTHETIC_ACCOUNT_DATA');return;}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  // The runtime adapters share pure report/content validators. Serve their real
  // module graph while keeping filesystem, application and API paths closed.
  const domain=/^\/src\/domain\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.ts$/.test(url.pathname)?url.pathname.slice(1):undefined;
  const ts={'/sandbox.js':'app/python-sandbox.ts','/client.js':'app/python-worker-client.ts'}[url.pathname]??domain;
  if(ts){res.setHeader('Content-Type','text/javascript');res.end(stripTypeScriptTypes(await readFile(ts,'utf8')));return;}
  let path;
  if(/^\/workers\/python-(runtime\.js|assertions\.py|sandbox-frame\.html)$/.test(url.pathname))path='public'+url.pathname;
  else if(/^\/vendor\/pyodide-314\.0\.5\/(pyodide\.mjs|pyodide\.asm\.mjs|pyodide\.asm\.wasm|python_stdlib\.zip|pyodide-lock\.json)$/.test(url.pathname))path='node_modules/pyodide/'+url.pathname.split('/').at(-1);
  else{res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',path.endsWith('.mjs')||path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':path.endsWith('.wasm')?'application/wasm':'application/octet-stream');
  res.end(await readFile(path));
 }catch(error){res.statusCode=500;res.end(String(error));}
});
let browser,failure;
async function check(name,fn){await fn();records.push({name,passed:true});console.log('PASS',name);}
try{
 await new Promise(resolve=>server.listen(4193,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext();
 await context.addCookies([{name:'audit-session',value:'SYNTHETIC_ONLY',url:origin}]);
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>console.log('BROWSER',msg.type(),msg.text().slice(0,1000)));
 await page.goto(origin);await page.waitForFunction(()=>typeof window.makeClient==='function');
 await page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-local-study-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace-records');request.onsuccess=()=>{const db=request.result;const tx=db.transaction('workspace-records','readwrite');tx.objectStore('workspace-records').put('SYNTHETIC_PRIVATE_RECORD','audit');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};request.onerror=reject;}));
 await check('bridge refuses to bootstrap without an opaque sandbox',async()=>{
  const messages=await page.evaluate(()=>new Promise(resolve=>{
   const frame=document.createElement('iframe');frame.src='/workers/python-sandbox-frame.html';const channel=new MessageChannel();const received=[];
   channel.port1.onmessage=e=>received.push(e.data.type);
   frame.onload=()=>{frame.contentWindow.postMessage({type:'sandbox-bootstrap',loader:'',assembly:'',runtime:'self.postMessage({type:"result",output:"UNSANDBOXED"})',wasm:new ArrayBuffer(0),stdlib:new ArrayBuffer(0),checker:'',lockfile:{packages:{}}},'*',[channel.port2]);setTimeout(()=>{frame.remove();channel.port1.close();resolve(received);},300);};document.body.append(frame);
  }));assert.deepEqual(messages,[]);
 });
 await page.evaluate(()=>window.makeClient({loadTimeoutMs:120000,preparationTimeoutMs:120000}));
 const run=(code,testCode)=>page.evaluate(({code,testCode})=>window.client.run(code,'hello',true,testCode),{code,testCode});
 await check('real Python, stdin and assertions',async()=>{const r=await run('print(input())\nanswer=6*7','assert answer == 42');assert.equal(r.output,'hello\n');assert.equal(r.assertionsPassed,1);});
 await check('failing assertion cannot count as success',async()=>{await assert.rejects(run('answer=1','assert answer == 2'),/AssertionError/);});
 await check('no executed assertions cannot count as success',async()=>{await assert.rejects(run('answer=1','pass'),/没有执行 assert/);});
 await check('NumPy and pandas load through verified asset broker',async()=>{const r=await run('import numpy as np\nimport pandas as pd\nprint(int(np.arange(5).sum()))\nprint(int(pd.Series([1,2,3]).sum()))');assert.equal(r.output,'10\n6\n');});
 const probe=`import js, json\nchecks = {}\nchecks['origin'] = str(js.location.origin)\ntry:\n    js.indexedDB.open('zhixue-local-study-v1')\n    checks['storage'] = 'EXPOSED'\nexcept Exception:\n    checks['storage'] = 'denied'\ntry:\n    await js.fetch('${origin}/api/security-probe')\n    checks['fetch'] = 'EXPOSED'\nexcept Exception:\n    checks['fetch'] = 'denied'\ntry:\n    xhr = js.XMLHttpRequest.new()\n    xhr.open('GET', '${origin}/api/security-probe', False)\n    xhr.send()\n    checks['xhr'] = 'EXPOSED'\nexcept Exception:\n    checks['xhr'] = 'denied'\nprint(json.dumps(checks))`;
 await check('learner code cannot access host storage or APIs',async()=>{const r=await run(probe);assert.deepEqual(JSON.parse(r.output),{origin:'null',storage:'denied',fetch:'denied',xhr:'denied'});assert.equal(sensitiveRequests,0);});
 await check('testCode has the same restricted origin and network policy',async()=>{const syncProbe=probe.replace(/try:\n {4}await js\.fetch[\s\S]*?checks\['fetch'\] = 'denied'\n/, '');const r=await run('pass',syncProbe+'\nassert checks["storage"] == "denied"');assert.equal(JSON.parse(r.output).storage,'denied');assert.equal(sensitiveRequests,0);});
 const nativeProbe=`await new Promise((resolve,reject)=>{const source=${JSON.stringify(`fetch('${origin}/api/security-probe',{credentials:'include'}).then(()=>postMessage('EXPOSED')).catch(()=>postMessage('denied'));`)};const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const child=new Worker(url);child.onmessage=e=>{child.terminate();URL.revokeObjectURL(url);resolve(e.data);};child.onerror=reject;})`;
 await check('native fetch in a descendant Worker is also blocked by browser CSP',async()=>{const r=await run(`import js\nprint(await js.eval(${JSON.stringify('(async()=>{return '+nativeProbe+'})()')}))`);assert.equal(r.output,'denied\n');assert.equal(sensitiveRequests,0);});
 await check('output truncation remains enforced',async()=>{const r=await run('print("x"*30000)');assert.ok(r.output.length<=20000);assert.match(r.output,/输出已截断/);});
 await check('timeout destroys the isolated frame',async()=>{await page.evaluate(()=>window.makeClient({loadTimeoutMs:120000,runTimeoutMs:200}));await assert.rejects(run('while True: pass'),/超过时间限制/);assert.equal(await page.locator('iframe').count(),0);});
 await check('cancel destroys a running isolated frame',async()=>{await page.evaluate(()=>window.makeClient({loadTimeoutMs:120000}));const message=await page.evaluate(async()=>{const result=window.client.run('while True: pass').catch(e=>e.name);setTimeout(()=>window.client.cancel(),300);return result;});assert.equal(message,'AbortError');assert.equal(await page.locator('iframe').count(),0);});
 await check('host data remains unchanged',async()=>{const value=await page.evaluate(()=>new Promise(resolve=>{const request=indexedDB.open('zhixue-local-study-v1');request.onsuccess=()=>{const db=request.result;const r=db.transaction('workspace-records').objectStore('workspace-records').get('audit');r.onsuccess=()=>{resolve(r.result);db.close();};};}));assert.equal(value,'SYNTHETIC_PRIVATE_RECORD');assert.equal(sensitiveRequests,0);});
 assert.deepEqual(errors,[]);
 await context.close();
}catch(error){failure=String(error.stack||error);console.error(failure);process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(resolve(out,'results.json'),JSON.stringify({sha:process.env.TARGET_SHA||process.env.GITHUB_SHA,expected:12,passed:records.length,complete:!failure&&records.length===12,failure,records,errors,sensitiveRequests},null,2));}
