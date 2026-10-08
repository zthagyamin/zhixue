import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('shared program manifest rejects unsafe paths, personal data and duplicate entries before installation',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zhixue-program-manifest-'));
 const helper=fileURLToPath(new URL('../companion/program-manifest.ps1',import.meta.url));
 const valid=JSON.parse(await readFile(new URL('../companion/program-files.json',import.meta.url),'utf8'));
 const script=join(directory,'check.ps1');
 await writeFile(script,"param([string]$Helper,[string]$Root)\n$ErrorActionPreference='Stop'\n. $Helper\n@(Read-CompanionProgramFiles $Root) | ConvertTo-Json -Compress\n");
 try{
  const run=manifest=>writeFile(join(directory,'program-files.json'),JSON.stringify(manifest)).then(()=>spawnSync('pwsh.exe',['-NoProfile','-File',script,helper,directory],{encoding:'utf8',windowsHide:true}));
  const good=await run(valid);assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(good.stdout),valid.files);
  for(const extra of ['../escape.py','/absolute.py','C:/escape.py','config.local.json','data/events.json','SERVER.PY']){
   const bad=await run({...valid,files:[...valid.files,extra]});assert.notEqual(bad.status,0,extra);assert.match(bad.stderr,/Unsafe or duplicate/);
  }
  const missing=await run({...valid,files:valid.files.filter(name=>name!=='program-files.json')});assert.notEqual(missing.status,0);assert.match(missing.stderr,/Incomplete/);
  for(const version of ['1',true,2]){const bad=await run({...valid,schemaVersion:version});assert.notEqual(bad.status,0);assert.match(bad.stderr,/Invalid/);}
 }finally{
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
 }
});
