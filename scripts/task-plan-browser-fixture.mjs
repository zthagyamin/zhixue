// Test-only localhost proxy and temporary Companion. No installed runtime or real vault access.
import http from 'node:http';
import {mkdtemp,mkdir,copyFile,readdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {previewEnvironment,previewHtml} from '../tests/fixtures/preview-environment.mjs';
import {nativePreviewRead} from '../tests/fixtures/native-preview-read.mjs';
import {createPythonPreviewAssets,rewriteRuntimeUrls} from '../tests/fixtures/python-preview-runtime.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reuseIndex=process.argv.indexOf('--reuse-root'),reuse=reuseIndex>=0?path.resolve(process.argv[reuseIndex+1]):null;
const proxyOnly=process.argv.includes('--proxy-only');
const silentAudio=process.argv.includes('--silent-audio');
const pythonAssets=process.argv.includes('--python-runtime')?createPythonPreviewAssets():null;
const portIndex=process.argv.indexOf('--port'),port=portIndex>=0?Number(process.argv[portIndex+1]):3004;
const uiPortIndex=process.argv.indexOf('--ui-port'),uiPort=uiPortIndex>=0?Number(process.argv[uiPortIndex+1]):3010;
if(!Number.isInteger(uiPort)||uiPort<1||uiPort>65535)throw new Error('Invalid local UI port');
const companionPort=port+40220;
const modeIndex=process.argv.indexOf('--study-mode'),mode=modeIndex>=0?process.argv[modeIndex+1]:'local';
const scenarioIndex=process.argv.indexOf('--account-scenario'),scenario=scenarioIndex>=0?process.argv[scenarioIndex+1]:'approved-15';
if(!['local','account'].includes(mode))throw new Error('Unknown study mode');
const origin=`http://127.0.0.1:${port}`;
if(!Number.isInteger(port)||port<3004||port>3099) throw new Error('Fixture ports must be in 3004..3099');
if(proxyOnly && !reuse) throw new Error('Proxy-only mode requires an existing disposable fixture root');
if(reuse && (path.dirname(reuse)!==path.resolve(tmpdir()) || !path.basename(reuse).startsWith('zhixue-task-plan-browser-'))) throw new Error('Reuse only this harness temporary directories');
const root=reuse??await mkdtemp(path.join(tmpdir(),'zhixue-task-plan-browser-')),companion=path.join(root,'companion'),vault=path.join(root,'vault');
if(!proxyOnly&&mode==='local') {
  await mkdir(path.join(companion,'data'),{recursive:true});await mkdir(vault,{recursive:true});
  for(const name of await readdir(path.join(repo,'companion'))) if(name.endsWith('.py')) await copyFile(path.join(repo,'companion',name),path.join(companion,name));
  for(const name of ['version.json','data/seed.json']) await copyFile(path.join(repo,'companion',name),path.join(companion,name));
  await copyFile(path.join(repo,'scripts/task-plan-browser-fixture.py'),path.join(companion,'fixture.py'));
  await writeFile(path.join(companion,'config.json'),JSON.stringify({learning_vault_root:vault,study_loop_integration_root:'_System/Integrations/Study Loop',allowed_origins:[`http://localhost:${port}`,`http://127.0.0.1:${port}`],port:companionPort}));
}
const env=previewEnvironment(process.env,Boolean(reuse));
const child=proxyOnly||mode==='account'?null:spawn(process.env.GATEWAY_TEST_PYTHON||(process.env.PYTHON || 'python'),['-X','utf8','-B',path.join(companion,'fixture.py')],{cwd:companion,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
child?.stdout.on('data',chunk=>process.stdout.write(String(chunk).split('\n').filter(line=>!/(Pairing code|一次性配对码)/i.test(line)).join('\n')));
child?.stderr.pipe(process.stderr);
const emptyProgress={answered:0,correct:0,itemStages:{},fsrsData:{}},events=new Map();
const account=mode==='account'?await createAccountPreview({origin,scenario,userId:`preview-${path.basename(root)}`,longReading:process.argv.includes('--long-material'),syntheticAi:process.argv.includes('--ai-fixture'),manyReviews:process.argv.includes('--many-reviews')}):null;
const readNativeHistory=nativePreviewRead(events,account?.userId??'task-plan-browser-fixture');
const contentSecurityPolicy=`default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:${companionPort} ws://127.0.0.1:${uiPort} ws://localhost:${uiPort}; object-src 'none'; base-uri 'self'; form-action 'self'`;
const proxy=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(url.pathname.startsWith('/__fixture/python-runtime/')){
      if(!pythonAssets)return json({message:'Public runtime downloads require explicit fixture opt-in'},403);
      const asset=await pythonAssets.load(url.pathname,req.method);res.writeHead(200,{'content-type':asset.type,'cache-control':'no-store'});return res.end(Buffer.from(asset.bytes));
    }
    if(url.pathname==='/__fixture/preview') {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':contentSecurityPolicy});
      return res.end(await readFile(path.join(repo,'scripts/fixtures/study-preview.html')));
    }
    if(url.pathname==='/__fixture/viewport') {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      return res.end('<!doctype html><html lang="zh-CN"><title>隔离窄屏验收</title><body style="margin:0;background:#ddd"><p>隔离测试 · 390px 真实 iframe 视口</p><iframe title="390px 学习页面" src="/study" style="display:block;width:390px;height:640px;border:0"></iframe></body></html>');
    }
    if(url.pathname==='/__fixture/status')return json({mode,...(account?account.inspect():{records:events.size}),...(pythonAssets?{publicPythonRuntime:pythonAssets.status()}:{})});
    if(url.pathname==='/api/session') return json({authenticated:true,user:{userId:account?.userId??'task-plan-browser-fixture',displayName:'隔离演示',email:''}});
    if(url.pathname==='/api/account-study'&&account){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await account.handle(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
    }
    if(url.pathname==='/api/sync/study-events-v3'&&req.method==='GET'){
      const response=await readNativeHistory(new Request(url));res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
    }
    if(url.pathname==='/api/sync') {
      if(req.method==='POST') {
        let raw='';for await(const chunk of req) raw+=chunk;
        const body=JSON.parse(raw||'{}');
        for(const event of body.events??[]) if(event.schemaVersion===3) events.set(event.eventId,event);
        return json({accepted:[...events.keys()],duplicates:[],conflicts:[],cursor:events.size,projections:[]});
      }
      if(url.searchParams.has('schemaVersion')) {
        const after=Number(url.searchParams.get('after')||0),all=[...events.values()],page=all.slice(after,after+100);
        return json({supported:true,cursor:after+page.length,events:page.map((event,index)=>({sequence:after+index+1,event})),projections:[]});
      }
      return json({hasProgress:false,progress:emptyProgress,cursor:0,syncedAt:null});
    }
    if(url.pathname.startsWith('/api/')) return json({message:'Isolated fixture disables external writes'},404);
    if(req.method!=='GET'&&req.method!=='HEAD')return json({message:'Preview blocks non-fixture writes'},403);
    const upstream=await fetch(`http://127.0.0.1:${uiPort}`+url.pathname+url.search,{redirect:'manual',headers:{accept:req.headers.accept||'*/*','sec-fetch-dest':req.headers['sec-fetch-dest']||''}});
    if(upstream.status>=300&&upstream.status<400)return json({message:'Preview does not follow redirects'},403);
    const type=upstream.headers.get('content-type')||'application/octet-stream';
    res.writeHead(upstream.status,{'content-type':type,'cache-control':'no-store',...(/html/.test(type)?{'content-security-policy':contentSecurityPolicy}:{})});
    if(/javascript|html/.test(type)){let body=(await upstream.text()).replaceAll('http://127.0.0.1:43121',`http://127.0.0.1:${companionPort}`);if(pythonAssets&&/javascript/.test(type))body=rewriteRuntimeUrls(body,origin);if(/html/.test(type))body=previewHtml(body,silentAudio);res.end(body);}
    else res.end(Buffer.from(await upstream.arrayBuffer()));
  }catch(error){res.writeHead(502);res.end(String(error));}
});
proxy.listen(port,'127.0.0.1',()=>console.log(`Isolated ${mode} study preview: ${origin}/study\nScenario: ${account?scenario:'temporary Companion'}\nFixture directory: ${root}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{child?.kill();proxy.close(()=>{account?.close();process.exit(0);});});
