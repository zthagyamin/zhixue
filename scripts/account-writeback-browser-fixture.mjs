// Dedicated end-to-end fixture: browser -> real account handlers -> real
// Companion worker/writer -> temporary Vault -> real receipts -> browser.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {previewEnvironment,previewHtml} from '../tests/fixtures/preview-environment.mjs';

const index=process.argv.indexOf('--port'),port=index<0?3017:Number(process.argv[index+1]);
if(!Number.isInteger(port)||port<3004||port>3099)throw new Error('Fixture port must be3004..3099');
const origin=`http://127.0.0.1:${port}`,owner='a'.repeat(64),account=await createAccountPreview({origin,scenario:'account-writeback',userId:owner});
const client=createAccountStudyClient({expectedUserId:owner,cache:null,companionUrl:`http://127.0.0.1:${port+40220}`,fetcher:(url,init)=>account.handle(new Request(new URL(url,origin),init))});
let child,timer,busy=false,closing=false,latest={ready:false};
const policy="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:3010 ws://localhost:3010; object-src 'none'; base-uri 'self'; form-action 'self'";
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin),json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    if(url.pathname==='/__fixture/status')return json({...account.inspect(),worker:latest});
    if(url.pathname==='/__fixture/preview'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':policy});return res.end(await readFile(new URL('./fixtures/study-preview.html',import.meta.url)));}
    if(url.pathname==='/api/session')return json({authenticated:true,user:{userId:owner,displayName:'写回闭环隔离账号',email:''}});
    if(url.pathname==='/api/account-study'){
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2300000)return json({error:'fixture-request-too-large'},413);chunks.push(chunk);}
      const response=await account.handle(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
    }
    if(url.pathname==='/api/sync'&&req.method==='GET')return json({hasProgress:false,progress:{itemStages:{},fsrsData:{},answered:0,correct:0},cursor:0,syncedAt:null});
    if(url.pathname.startsWith('/api/')||!['GET','HEAD'].includes(req.method))return json({error:'fixture-route-blocked'},404);
    const response=await fetch(`http://127.0.0.1:3010${url.pathname}${url.search}`,{redirect:'manual',headers:{accept:req.headers.accept||'*/*','sec-fetch-dest':req.headers['sec-fetch-dest']||''}});
    if(response.status>=300&&response.status<400)return json({error:'fixture-redirect-blocked'},403);
    const type=response.headers.get('content-type')||'application/octet-stream';res.writeHead(response.status,{'content-type':type,'cache-control':'no-store',...(/html/.test(type)?{'content-security-policy':policy}:{})});
    if(/javascript|html/.test(type)){let body=(await response.text()).replaceAll('http://127.0.0.1:43121',`http://127.0.0.1:${port+40220}`);if(/html/.test(type))body=previewHtml(body,true);res.end(body);}else res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain'});res.end(error instanceof Error?error.message:'fixture-failed');}
});

function send(action){if(closing||!child?.stdin.writable)return;busy=true;child.stdin.write(JSON.stringify({action})+'\n');}
server.listen(port,'127.0.0.1',()=>{
  child=spawn(process.env.GATEWAY_TEST_PYTHON||(process.env.PYTHON || 'python'),['-X','utf8','-B',fileURLToPath(new URL('../tests/fixtures/account_writeback_preview.py',import.meta.url)),'--origin',origin],{env:previewEnvironment(process.env,false),stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  createInterface({input:child.stdout}).on('line',async line=>{
    try{
      const value=JSON.parse(line);
      if(value.kind==='prepared'){
        if(value.owner!==owner)throw new Error('fixture-owner-mismatch');
        await account.registerDevice(value.registration);
        console.log(`Temporary writeback Vault: ${value.vaultRoot}\nTemporary writeback data: ${value.dataRoot}`);send('activate');
      }else if(value.kind==='ready'){
        if(value.result.status!=='synced')throw new Error(`fixture-publication-${value.result.status}`);
        await client.load();latest={ready:true,...value};busy=false;
        console.log(`Same-source account writeback preview ready: ${origin}/study`);
        timer=setInterval(()=>{if(!busy)send('tick');},2000);
      }else if(value.kind==='tick'){latest={ready:true,...value};busy=false;}
      else if(value.kind==='error'){latest={ready:false,error:value.error};busy=false;console.error(`Fixture worker error: ${value.error}`);}
    }catch(error){latest={ready:false,error:error.message};busy=false;console.error(`Fixture setup error: ${error.message}`);}
  });
  child.on('exit',code=>{latest={...latest,ready:false,processExit:code};if(!closing)console.error('Temporary writeback worker exited.');});
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(closing)return;closing=true;clearInterval(timer);child?.stdin.end(JSON.stringify({action:'close'})+'\n');
  const fallback=setTimeout(()=>{child?.kill();account.close();process.exit(0);},3000);
  server.close(()=>{clearTimeout(fallback);child?.kill();account.close();process.exit(0);});
});
