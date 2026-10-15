import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const repo=resolve(import.meta.dirname,'..'),out=resolve(process.argv[2]??'scratch/audit-followup-20261013/browser-origin');
await mkdir(out,{recursive:true});
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const allowed=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Isolated origin check</title>');});
const denied=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Isolated denied origin</title>');});
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',done));
await listen(allowed);await listen(denied);
const origin='http://127.0.0.1:'+allowed.address().port,other='http://127.0.0.1:'+denied.address().port;
let child,browser,stopped,info,childExit=null,stderr='',failure=null;const rows=[];
try {
  child=spawn(process.env.PYTHON,['-I','-B','-X','utf8',resolve(repo,'scripts/companion-origin-browser-fixture.py'),origin],{cwd:repo,stdio:['pipe','pipe','pipe'],windowsHide:true});
  stopped=new Promise(done=>child.once('exit',code=>{childExit=code;done(code);}));
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-5000);});
  child.stdin.on('error',()=>{});
  info=await new Promise((done,reject)=>{
    let text='';const timer=setTimeout(()=>reject(Error('Fixture readiness timeout')),15000);
    child.stdout.on('data',bytes=>{text+=bytes;const end=text.indexOf('\n');if(end>=0){try{const value=JSON.parse(text.slice(0,end));clearTimeout(timer);done(value);}catch(error){clearTimeout(timer);reject(error);}}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture exited before readiness'));});
  });
  browser=await chromium.launch({headless:true,executablePath:process.env.EDU_CHROMIUM_PATH});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:950}}),page=await context.newPage();
    await context.route('**/*',route=>[origin,other,info.base].includes(new URL(route.request().url()).origin)?route.continue():route.abort('blockedbyclient'));
    await page.goto(origin);
    const input={...info,request:{...info.request,requestId:'browser-origin-'+width}};
    const allowedResult=await page.evaluate(async value=>{
      const r=await fetch(value.base+'/v1/ai/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':value.session},
        body:JSON.stringify({libraryId:value.library,request:value.request})});
      return{status:r.status,text:await r.text(),type:r.headers.get('content-type')};
    },input);
    assert.equal(allowedResult.status,200);assert.match(allowedResult.type,/text\/event-stream/);
    assert.match(allowedResult.text,/Synthetic browser explanation/);assert.match(allowedResult.text,/"type": "done"/);
    await page.goto(other);
    const blocked=await page.evaluate(async value=>{
      try{await fetch(value.base+'/v1/ai/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':value.session},
        body:JSON.stringify({libraryId:value.library,request:value.request})});return false;}catch{return true;}
    },input);
    assert.equal(blocked,true,'Real browser must block a denied origin before reading the stream');
    rows.push({width,allowedStream:200,deniedOriginBlocked:true});await context.close();
  }
}catch(error){failure=String(error.stack??error);}
finally{
  await browser?.close();
  if(child&&childExit===null){
    child.stdin.end('stop\n');const timer=setTimeout(()=>child.kill(),6000);let limit;
    try{await Promise.race([stopped,new Promise((_,reject)=>{limit=setTimeout(()=>reject(Error('Fixture termination unconfirmed')),10000);})]);}catch(error){failure=[failure,String(error)].filter(Boolean).join('\n');}
    finally{clearTimeout(timer);clearTimeout(limit);}
  }
  await Promise.all([new Promise(done=>allowed.close(done)),new Promise(done=>denied.close(done))]);
  if(childExit!==0)failure=[failure,'Fixture exit '+childExit].filter(Boolean).join('\n');
  const result={complete:!failure,expected:2,passed:rows.length,rows,childExit,failure,fixtureDiagnostics:failure?stderr:null,realModelCalls:0,productionWrites:0,
    limits:'Actual installed-browser CORS and current Handler/application/ledger with temporary synthetic data and provider; no live user service or real model.'};
  await writeFile(resolve(out,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:rows.length,complete:!failure,failure,childExit}));process.exitCode=failure?1:0;
}
