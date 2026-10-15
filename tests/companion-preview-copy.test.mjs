import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import ts from 'typescript';
import {previewEnvironment} from './fixtures/preview-environment.mjs';
import {copyCompanionPreviewSources,copyCompanionPreviewPayload,startCompanionPreview} from './helpers/companion-preview.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
test('selected payload copies managed code and public metadata without private config or records',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'zhixue-selected-preview-')),source=path.join(root,'selected'),target=path.join(root,'copied');
 await mkdir(path.join(source,'data'),{recursive:true});
 await writeFile(path.join(source,'program-files.json'),JSON.stringify({schemaVersion:1,
  files:['server.py','version.json','data/seed.json','config.local.json','data/study-loop.db']}));
 for(const [name,value]of [['server.py','public = True'],['version.json','{"version":"test"}'],['data/seed.json','{}'],
  ['config.local.json','synthetic-private-configuration'],['config.json','synthetic-private-template'],['data/study-loop.db','synthetic-private-records']])
  await writeFile(path.join(source,name),value);
 await copyCompanionPreviewPayload(source,target);
 assert.equal(await readFile(path.join(target,'server.py'),'utf8'),'public = True');
 assert.deepEqual((await readdir(target)).sort(),['data','server.py','version.json']);
 assert.deepEqual(await readdir(path.join(target,'data')),['seed.json']);
});
test('host check replaces old successful evidence when selected payload setup fails',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'zhixue-host-report-test-')),out=path.join(root,'evidence');
 await mkdir(out);await writeFile(path.join(out,'results.json'),JSON.stringify({complete:true,passed:2}));
 const result=spawnSync(process.execPath,[path.join(repo,'scripts/nonword-host-recovery-check.mjs'),
  '--payload',path.join(root,'missing-payload'),'--out',out],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:20000});
 assert.notEqual(result.status,0);
 const report=JSON.parse(await readFile(path.join(out,'results.json'),'utf8'));
 assert.equal(report.complete,false);assert.equal(report.passed,0);
 assert.match(report.failure,/ENOENT|not found/i);
});
/** Run the actual wrapper's copying statements, without starting its proxy/UI. */
async function copyFromWrapper(relative,companion){
  const filename=path.join(repo,relative),text=await readFile(filename,'utf8');
  const source=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true),statements=[];
  let helper;
  for(const node of source.statements){
    if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)){
      if(node.importClause.namedBindings.elements.some(x=>x.name.text==='copyCompanionPreviewSources'))
        helper=(await import(pathToFileURL(path.resolve(path.dirname(filename),node.moduleSpecifier.text)).href)).copyCompanionPreviewSources;
    }
  }
  function walk(node){
    if(ts.isForOfStatement(node)&&node.getText(source).includes("path.join(repo,'companion')"))statements.push(node.getText(source));
    else if(ts.isExpressionStatement(node)&&node.getText(source).includes('await copyCompanionPreviewSources('))statements.push(node.getText(source));
    else ts.forEachChild(node,walk);
  }
  walk(source);assert.ok(statements.length,'actual source copying statements are present');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const copy=new AsyncFunction('repo','companion','path','copyFile','readdir','copyCompanionPreviewSources',statements.join('\n'));
  await copy(repo,companion,path,copyFile,readdir,helper);
}

