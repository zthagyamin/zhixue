import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assetMatches,prepareCompanionAssets,prepareCompanionRuntime} from '../scripts/prepare-companion-assets.mjs';
import {companionDownloads} from '../src/infrastructure/downloads/index.mjs';

test('build asset integrity requires exact size and digest',()=>{
 const bytes=Buffer.from('synthetic asset');
 const expected={sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.equal(assetMatches(bytes,expected),true);
 assert.equal(assetMatches(Buffer.from('tampered asset'),expected),false);
 assert.equal(assetMatches(bytes,{...expected,sizeBytes:bytes.length+1}),false);
});

test('runtime preparation accepts only the verified local bundle and rejects unsafe manifest paths',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zhixue-runtime-asset-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');
 await mkdir(join(root,'companion'),{recursive:true});
 const bytes=Buffer.from('synthetic runtime fixture');
 const manifest={archive:'runtime-windows-x64.zip',sha256:createHash('sha256').update(bytes).digest('hex')};
 await writeFile(join(root,'companion/runtime-manifest.json'),JSON.stringify(manifest));
 await writeFile(join(root,'companion/runtime-windows-x64.zip'),bytes);
 assert.deepEqual(await prepareCompanionRuntime(root),{runtimeCached:true});
 await writeFile(join(root,'companion/runtime-manifest.json'),JSON.stringify({...manifest,archive:'../outside.zip'}));
 await assert.rejects(prepareCompanionRuntime(root),/Invalid runtime manifest/);
 assert.deepEqual(await readFile(join(root,'companion/runtime-windows-x64.zip')),bytes);
});

test('failed or tampered downloads never replace an existing source asset',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zhixue-asset-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');
 const directory=join(root,'public/downloads');await mkdir(directory,{recursive:true});
 const target=join(directory,companionDownloads.downloads.installer.filename);
 await writeFile(target,'keep original');
 await assert.rejects(prepareCompanionAssets(root,{fetcher:async()=>new Response('wrong asset')}),/hash\/size mismatch/);
 assert.equal(await readFile(target,'utf8'),'keep original');
 await assert.rejects(prepareCompanionAssets(root,{fetcher:async()=>new Response('',{status:503})}),/download failed/);
 assert.equal(await readFile(target,'utf8'),'keep original');
});
