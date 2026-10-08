import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
let api={};try{api=await import('./fixtures/python-preview-runtime.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
test('runtime preview resolves only read-only files under the existing pinned public runtime',()=>{
  assert.equal(typeof api.runtimeAssetUrl,'function');
  assert.equal(api.runtimeAssetUrl('/__fixture/python-runtime/pyodide.js','GET'),'https://cdn.jsdelivr.net/pyodide/v314.0.5/full/pyodide.js');
  for(const [path,method]of [['/__fixture/python-runtime/../config.json','GET'],['/__fixture/python-runtime/%2e%2e%2fkey.json','GET'],['/__fixture/python-runtime/pyodide.js','POST'],['/api/session','GET']])assert.throws(()=>api.runtimeAssetUrl(path,method));
});
test('only the existing runtime URLs are rewritten for the test origin',()=>{
  assert.equal(typeof api.rewriteRuntimeUrls,'function');
  const source="import('https://cdn.jsdelivr.net/pyodide/v314.0.5/full/pyodide.mjs')",rewritten=api.rewriteRuntimeUrls(source,'http://127.0.0.1:3011');
  const isolated=readFileSync(new URL('../public/workers/python-runtime.js',import.meta.url),'utf8');assert.match(isolated,/__zhixueSandboxRuntime/);assert.doesNotMatch(isolated,/https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(rewritten,/https:\/\/cdn.jsdelivr.net\/pyodide/);assert.match(rewritten,/http:\/\/127.0.0.1:3011\/__fixture\/python-runtime\//);
});
test('runtime cache coalesces downloads, omits credentials and retries a failed read',async()=>{
  assert.equal(typeof api.createPythonPreviewAssets,'function');let calls=0;
  const assets=api.createPythonPreviewAssets(async(url,options)=>{calls++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);if(calls===1)throw new Error('offline');return new Response('test-runtime',{headers:{'content-type':'text/javascript'}});});
  await assert.rejects(assets.load('/__fixture/python-runtime/pyodide.js','GET'));
  const results=await Promise.all([assets.load('/__fixture/python-runtime/pyodide.js','GET'),assets.load('/__fixture/python-runtime/pyodide.js','GET')]);
  assert.equal(calls,2);assert.equal(new TextDecoder().decode(results[0].bytes),'test-runtime');
});
