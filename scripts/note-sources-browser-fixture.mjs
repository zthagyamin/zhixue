// Local-only UI proxy and fresh managed Companion, with all remote writes blocked.
import http from 'node:http';
import {mkdtemp,mkdir,copyFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {previewEnvironment} from '../tests/fixtures/preview-environment.mjs';
const repo=process.cwd(),port=3045,companionPort=43265,uiPort=3001;
const root=await mkdtemp(path.join(tmpdir(),'zhixue-note-sources-')),companion=path.join(root,'companion'),notes=path.join(root,'原始笔记');
await mkdir(path.join(companion,'data'),{recursive:true});await mkdir(notes);
await writeFile(path.join(notes,'课堂笔记.md'),'# 隔离验收笔记\n\n## 递归\n递归函数通过调用自身，把原问题拆成更小的同类问题，并用终止条件结束调用。\n','utf8');
for(const name of await readdir(path.join(repo,'companion')))if(name.endsWith('.py'))await copyFile(path.join(repo,'companion',name),path.join(companion,name));
for(const name of ['version.json','data/seed.json'])await copyFile(path.join(repo,'companion',name),path.join(companion,name));
await copyFile(path.join(repo,'scripts/note-sources-browser-fixture.py'),path.join(companion,'fixture.py'));
await writeFile(path.join(companion,'config.json'),JSON.stringify({allowed_origins:[`http://127.0.0.1:${port}`],port:companionPort}));
const python=process.env.GATEWAY_TEST_PYTHON;if(!python)throw new Error('Set GATEWAY_TEST_PYTHON to the test interpreter');
const env=previewEnvironment(process.env,false);
const setup=spawnSync(python,['-B',path.join(companion,'companion_setup.py'),'--root',companion],{env,encoding:'utf8',windowsHide:true});if(setup.status!==0)throw new Error(setup.stderr);
const child=spawn(python,['-u','-B',path.join(companion,'fixture.py')],{cwd:companion,env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const proxy=http.createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    if(url.pathname==='/api/session')return json({authenticated:true,user:{userId:'note-source-ui-fixture',displayName:'隔离验收账号',email:''}});
    if(url.pathname==='/api/sync')return json({hasProgress:false,progress:{answered:0,correct:0,itemStages:{},fsrsData:{}},cursor:0,syncedAt:null});
    if(url.pathname.startsWith('/api/'))return json({message:'Fixture blocks external services'},404);
    if(req.method!=='GET')return json({message:'Fixture blocks external writes'},403);
    const upstream=await fetch(`http://127.0.0.1:${uiPort}`+req.url,{redirect:'manual'});
    const type=upstream.headers.get('content-type')||'application/octet-stream';res.writeHead(upstream.status,{'content-type':type,'cache-control':'no-store'});res.end(Buffer.from(await upstream.arrayBuffer()));
  }catch(error){json({message:String(error)},502);}
});
proxy.listen(port,'127.0.0.1',()=>console.log(`Source UI: http://127.0.0.1:${port}/study?pair=1&companionPort=${companionPort}\nNotes: ${notes}\nPair code: NOTES1\nFixture: ${root}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill();proxy.close(()=>process.exit(0));});
