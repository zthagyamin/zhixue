// Disposable local UI fixture. No real Vault, credentials, cloud writes, or runtime changes.
import http from 'node:http';
import {mkdtemp, mkdir, copyFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyCompanionPreviewSources,startCompanionPreview,watchCompanionPreview} from '../tests/helpers/companion-preview.mjs';
import {previewEnvironment} from '../tests/fixtures/preview-environment.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function startCompanionFixture() {
const root=await mkdtemp(path.join(tmpdir(),'zhixue-gateway-browser-'));
const companion=path.join(root,'companion');
const vault=path.join(root,'vault');
await mkdir(companion);
await mkdir(path.join(companion,'data'));
await mkdir(vault);
await copyCompanionPreviewSources(repo,companion);
await copyFile(path.join(repo,'scripts/gateway-browser-fixture.py'),path.join(companion,'fixture.py'));
await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,study_loop_integration_root:'_System/Integrations/Study Loop',allowed_origins:['http://localhost:3002','http://127.0.0.1:3002'],port:43222}));
const childEnv=previewEnvironment(process.env,false);
const child=await startCompanionPreview(process.env.GATEWAY_TEST_PYTHON || (process.env.PYTHON || 'python'),['-X','utf8','-B',path.join(companion,'fixture.py')],{cwd:companion,env:childEnv,readyText:'Disposable Companion fixture ready.'});
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
const detachChild=watchCompanionPreview(fixture.child,proxy);
proxy.listen(3002,'127.0.0.1',()=>console.log('Gateway UI fixture: http://localhost:3002/study\nFixture directory: '+fixture.root));
process.on('SIGINT',()=>{detachChild();fixture.child?.kill();proxy.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{detachChild();fixture.child?.kill();proxy.close(()=>process.exit(0));});
