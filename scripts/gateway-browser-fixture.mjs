// Disposable local UI fixture. No real Vault, credentials, cloud writes, or runtime changes.
import http from 'node:http';
import {mkdtemp, mkdir, copyFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function startCompanionFixture() {
const root=await mkdtemp(path.join(tmpdir(),'zhixue-gateway-browser-'));
const companion=path.join(root,'companion');
const vault=path.join(root,'vault');
await mkdir(companion);
await mkdir(path.join(companion,'data'));
await mkdir(vault);
for(const name of await readdir(path.join(repo,'companion'))) if(name.endsWith('.py')) await copyFile(path.join(repo,'companion',name),path.join(companion,name));
for(const name of ['version.json','data/seed.json']) await copyFile(path.join(repo,'companion',name),path.join(companion,name));
await copyFile(path.join(repo,'scripts/gateway-browser-fixture.py'),path.join(companion,'fixture.py'));
await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,study_loop_integration_root:'_System/Integrations/Study Loop',allowed_origins:['http://localhost:3002','http://127.0.0.1:3002'],port:43222}));
const childEnv={...process.env};
delete childEnv.DEEPSEEK_API_KEY;
const child=spawn(process.env.GATEWAY_TEST_PYTHON || (process.env.PYTHON || 'python'),['-X','utf8',path.join(companion,'fixture.py')],{cwd:companion,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
return {root,child};
}
const fixture=process.argv.includes('--proxy-only') ? {root:'existing disposable fixture',child:null} : await startCompanionFixture();
const emptyProgress={answered:0,correct:0,itemStages:{},fsrsData:{}};
const proxy=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost:3002');
    const json=(payload,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(payload));};
    if(url.pathname==='/api/session') return json({authenticated:true,user:{userId:'gateway-browser-fixture',displayName:'隔离验收账号',email:''}});
    if(url.pathname==='/api/sync') {
      await new Promise(resolve=>setTimeout(resolve,650));
      return url.searchParams.has('schemaVersion') ? json({supported:false,cursor:0,events:[],projections:[]},404) : json({hasProgress:false,progress:emptyProgress,cursor:0,syncedAt:null});
    }
    if(url.pathname.startsWith('/api/')) return json({message:'Fixture disables remote writes'},404);
    const upstream=await fetch('http://localhost:3000'+req.url,{headers:{accept:req.headers.accept || '*/*','sec-fetch-dest':req.headers['sec-fetch-dest'] || ''}});
    const contentType=upstream.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(upstream.status,{'content-type':contentType,'cache-control':'no-store'});
    if(/javascript|html/.test(contentType)) res.end((await upstream.text()).replaceAll('http://127.0.0.1:43121','http://127.0.0.1:43222'));
    else res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch(error) {res.writeHead(502);res.end(String(error));}
});
proxy.listen(3002,'127.0.0.1',()=>console.log('Gateway UI fixture: http://localhost:3002/study\nFixture directory: '+fixture.root));
process.on('SIGINT',()=>{fixture.child?.kill();proxy.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{fixture.child?.kill();proxy.close(()=>process.exit(0));});
