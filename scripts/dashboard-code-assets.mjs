import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

/** Existing same-origin runtime bytes; no downloads, preparation or external resource access. */
export async function verifyDashboardCodeAssets(repo,origin){
  const url=new URL(origin);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
  const paths=['workers/python-sandbox-frame.html','workers/python-runtime.js','workers/python-assertions.py',
    ...['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json'].map(name=>'vendor/pyodide-314.0.5/'+name)];
  const results=[];
  for(const path of paths){
    const expected=await readFile(resolve(repo,'public',path));
    const response=await fetch(new URL('/'+path,origin),{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,'QA runtime asset: '+path);
    const contentType=response.headers.get('content-type')??'';
    if(path.endsWith('.html'))assert.match(contentType,/text\/html/);else assert.doesNotMatch(contentType,/text\/html/,'HTML fallback is not a runtime asset');
    const body=Buffer.from(await response.arrayBuffer());assert.equal(body.length,expected.length);
    const sha256=createHash('sha256').update(body).digest('hex');
    assert.equal(sha256,createHash('sha256').update(expected).digest('hex'),'QA asset bytes match actual public file');
    results.push({path,bytes:body.length,sha256,contentType});
  }
  return results;
}