for(const [script,readyText,foreignDependency] of [
  ['gateway-browser-fixture.py','Disposable Companion fixture ready.','gateway_cli'],
  ['note-sources-browser-fixture.py','Isolated source Companion ready.','external_sources'],
  ['task-plan-browser-fixture.py','Disposable task-plan Companion ready.','index_gateway'],
]){
  for(const dependency of (script==='gateway-browser-fixture.py'?['gateway_cli','index_gateway']:[foreignDependency])){
  test(`copied ${script} rejects cached foreign ${dependency} before import-time config migration`,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'zhixue-preview-import-migration-'));
    const companion=path.join(root,'companion'),vault=path.join(root,'vault'),foreign=path.join(root,'foreign');
    await mkdir(vault);await mkdir(foreign);
    await copyCompanionPreviewSources(repo,companion);
    await copyFile(path.join(repo,'scripts',script),path.join(companion,'fixture.py'));
    const original=JSON.stringify({learning_vault_root:vault,allowed_origins:[],port:43299,deepseek_model:'deepseek-chat'});
    await writeFile(path.join(companion,'config.local.json'),original);
    const result=spawnSync(process.env.PYTHON||'python',
      ['-I','-B','-X','utf8','-c',"import sys,importlib,runpy;sys.path.insert(0,sys.argv[1]);module=importlib.import_module(sys.argv[2]);module.__file__=sys.argv[3];runpy.run_path(sys.argv[4],run_name='__main__')",
        companion,dependency,path.join(foreign,dependency+'.py'),path.join(companion,'fixture.py')],
      {cwd:companion,env:previewEnvironment(process.env,false),encoding:'utf8',windowsHide:true,timeout:15000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Preview must use only its copied Companion/);
    assert.equal(await readFile(path.join(companion,'config.local.json'),'utf8'),original);
    assert.deepEqual(await readdir(vault),[]);
    assert.deepEqual(await readdir(foreign),[]);
  });
  }
  test(`copied ${script} rejects a cached foreign server before setup`,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'zhixue-preview-cached-import-'));
    const companion=path.join(root,'companion'),vault=path.join(root,'vault'),foreign=path.join(root,'foreign');
    await mkdir(vault);await mkdir(foreign);
    await copyCompanionPreviewSources(repo,companion);
    await copyFile(path.join(repo,'scripts',script),path.join(companion,'fixture.py'));
    await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,allowed_origins:[],port:43299}));
    const result=spawnSync(process.env.PYTHON||'python',
      ['-I','-B','-X','utf8','-c',"import sys,types,runpy;module=types.ModuleType('server');module.__file__=sys.argv[1];sys.modules['server']=module;runpy.run_path(sys.argv[2],run_name='__main__')",
        path.join(foreign,'server.py'),path.join(companion,'fixture.py')],
      {cwd:companion,env:previewEnvironment(process.env,false),encoding:'utf8',windowsHide:true,timeout:15000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Preview must use only its copied Companion/);
    assert.deepEqual(await readdir(vault),[]);
    assert.deepEqual(await readdir(foreign),[]);
  });
  test(`copied ${script} ignores an interpreter's foreign Companion import path`,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'zhixue-preview-import-test-'));
    const companion=path.join(root,'companion'),vault=path.join(root,'vault'),foreign=path.join(root,'foreign');
    await mkdir(vault);await mkdir(foreign);
    await copyCompanionPreviewSources(repo,companion);
    await copyFile(path.join(repo,'scripts',script),path.join(companion,'fixture.py'));
    for(const name of ['gateway_cli.py','server.py'])await writeFile(path.join(foreign,name),
      "raise AssertionError('foreign-companion-must-not-be-used')\n");
    const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,allowed_origins:[],port}));
    let child;
    try{
      child=await startCompanionPreview(process.env.PYTHON||'python',
        ['-I','-B','-X','utf8','-c',"import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='__main__')",foreign,path.join(companion,'fixture.py')],
        {cwd:companion,env:previewEnvironment(process.env,false),readyText,stdout:null,stderr:null});
      const response=await fetch(`http://127.0.0.1:${port}/v1/health`,{signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);
      assert.match((await response.json()).serverVersion,/^StudyLoopCompanion\//);
    }finally{
      if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    }
  });
  test(`copied ${script} binds its real isolated HTTP server before reporting ready`,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'zhixue-preview-start-test-'));
    const companion=path.join(root,'companion'),vault=path.join(root,'vault');await mkdir(vault);
    await copyCompanionPreviewSources(repo,companion);
    await copyFile(path.join(repo,'scripts',script),path.join(companion,'fixture.py'));
    const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,allowed_origins:[],port}));
    let child;
    try{
      child=await startCompanionPreview(process.env.PYTHON||'python',
        ['-B','-X','utf8',path.join(companion,'fixture.py')],{cwd:companion,env:previewEnvironment(process.env,false),readyText,stdout:null,stderr:null});
      const response=await fetch(`http://127.0.0.1:${port}/v1/health`,{signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);assert.match((await response.json()).serverVersion,/^StudyLoopCompanion\//);
    }finally{
      if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    }
  });
}

