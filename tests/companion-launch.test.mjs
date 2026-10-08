import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';import os from 'node:os';
const q=v=>"'"+v.replaceAll("'","''")+"'";
// Shell bootstrap is not the application. Keep the original ten-second app
// budget, with a separate bounded window for a cold Windows PowerShell host.
async function launch(host,code){
 return new Promise(resolve=>{
  const start=Date.now(),marker='ZHIXUE_TEST_HOST_READY',child=spawn(host,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(`[Console]::WriteLine('${marker}'); ${code}`,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',readyAt=null,error=null,done=false;
  let timer=setTimeout(()=>{error=Error('PowerShell host bootstrap exceeded 30 seconds');child.kill();},30000);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;if(readyAt===null&&stdout.includes(marker)){readyAt=Date.now();clearTimeout(timer);timer=setTimeout(()=>{error=Error('Companion entry exceeded its ten-second budget');child.kill();},10000);}});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const finish=status=>{if(done)return;done=true;clearTimeout(timer);resolve({status,error,stdout,stderr,hostStartupMs:readyAt===null?null:readyAt-start});};
  child.on('error',reason=>{error=reason;finish(null);});child.on('close',finish);
 });
}
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
 const result=await launch(host,code);assert.equal(result.error,null,`${name}: ${result.error?.message??''}`);assert.notEqual(result.hostStartupMs,null,'Host-ready observation is required');assert.equal(result.status,0,`${name}: ${result.stderr ?? ''}\n${result.stdout ?? ''}`);
 if(opens)assert.equal(await readFile(output,'utf8'),'https://zhixue-daily.zthagyamin.chatgpt.site/?companionPort=43125');else await assert.rejects(readFile(output),{code:'ENOENT'});
 }
 }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
