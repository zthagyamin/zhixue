import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const quote=value=>"'"+value.replaceAll("'","''")+"'";

test('launcher handles empty or unusable browser origins without stopping the server', {skip:process.platform!=='win32',timeout:60000},async()=>{
  const sandbox=await mkdtemp(path.join(os.tmpdir(),'zhixue-launch-origin-'));
  try {
    const cases=[
      {name:'empty list',config:{allowed_origins:[]},expected:[]},
      {name:'missing setting',config:{},expected:[]},
      {name:'null entry',config:{allowed_origins:[null]},expected:[]},
      {name:'empty string',config:{allowed_origins:['']},expected:[]},
      {name:'non-string entry',config:{allowed_origins:[12]},expected:[]},
      {name:'local HTTP',config:{allowed_origins:['http://127.0.0.1:43199']},expected:[]},
      {name:'public HTTPS',config:{allowed_origins:['https://fixture.example']},expected:['https://fixture.example/?companionPort=43199']},
    ];
    const host=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    for(const fixture of cases) {
      await writeFile(path.join(sandbox,'config.local.json'),JSON.stringify(fixture.config));
      const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$source=[IO.File]::ReadAllText(${quote(path.join(project,'companion/start-companion.ps1'))},[Text.Encoding]::UTF8);$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Source parse failed'};$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Open-ZhixueWebsite'},$true);if(-not $fn){throw 'Production launcher function missing'};. ([scriptblock]::Create($fn.Extent.Text));$script:opened=[Collections.Generic.List[string]]::new();function Start-Process {param([string]$FilePath)$script:opened.Add($FilePath)};$companionRoot=${quote(sandbox)};$port=43199;$NoBrowser=$false;$ProtocolUrl='';Open-ZhixueWebsite;[Console]::WriteLine((ConvertTo-Json -InputObject @($script:opened.ToArray()) -Compress))`;
      const run=spawnSync(host,['-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
      assert.ifError(run.error);assert.equal(run.status,0,fixture.name+': '+(run.stderr||run.stdout));
      assert.deepEqual(JSON.parse(run.stdout.trim()),fixture.expected,fixture.name);
    }
    assert.ok(await readFile(path.join(sandbox,'config.local.json')));
  } finally {
    const resolved=await realpath(sandbox),temp=await realpath(os.tmpdir());
    assert.equal(path.dirname(resolved),temp);assert.ok(path.basename(resolved).startsWith('zhixue-launch-origin-'));
    await rm(resolved,{recursive:true,force:true});
  }
});
