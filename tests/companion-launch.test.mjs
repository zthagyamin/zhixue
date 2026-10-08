import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';import os from 'node:os';
const q=v=>"'"+v.replaceAll("'","''")+"'";
test('Windows protocol/start entry reopens the homepage for existing process and respects no-browser modes',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'zhixue-launch-'));const target=path.join(root,'已有 用户');await mkdir(path.join(target,'data'),{recursive:true});
 try{
 await writeFile(path.join(target,'start-companion.ps1'),'\ufeff'+(await readFile('companion/start-companion.ps1','utf8')).replace(/^\uFEFF/,''));
 await writeFile(path.join(target,'config.local.json'),JSON.stringify({allowed_origins:['https://zhixue-daily.zthagyamin.chatgpt.site'],port:43125}));
 await writeFile(path.join(target,'data/runtime-instance.json'),JSON.stringify({instanceId:'isolated-test'}));
 await writeFile(path.join(target,'runtime-helpers.ps1'),"function Get-ZhixuePort { return 43125 }; function Get-ZhixueRunning { return [pscustomobject]@{instanceId='isolated-test'} }");
 const host=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 for(const [name,args,opens] of [['normal','',true],['no-browser','-NoBrowser',false],['protocol',"-ProtocolUrl 'zhixue-companion://start'",false]]){
 const output=path.join(root,name+'.txt');const code=`function Start-Process { param([string]$FilePath) [IO.File]::WriteAllText(${q(output)},$FilePath) }; & ${q(path.join(target,'start-companion.ps1'))} ${args}`;
 const result=spawnSync(host,['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,0,`${name}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
 if(opens)assert.equal(await readFile(output,'utf8'),'https://zhixue-daily.zthagyamin.chatgpt.site/?companionPort=43125');else await assert.rejects(readFile(output),{code:'ENOENT'});
 }
 }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