test('failed child cannot satisfy readiness and retains its failure evidence',async()=>{
  await assert.rejects(startCompanionPreview(process.execPath,['-e',"process.stderr.write('synthetic-import-failure');process.exit(7)"],
    {cwd:repo,env:previewEnvironment(process.env,false),readyText:'READY',stdout:null,stderr:null}),/before ready \(7\): synthetic-import-failure/);
});

test('missing executable is a startup failure rather than a usable proxy',async()=>{
  await assert.rejects(startCompanionPreview(path.join(repo,'synthetic-missing-python.exe'),[],
    {cwd:repo,env:previewEnvironment(process.env,false),readyText:'READY',stdout:null,stderr:null}),/ENOENT/);
});

test('child loss closes its owned proxy; intentional shutdown can detach the watcher',async()=>{
  const helper=pathToFileURL(path.join(repo,'tests/helpers/companion-preview.mjs')).href;
  for(const intentional of [false,true]){
    const script=`import http from 'node:http';import{once}from'node:events';
      import{startCompanionPreview,watchCompanionPreview}from${JSON.stringify(helper)};
      const child=await startCompanionPreview(process.execPath,['-e',${JSON.stringify(intentional?"console.log('READY');setInterval(()=>{},1000)":"console.log('READY');setTimeout(()=>process.exit(9),500)")}],
        {cwd:process.cwd(),env:process.env,readyText:'READY',stdout:null,stderr:null});
      const proxy=http.createServer();proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
      const detach=watchCompanionPreview(child,proxy);console.log('owned-proxy-listening');
      ${intentional?"detach();const exited=once(child,'exit');child.kill();await exited;if(!proxy.listening)throw Error('detached proxy unexpectedly closed');await new Promise(resolve=>proxy.close(resolve));console.log('intentional-shutdown');":''}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repo,
      env:previewEnvironment(process.env,false),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,intentional?0:1,result.stderr||String(result.error));
    assert.match(result.stdout,/owned-proxy-listening/);
    if(intentional)assert.match(result.stdout,/intentional-shutdown/);
    else assert.match(result.stderr,/closing its UI proxy/);
  }
});

test('a child that never becomes ready is stopped at the startup deadline',async()=>{
  await assert.rejects(startCompanionPreview(process.execPath,['-e','setInterval(()=>{},1000)'],
    {cwd:repo,env:previewEnvironment(process.env,false),readyText:'READY',stdout:null,stderr:null,timeout:100}),/startup timed out/);
});

for(const wrapper of ['scripts/gateway-browser-fixture.mjs','scripts/note-sources-browser-fixture.mjs','scripts/task-plan-browser-fixture.mjs']){
  test(`${wrapper} copies a self-contained importable Companion without real configuration`,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'zhixue-preview-copy-test-'));
    const companion=path.join(root,'companion'),vault=path.join(root,'vault');
    await mkdir(path.join(companion,'data'),{recursive:true});await mkdir(vault);
    await copyFromWrapper(wrapper,companion);
    await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,allowed_origins:[],port:43299}));
    const child=spawnSync(process.env.PYTHON||'python',
      ['-I','-B','-X','utf8','-c',"import sys; sys.path.insert(0,'.'); import server; print('copied-server-imported')"],
      {cwd:companion,env:previewEnvironment(process.env,false),encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(child.status,0,child.stderr||String(child.error));
    assert.match(child.stdout,/copied-server-imported/);
    const manifest=JSON.parse(await readFile(path.join(repo,'companion/program-files.json'),'utf8'));
    for(const relative of manifest.files.filter(x=>x.endsWith('.py'))){
      assert.deepEqual(await readFile(path.join(companion,relative)),await readFile(path.join(repo,'companion',relative)),relative);
    }
    assert.equal((await readdir(companion)).includes('config.local.json'),false);
    assert.equal((await readdir(companion)).includes('runtime-windows-x64.zip'),false);
  });
}
