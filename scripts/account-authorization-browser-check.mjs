import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const repo=resolve(import.meta.dirname,'..'),project=repo.replaceAll('\\','/'),out=resolve(process.argv[2]??'scratch/audit-followup-20261013/connection-browser');
const root=await mkdtemp(resolve(tmpdir(),'zhixue-connection-browser-'));
await mkdir(out,{recursive:true});
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
await writeFile(resolve(root,'entry.jsx'),`
import React from 'react';import{createRoot}from'react-dom/client';
import{AccountStudyConnection}from'/@fs/${project}/app/account-study-controls.tsx';
import{createAccountStudyClient}from'/@fs/${project}/app/account-study-client.ts';
import '/@fs/${project}/app/globals.css';import '/@fs/${project}/app/c-study.css';import '/@fs/${project}/app/study-core-ui.css';import '/@fs/${project}/app/settings-progress-hierarchy.css';
const params=new URLSearchParams(location.search);if(params.get('theme')==='dark')document.documentElement.classList.add('dark');
const calls=[];let scenario='expired',grant='grant-old',mode='idle',reads=0;
const now=()=>Date.now(),day=24*60*60*1000;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
window.__connection={calls,setScenario:value=>{scenario=value;},inspect:()=>({scenario,grant,mode,reads,calls})};
const fetcher=async(raw,options={})=>{
 const url=new URL(String(raw),location.origin),body=options.body?JSON.parse(options.body):null;calls.push({path:url.pathname,action:url.searchParams.get('action')??body?.action??null,method:options.method??'GET',body});
 if(url.pathname==='/v1/account-sync/status'){
  if(scenario==='pair')return json({error:'companion-pairing-required'},401);
  if(scenario==='offline')throw new TypeError('Synthetic offline');
  const link={grantId:grant,libraryId:'library-a',label:'合成桌面',state:scenario==='paused'?'paused':'active',workerStatus:scenario==='retry'?'retry':scenario==='paused'?'stopped':'synced'};
  if(scenario==='auth')Object.assign(link,{state:'paused',workerStatus:'paused',error:'account-authorization-required'});
  if(scenario==='retry')link.error='account-cloud-unavailable';
  if(!['legacy','auth','paused','retry'].includes(scenario))link.authorization={expiresAt:new Date(now()+(scenario==='expired'?-day:scenario==='expiring'?day:30*day)).toISOString(),checkedAt:new Date(now()-2*day).toISOString()};
  return json({capability:'account-study-sync-v1',links:[link]});
 }
 if(url.pathname==='/v1/account-sync/prepare'){grant=body.rotateGrant?'grant-renewed':'grant-prepared';return json({grantId:grant,libraryId:'library-a',label:body.label,tokenHash:'a'.repeat(64)});}
 if(url.pathname==='/v1/account-sync/start'){if(body.grantId!==grant)throw Error('Wrong grant');scenario='active';mode='started';return json({status:'running',grantId:grant});}
 if(url.pathname==='/v1/account-sync/stop'){scenario='paused';mode='stopped';return json({status:'stopped',cloudRevoked:false});}
 if(url.pathname==='/api/account-study'&&url.searchParams.get('action')==='bootstrap')return json({profile:{libraryId:'library-a',revision:3}});
 if(url.pathname==='/api/account-study'&&body?.action==='register-grant')return json({grantId:body.grantId,state:'pending',expiresAt:new Date(now()+30*day).toISOString()});
 throw Error('Blocked synthetic request '+url.pathname);
};
const client=createAccountStudyClient({companionUrl:'http://synthetic-companion.invalid',sessionToken:'synthetic-paired',expectedUserId:'user-a',libraryId:'library-a',cache:null,fetcher});
const loaded={bundle:{items:[{id:'synthetic-item'}]}};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:1100,margin:'24px auto',padding:16}}><AccountStudyConnection client={client} loaded={loaded} onRefresh={async()=>{reads++;return loaded;}} onUseLocal={()=>{mode='local';}}/></main>);
`);
let server,browser,page,failure=null;const rows=[];
try{
 server=await createServer({configFile:false,root,publicDir:false,css:{postcss:repo},cacheDir:resolve(root,'.vite'),plugins:[react()],
  resolve:{alias:{react:resolve(repo,'node_modules/react'),'react-dom':resolve(repo,'node_modules/react-dom')}},
  server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,repo]}},logLevel:'error'});
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.EDU_CHROMIUM_PATH});
 for(const width of [1440,390])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:1050},timezoneId:'Asia/Taipei'});page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await page.goto(origin+'/?theme='+theme);await page.getByRole('button',{name:'重新授权此机',exact:true}).waitFor({timeout:30000});
  assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),theme==='dark');
  assert.match(await page.locator('body').innerText(),/授权期限/);assert.doesNotMatch(await page.locator('body').innerText(),/本轮后台同步已完成/);
  await page.screenshot({path:resolve(out,'expired-'+width+'-'+theme+'.png'),fullPage:true});
  await page.getByRole('button',{name:'重新授权此机',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByText('本轮后台同步已完成。',{exact:true}).waitFor();
  let state=await page.evaluate(()=>window.__connection.inspect());
  assert.equal(state.calls.filter(x=>x.path.endsWith('/prepare')).length,1);
  assert.equal(state.calls.find(x=>x.path.endsWith('/prepare')).body.rotateGrant,true);
  assert.equal(state.calls.find(x=>x.action==='register-grant').body.libraryId,'library-a');
  assert.equal(state.calls.filter(x=>x.path.endsWith('/start')).length,1);
  await page.getByRole('button',{name:'停止本机后台同步',exact:true}).click();
  await page.getByRole('button',{name:'继续后台同步',exact:true}).waitFor();
  state=await page.evaluate(()=>window.__connection.inspect());assert.equal(state.mode,'stopped');
  const beforeResume=state.calls.filter(x=>x.path.endsWith('/prepare')).length;
  await page.getByRole('button',{name:'继续后台同步',exact:true}).click();await page.getByText('本轮后台同步已完成。',{exact:true}).waitFor();
  state=await page.evaluate(()=>window.__connection.inspect());assert.equal(state.calls.filter(x=>x.path.endsWith('/prepare')).length,beforeResume);
  await page.evaluate(()=>window.__connection.setScenario('retry'));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('后台同步暂时受阻，将稍后重试。',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/已读取 1 个账号题目/);
  await page.evaluate(()=>window.__connection.setScenario('expiring'));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText(/7 天内到期/).waitFor();assert.ok(await page.locator('time').getAttribute('datetime'));
  await page.screenshot({path:resolve(out,'expiring-'+width+'-'+theme+'.png'),fullPage:true});
  await page.evaluate(()=>window.__connection.setScenario('legacy'));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('本轮后台同步已完成。',{exact:true}).waitFor();await page.locator('time').waitFor({state:'detached'});assert.equal(await page.locator('time').count(),0);
  await page.evaluate(()=>window.__connection.setScenario('pair'));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('请先用当前账号重新配对 Companion。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'重新授权此机',exact:true}).count(),0);
  await page.evaluate(()=>window.__connection.setScenario('offline'));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('暂时无法核对后台同步，请检查 Companion 后刷新。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'刷新',exact:true}).isEnabled(),true);
  const dimensions=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(dimensions.width<=dimensions.viewport+1,JSON.stringify(dimensions));
  assert.deepEqual(errors,[]);rows.push({width,theme,passed:true,keyboardReauthorize:true,preservedLibrary:true,resumeWithoutRotation:true,offlineReadPreserved:true,legacySupported:true});await context.close();page=null;
 }
}catch(error){failure=String(error.stack??error);if(page)try{await page.screenshot({path:resolve(out,'failure.png'),fullPage:true});await writeFile(resolve(out,'failure-text.txt'),await page.locator('body').innerText());}catch(observationError){failure+='\nObservation: '+String(observationError);}}
finally{
 await browser?.close();await server?.close();const result={expected:4,passed:rows.length,complete:!failure,rows,failure,realModelCalls:0,productionWrites:0,
  limits:'Actual AccountStudyConnection, hook, use case, client, domain parser and styles; controlled transports and cloud read result; full Dashboard pause/recovery separately verified.'};
 await writeFile(resolve(out,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:rows.length,complete:!failure,failure}));process.exitCode=failure?1:0;
}
