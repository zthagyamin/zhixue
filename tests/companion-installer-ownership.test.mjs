import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {withFixtureCleanup} from './helpers/fixture-cleanup.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
let sandbox, exe, refusedExe, cleanupFailureExe;

function powershell(script) {
  const result = spawnSync(host, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {encoding:'utf8', windowsHide:true, timeout:20000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function until(observe, label) {
  const deadline = performance.now() + 10000;
  do {
    const value = await observe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  throw new Error(label);
}

async function marker(target, name) {
  return until(async () => {
    try { return JSON.parse(await readFile(path.join(target, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }, 'Controlled installer process did not publish its marker');
}

function alive(identity) {
  assert.match(String(identity.pid), /^\d+$/);
  assert.match(identity.created, /^\d+$/);
  return powershell(`$p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToFileTimeUtc().ToString() -eq '${identity.created}'){'alive'}else{'gone'}`) === 'alive';
}

async function release(target, identities) {
  await writeFile(path.join(target, 'release'), 'release');
  for (const identity of identities) {
    if (!identity) continue;
    await until(() => !alive(identity), 'Owned fixture process did not stop after release');
  }
}

before(async () => {
  if (process.platform !== 'win32') return;
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'zhixue-installer-owner-'));
  const payload = path.join(sandbox, 'payload', 'zhixue-companion');
  await mkdir(payload, {recursive:true});
  const writeScript = (name, text) => writeFile(path.join(payload, name), '\ufeff' + text);
  await writeFile(path.join(payload, 'version.json'), '{"version":"1.42.2"}');
  await writeScript('hold-file.ps1', String.raw`param([string]$TargetPath)
$held=[IO.File]::Open((Join-Path $TargetPath 'occupied.tmp'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
 $identity=@{pid=$PID;created=(Get-Process -Id $PID).StartTime.ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress
 [IO.File]::WriteAllText((Join-Path $TargetPath 'grandchild.json'),$identity,[Text.UTF8Encoding]::new($false))
 while(-not (Test-Path -LiteralPath (Join-Path $TargetPath 'release'))){Start-Sleep -Milliseconds 100}
}finally{$held.Dispose()}
`);
  await writeScript('install-or-upgrade.ps1', String.raw`param([string]$PayloadRoot,[string]$TargetPath,[switch]$NoStart,[switch]$SkipRegistration,[switch]$NonInteractive)
$ErrorActionPreference='Stop'
$identity=@{pid=$PID;created=(Get-Process -Id $PID).StartTime.ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $TargetPath 'parent.json'),$identity,[Text.UTF8Encoding]::new($false))
$taskHost=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
$arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PayloadRoot 'hold-file.ps1')+'" -TargetPath "'+$TargetPath+'"'
$taskChild=Start-Process -FilePath $taskHost -ArgumentList $arguments -WorkingDirectory $TargetPath -WindowStyle Hidden -PassThru
while(-not (Test-Path -LiteralPath (Join-Path $TargetPath 'grandchild.json'))){Start-Sleep -Milliseconds 50}
$mode=[IO.File]::ReadAllText((Join-Path $TargetPath 'mode'))
if($mode -eq 'failure'){exit 17}
if($mode -eq 'success'){exit 0}
while(-not (Test-Path -LiteralPath (Join-Path $TargetPath 'release'))){Start-Sleep -Milliseconds 100}
exit 0
`);
  const archive = path.join(sandbox, 'fixture.zip');
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(path.dirname(payload))},${quote(archive)})`);
  let source;
  try { source = await readFile(path.join(project, 'scripts/companion-installer.cs'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const packaging = await readFile(path.join(project, 'scripts/package-companion.ps1'), 'utf8');
    source = packaging.match(/\$installerSource = @"\r?\n([\s\S]*?)\r?\n"@/)?.[1];
    assert.ok(source, 'Production installer source is required');
  }
  source = source.replaceAll('$assemblyVersion', '1.42.2.0').replaceAll('__ASSEMBLY_VERSION__', '1.42.2.0');
  const sourcePath = path.join(sandbox, 'installer.cs');
  await writeFile(sourcePath, source);
  exe = path.join(sandbox, 'fixture-setup.exe');
  const compiled = spawnSync(host, ['-NoProfile','-ExecutionPolicy','Bypass','-File',
    path.join(project,'scripts/compile-companion-installer.ps1'),'-SourcePath',sourcePath,
    '-OutputPath',exe,'-PayloadPath',archive], {encoding:'utf8',windowsHide:true,timeout:60000});
  assert.ifError(compiled.error); assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
  for (const [name, needle, replacement] of [
    ['refused', 'Marshal.WriteIntPtr(jobs, job);', 'Marshal.WriteIntPtr(jobs, IntPtr.Zero);'],
    ['cleanup-failure', 'if (!Native.TerminateJobObject(job, code))', 'if (true)']]) {
    assert.equal(source.split(needle).length, 2, 'Controlled native-boundary mutation must be exact');
    const variantSource = path.join(sandbox,name+'.cs'), variantExe = path.join(sandbox,name+'.exe');
    await writeFile(variantSource,source.replace(needle,replacement));
    const variant = spawnSync(host,['-NoProfile','-ExecutionPolicy','Bypass','-File',
      path.join(project,'scripts/compile-companion-installer.ps1'),'-SourcePath',variantSource,
      '-OutputPath',variantExe,'-PayloadPath',archive],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.ifError(variant.error);assert.equal(variant.status,0,variant.stderr||variant.stdout);
    if(name==='refused')refusedExe=variantExe;else cleanupFailureExe=variantExe;
  }
});

after(async () => {
  if (!sandbox) return;
  const resolved = await realpath(sandbox), temp = await realpath(os.tmpdir());
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('zhixue-installer-owner-'));
  await rm(resolved, {recursive:true,force:true});
});

async function runFixture(mode, check, executable=exe) {
  const target = path.join(sandbox, mode + '-' + Date.now());
  await mkdir(target);
  await writeFile(path.join(target, 'mode'), mode);
  const config = Buffer.from('synthetic preserved configuration'), records = Buffer.from('synthetic preserved records');
  await writeFile(path.join(target, 'config.local.json'), config);
  await writeFile(path.join(target, 'study-loop.db'), records);
  const child = spawn(executable, ['--target',target,'--no-start','--skip-registration','--non-interactive'],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  let exitCode, parent, grandchild;
  const exited = new Promise((resolve,reject)=>{child.once('exit',code=>{exitCode=code;resolve();});child.once('error',reject);});
  await withFixtureCleanup(async()=>{
    parent = await marker(target,'parent.json'); grandchild = await marker(target,'grandchild.json');
    await check({child, exited, parent, grandchild, target, code:()=>exitCode});
    assert.deepEqual(await readFile(path.join(target,'config.local.json')),config);
    assert.deepEqual(await readFile(path.join(target,'study-loop.db')),records);
  },async()=>{await release(target,[grandchild,parent]);if(child.exitCode===null)child.kill();await exited;});
}

test('killing the installer releases its owned descendants and held file', {skip:process.platform!=='win32',timeout:60000},async()=>{
  await runFixture('wait',async({child,exited,parent,grandchild,target})=>{
    child.kill();await exited;
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(alive(parent),false,'Installer PowerShell must not survive its owner');
    assert.equal(alive(grandchild),false,'Owned descendant must not keep the installation locked');
    await rm(path.join(target,'occupied.tmp'));
  });
});

test('failed installation releases descendants and preserves its exit code', {skip:process.platform!=='win32',timeout:60000},async()=>{
  await runFixture('failure',async({exited,grandchild,code})=>{
    await exited;assert.equal(code(),17);
    assert.equal(alive(grandchild),false,'Failure must release owned descendant resources');
  });
});

test('successful installer leaves the deliberately started companion alive', {skip:process.platform!=='win32',timeout:60000},async()=>{
  await runFixture('success',async({exited,grandchild,code})=>{
    await exited;assert.equal(code(),0);
    assert.equal(alive(grandchild),true,'Normal completion must preserve the started companion');
  });
});

test('terminating one installer leaves another invocation untouched', {skip:process.platform!=='win32',timeout:60000},async()=>{
  await runFixture('success',async(other)=>{
    await other.exited;
    await runFixture('wait',async(owned)=>{
      owned.child.kill();await owned.exited;
      await new Promise(resolve=>setTimeout(resolve,500));
      assert.equal(alive(owned.parent),false);
      assert.equal(alive(owned.grandchild),false);
      assert.equal(alive(other.grandchild),true,'A different invocation is outside this ownership boundary');
    });
  });
});

test('refused native ownership never runs the installer child', {skip:process.platform!=='win32',timeout:60000},async()=>{
  const target=path.join(sandbox,'refused');await mkdir(target);
  const result=spawnSync(refusedExe,['--target',target,'--no-start','--skip-registration','--non-interactive'],
    {encoding:'utf8',windowsHide:true,timeout:60000});
  assert.ifError(result.error);assert.equal(result.status,1);
  assert.equal(await readFile(path.join(target,'parent.json')).then(()=>true,error=>{
    assert.equal(error.code,'ENOENT');return false;
  }),false);
});

test('cleanup failure keeps the installation failure code', {skip:process.platform!=='win32',timeout:60000},async()=>{
  await runFixture('failure',async({exited,code})=>{
    await exited;assert.equal(code(),17);
  },cleanupFailureExe);
});
