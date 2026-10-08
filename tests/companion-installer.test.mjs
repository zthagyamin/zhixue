import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from 'node:net';
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "companion");
const installerScript = path.join(companionRoot, "install-or-upgrade.ps1");
const packagedCompanion = path.join(projectRoot, "public", "downloads", "zhixue-companion-windows.zip");
const requiredServerModules = JSON.parse(await readFile(path.join(companionRoot, 'program-files.json'), 'utf8')).files
  .filter((name) => name.endsWith(".py"))
  .sort();

test('published PowerShell scripts parse in the built-in installer host', {skip:process.platform!=='win32'},()=>{
  const script=`Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${packagedCompanion.replaceAll("'","''")}'); try { foreach($entry in $zip.Entries) { if($entry.FullName.EndsWith('.ps1')) { $stream=$entry.Open();$buffer=[IO.MemoryStream]::new();$stream.CopyTo($buffer);$stream.Dispose();$bytes=$buffer.ToArray(); if($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) {throw ('PowerShell 5.1 requires UTF-8 BOM: '+$entry.FullName)}; $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($bytes,3,$bytes.Length-3),[ref]$tokens,[ref]$errors);if($errors.Count){throw ('Script parse failed: '+$entry.FullName)} } }; 'BUILTIN_PARSE_OK' } finally {$zip.Dispose()}`;
  const host=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(host,['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/BUILTIN_PARSE_OK/);
});

test('real EXE installs, starts bundled Python and upgrades a Unicode path without external Python', {skip:process.platform!=='win32',timeout:120000},async()=>{
  const sandbox=await mkdtemp(path.join(os.tmpdir(),'zhixue-real-exe-')),target=path.join(sandbox,'安装 用户'),exe=path.join(projectRoot,'public/downloads/Zhixue-Companion-Setup.exe');
  const environment={...process.env,LOCALAPPDATA:path.join(sandbox,'local-appdata'),PATH:path.join(process.env.SystemRoot,'System32'),PSModulePath:path.join(sandbox,'invalid inherited modules')};let child,launchError,stopped=Promise.resolve();
  try{
    const run=()=>spawnSync(exe,['--target',target,'--no-start','--skip-registration','--non-interactive'],{encoding:'utf8',windowsHide:true,env:environment,timeout:60000});
    const installed=run();assert.equal(installed.status,0,installed.stderr||installed.stdout);
    const configPath=path.join(target,'config.local.json'),config=JSON.parse(await readFile(configPath,'utf8'));assert.equal(config.workspace_mode,'managed');assert.ok(config.learning_vault_root.startsWith(target));
    const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});
    config.port=port;await writeFile(configPath,JSON.stringify(config));
    const manifest=JSON.parse(await readFile(path.join(target,'runtime-manifest.json'),'utf8')),python=path.join(target,'runtime',manifest.sha256.slice(0,16),'python.exe');
    child=spawn(python,['-B',path.join(target,'server.py')],{cwd:target,env:environment,windowsHide:true,stdio:'ignore'});stopped=new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{launchError=error;resolve();});});
    let health;for(let i=0;i<60;i++){if(launchError||child.exitCode!==null)break;try{const response=await fetch(`http://127.0.0.1:${port}/v1/health`,{signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{/* Server may still be starting. */}await new Promise(resolve=>setTimeout(resolve,150));}
    assert.ok(health?.serverVersion?.startsWith('StudyLoopCompanion/'),launchError?.message??'Installed server did not start');assert.ok(health.capabilities.includes('paper-library-v1'));child.kill();await stopped;child=null;
    const beforeConfig=await readFile(configPath),databasePath=path.join(target,'data/study-loop.db'),beforeDatabase=await readFile(databasePath);
    const upgraded=run();assert.equal(upgraded.status,0,upgraded.stderr||upgraded.stdout);assert.deepEqual(await readFile(configPath),beforeConfig);assert.deepEqual(await readFile(databasePath),beforeDatabase);
  }finally{if(child){if(!launchError&&child.exitCode===null)child.kill();await stopped;}assert.ok(path.resolve(sandbox).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(sandbox,{recursive:true,force:true});}
});

test("a freshly generated Companion archive contains every server dependency", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-package-script-test-"));
  try {
    await cp(companionRoot, path.join(sandbox, "companion"), { recursive: true });
    await mkdir(path.join(sandbox, "scripts"), { recursive: true });
    await cp(path.join(projectRoot, "scripts", "package-companion.ps1"), path.join(sandbox, "scripts", "package-companion.ps1"));
    await cp(path.join(projectRoot, "scripts", "compile-companion-installer.ps1"), path.join(sandbox, "scripts", "compile-companion-installer.ps1"));
    await cp(path.join(projectRoot, "package.json"), path.join(sandbox, "package.json"));
    const published = path.join(sandbox, "public", "downloads");
    await mkdir(published, { recursive: true });
    await writeFile(path.join(published, "zhixue-companion-windows.zip"), "published-zip");
    await writeFile(path.join(published, "Zhixue-Companion-Setup.exe"), "published-exe");
    const output = path.join(sandbox, "temporary output with spaces");

    const packaged = spawnSync("pwsh.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(sandbox, "scripts", "package-companion.ps1"),
      "-OutputDirectory", output,
    ], { encoding: "utf8" });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);

    const extracted = path.join(sandbox, "extracted");
    await mkdir(extracted);
    assert.equal(await readFile(path.join(published, "zhixue-companion-windows.zip"), "utf8"), "published-zip");
    assert.equal(await readFile(path.join(published, "Zhixue-Companion-Setup.exe"), "utf8"), "published-exe");
    const archive = path.join(output, "zhixue-companion-windows.zip");
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    const extractCommand = "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
      + `[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(archive)}, ${quotePowerShell(extracted)})`;
    const extract = spawnSync("pwsh.exe", ["-NoProfile", "-Command", extractCommand], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr || extract.stdout);

    const packageRoot = path.join(extracted, "zhixue-companion");
    for (const moduleName of requiredServerModules) {
      assert.equal(await readFile(path.join(packageRoot, moduleName), "utf8").then(() => true, () => false), true,
        `${moduleName} is required by server.py but missing from a freshly generated archive`);
      assert.deepEqual(await readFile(path.join(packageRoot, moduleName)), await readFile(path.join(companionRoot, moduleName)));
    }
    const verified = spawnSync(path.join(output, "Zhixue-Companion-Setup.exe"), ["--verify-only"], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const target = path.join(sandbox, "installed");
    const installed = runInstaller(packageRoot, target, path.join(sandbox, "backups"));
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    for (const moduleName of requiredServerModules) {
      assert.deepEqual(await readFile(path.join(target, moduleName)), await readFile(path.join(companionRoot, moduleName)));
    }
    const pythonBin = process.env.PYTHON || (process.platform === "win32" && spawnSync("where.exe", ["py.exe"], { encoding: "utf8" }).status === 0 ? "py" : "python");
    const imported = spawnSync(pythonBin, ["-I", "-B", "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import server", target], { encoding: "utf8", cwd: sandbox });
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function runInstaller(payload, target, backupBase) {
  return spawnSync("pwsh.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(payload, "install-or-upgrade.ps1"),
    "-PayloadRoot", payload,
    "-TargetPath", target,
    "-BackupBasePath", backupBase,
    "-NonInteractive",
    "-NoStart",
    "-SkipSetup",
    "-SkipRegistration",
  ], { encoding: "utf8" });
}

test("installer tolerates a Python child process exiting with its parent", async () => {
  const source = await readFile(installerScript, "utf8");
  assert.match(
    source,
    /Stop-Process\s+-Id\s+\$process\.ProcessId\s+-Force\s+-ErrorAction\s+SilentlyContinue/,
    "stopping one Python process can make its paired process disappear; that race must not abort the update",
  );
});

test("published Companion archive matches its own installer manifest", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-package-test-"));
  try {
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    const extractCommand = "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
      + `[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(packagedCompanion)}, ${quotePowerShell(sandbox)})`;
    const result = spawnSync("pwsh.exe", [
      "-NoProfile",
      "-Command",
      extractCommand,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const packageRoot = path.join(sandbox, "zhixue-companion");
    const publishedModules = JSON.parse(await readFile(path.join(packageRoot, 'program-files.json'), 'utf8')).files
      .filter(name => name.endsWith('.py'));
    assert.ok(publishedModules.includes("server.py"));
    for (const moduleName of publishedModules) {
      assert.equal(await readFile(path.join(packageRoot, moduleName), "utf8").then(() => true, () => false), true,
        `${moduleName} is imported by server.py but missing from the published archive`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("fresh install from the published archive installs every server module", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-published-install-test-"));
  try {
    const extracted = path.join(sandbox, "extracted");
    await mkdir(extracted);
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    const extractCommand = "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
      + `[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(packagedCompanion)}, ${quotePowerShell(extracted)})`;
    const extract = spawnSync("pwsh.exe", ["-NoProfile", "-Command", extractCommand], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr || extract.stdout);

    const payload = path.join(extracted, "zhixue-companion");
    const target = path.join(sandbox, "installed");
    const result = runInstaller(payload, target, path.join(sandbox, "backups"));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const publishedModules = JSON.parse(await readFile(path.join(payload, 'program-files.json'), 'utf8')).files
      .filter(name => name.endsWith('.py'));
    for (const moduleName of publishedModules) {
      assert.equal(await readFile(path.join(target, moduleName), "utf8").then(() => true, () => false), true,
        `${moduleName} is present in the archive but was not installed`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("in-place installer preserves user config and database while updating program files", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-installer-test-"));
  try {
    const target = path.join(sandbox, "existing");
    const backups = path.join(sandbox, "backups");
    await cp(companionRoot, target, { recursive: true });
    await writeFile(path.join(target, "server.py"), "# legacy program\n", "utf8");
    // Simulate the previous version, which did not contain the extracted modules.
    const addedModules = ['http_routes.py', 'route_services.py', 'study_event_schema.py',
      'routes_account.py', 'routes_study.py', 'routes_planning.py', 'routes_sources.py', 'routes_ai.py',
      ...requiredServerModules.filter(name => name.includes('/'))];
    for (const moduleName of addedModules) await unlink(path.join(target, moduleName));
    await writeFile(path.join(target, "config.local.json"), '{"current_source":"keep-me"}', "utf8");
    await mkdir(path.join(target, "data"), { recursive: true });
    await writeFile(path.join(target, "data", "study-loop.db"), "legacy-db", "utf8");

    const result = runInstaller(companionRoot, target, backups);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(path.join(target, "config.local.json"), "utf8"), '{"current_source":"keep-me"}');
    assert.equal(await readFile(path.join(target, "data", "study-loop.db"), "utf8"), "legacy-db");
    assert.notEqual(await readFile(path.join(target, "server.py"), "utf8"), "# legacy program\n");
    for (const moduleName of addedModules) {
      assert.equal(await readFile(path.join(target, moduleName), 'utf8'), await readFile(path.join(companionRoot, moduleName), 'utf8'));
    }
    assert.equal(JSON.parse(await readFile(path.join(target, "version.json"), "utf8")).version,
      JSON.parse(await readFile(path.join(companionRoot, "version.json"), "utf8")).version);
    assert.equal((await readdir(backups)).length, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("failed update restores the previous program and personal data", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-installer-rollback-"));
  try {
    const payload = path.join(sandbox, "broken-payload");
    const target = path.join(sandbox, "existing");
    const backups = path.join(sandbox, "backups");
    await cp(companionRoot, payload, { recursive: true });
    await cp(companionRoot, target, { recursive: true });
    await unlink(path.join(payload, "requirements.txt"));
    await writeFile(path.join(target, "server.py"), "# legacy program\n", "utf8");
    await writeFile(path.join(target, "config.local.json"), '{"current_source":"keep-me"}', "utf8");
    await writeFile(path.join(target, "data", "study-loop.db"), "legacy-db", "utf8");

    const result = runInstaller(payload, target, backups);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(target, "server.py"), "utf8"), "# legacy program\n");
    assert.equal(await readFile(path.join(target, "config.local.json"), "utf8"), '{"current_source":"keep-me"}');
    assert.equal(await readFile(path.join(target, "data", "study-loop.db"), "utf8"), "legacy-db");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("nested extracted payload can update its parent installation without recursive copying", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "zhixue-installer-nested-"));
  try {
    const target = path.join(sandbox, "existing");
    const payload = path.join(target, "downloaded-update", "zhixue-companion");
    const backups = path.join(sandbox, "backups");
    await cp(companionRoot, target, { recursive: true });
    await cp(companionRoot, payload, { recursive: true });
    await writeFile(path.join(target, "server.py"), "# legacy program\n", "utf8");
    await writeFile(path.join(target, "config.local.json"), '{"current_source":"keep-me"}', "utf8");
    await writeFile(path.join(target, "data", "study-loop.db"), "legacy-db", "utf8");

    const result = runInstaller(payload, target, backups);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.notEqual(await readFile(path.join(target, "server.py"), "utf8"), "# legacy program\n");
    assert.equal(await readFile(path.join(target, "config.local.json"), "utf8"), '{"current_source":"keep-me"}');
    assert.equal(await readFile(path.join(target, "data", "study-loop.db"), "utf8"), "legacy-db");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
