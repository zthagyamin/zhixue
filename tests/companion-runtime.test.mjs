import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,cp,mkdir,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=path.resolve('companion');
const quote=value=>`'${value.replaceAll("'","''")}'`;

test('fresh setup works offline without PATH Python and never asks for private developer directories',{skip:process.platform!=='win32'},async()=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'zhixue-setup-offline-'));
 try{
  const target=path.join(temporary,'new user');await cp(root,target,{recursive:true,filter:source=>{const relative=path.relative(root,source).replaceAll('\\','/');return !relative.split('/').some(part=>['.venv','runtime','__pycache__','config.local.json'].includes(part)||part.startsWith('.env'))&&(!relative.startsWith('data/')||relative==='data/seed.json');}});
  const result=spawnSync('pwsh.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; $env:PATH=$env:SystemRoot+'\\System32'; & ${quote(path.join(target,'setup-and-start.ps1'))} -NoStart -SkipRegistration; . ${quote(path.join(target,'runtime-helpers.ps1'))}; $python=Get-ZhixueRuntime -Root ${quote(target)}; & $python -I -c 'import server; print("SERVER_IMPORT_OK")'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/SERVER_IMPORT_OK/);const config=JSON.parse(await readFile(path.join(target,'config.local.json'),'utf8'));
  assert.equal(config.workspace_mode,'managed');assert.ok(config.learning_vault_root.startsWith(target));
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('offline runtime starts without system Python and supports a Unicode installation path',{skip:process.platform!=='win32'},async()=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'zhixue-runtime-test-'));
 try{
  const target=path.join(temporary,'用户 空格');await mkdir(target);
  for(const name of ['runtime-manifest.json','runtime-windows-x64.zip','runtime-helpers.ps1'])await cp(path.join(root,name),path.join(target,name));
  const result=spawnSync('pwsh.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; . ${quote(path.join(target,'runtime-helpers.ps1'))}; $env:PATH=$env:SystemRoot+'\\System32'; $runtime=Get-ZhixueRuntime -Root ${quote(target)}; & $runtime -I -c 'import sys,json,pypdf,keyring; from zoneinfo import ZoneInfo; print(json.dumps({"version":sys.version_info[:2],"timezone":str(ZoneInfo("Asia/Shanghai"))}))'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/3, 14/);assert.match(result.stdout,/Asia\/Shanghai/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('runtime selection refuses a missing bundle instead of claiming installation success',{skip:process.platform!=='win32'},async()=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'zhixue-runtime-missing-'));
 try{
  const helper=path.join(root,'runtime-helpers.ps1');const result=spawnSync('pwsh.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; . ${quote(helper)}; Get-ZhixueRuntime -Root ${quote(temporary)}`],{encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stderr+result.stdout,/runtime-bundle-missing/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
