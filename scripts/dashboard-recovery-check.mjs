import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {parseArgs} from 'node:util';
import {studyDay} from '../src/domain/planning/index.ts';
import {createNonwordAccount} from '../tests/fixtures/nonword-baseline-preview.mjs';
import {runDashboardLateResult} from './dashboard-late-result.mjs';
import {runDashboardCompletion} from './dashboard-completion.mjs';
import {runDashboardReceiptLoss} from './dashboard-receipt-loss.mjs';
import {runDashboardPendingContinuation} from './dashboard-pending-continuation.mjs';
import {runDashboardFormalReceiptLoss} from './dashboard-formal-receipt-loss.mjs';
import {runDashboardScopeSwitch} from './dashboard-scope-switch.mjs';
import {runDashboardSourceUpdate} from './dashboard-source-update.mjs';
import {runDashboardQuizFlow} from './dashboard-quiz-flow.mjs';
import {runDashboardFlashcardFlow} from './dashboard-flashcard-flow.mjs';
import {runDashboardCodeFlow,createDashboardCodeAccount} from './dashboard-code-flow.mjs';
import {verifyDashboardCodeAssets} from './dashboard-code-assets.mjs';
const repo=resolve(import.meta.dirname,'..'),project=repo.replaceAll('\\','/');
const {values:args}=parseArgs({options:{'browser-driver':{type:'string'},chrome:{type:'string'},out:{type:'string'},scenario:{type:'string'}}});
const root=await mkdtemp(resolve(tmpdir(),'zhixue-dashboard-recovery-')),out=resolve(args.out??resolve(root,'evidence'));
const driver=args['browser-driver']??process.env.UX_BROWSER_DRIVER;
await mkdir(out,{recursive:true});
await writeFile(resolve(out,'results.json'),JSON.stringify({complete:false,passed:0,phase:'setup',ownerProcessId:process.pid}));
let account,server,browser,lastPage,lastErrors=[],lastDocuments=[],lastRuntimeNetwork=[],lastConsole=[],lastHttpProblems=[],diagnostics=null,failure=null,runtimeAssets=null;const requests=[],pages=[],dialogs=[],retired=[];
try{
 if(args.scenario&&!['recovery','late-result','completion','receipt-loss','pending-continuation','formal-receipt-loss','formal-receipt-no-replay','scope-switch','source-update','quiz-flow','flashcard-flow','code-flow'].includes(args.scenario))throw Error('Unknown Dashboard check scenario');
 await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
 await writeFile(resolve(root,'entry.jsx'),`
import React from'react';import{createRoot}from'react-dom/client';
import Dashboard from'/@fs/${project}/app/study-dashboard.tsx';
import{OnboardingProvider}from'/@fs/${project}/app/onboarding.tsx';
import{StudyLayoutRuntime}from'/@fs/${project}/app/study-layout-control.tsx';
import{ReleaseNotice}from'/@fs/${project}/app/release-support.tsx';
import{saveWorkspaceRecord}from'/@fs/${project}/app/local-study-db.ts';
import{createLocalAttemptRepository}from'/@fs/${project}/src/infrastructure/learning-attempt/index.ts';
import{getLocalStudyRecord}from'/@fs/${project}/app/local-account-study.ts';
const identity=await(await fetch('/api/session',{cache:'no-store'})).json();
if(!identity.authenticated||!identity.user?.userId)throw Error('Synthetic identity unavailable');
window.__dashboardProbe={read:async()=>{const repository=createLocalAttemptRepository({userId:identity.user.userId,libraryId:'library-a'});return(await repository.list()).filter(row=>row.checkpoint.mode==='calculation'&&row.checkpoint.purpose==='first').map(row=>({id:row.attemptId,itemKey:row.binding.itemKey,contentHash:row.binding.contentHash,answer:row.answer,submitted:row.submitted?.answer??null,evaluation:row.evaluation.status,formal:row.formal}));}};
window.__dashboardProbe.delivery=async id=>{const repository=createLocalAttemptRepository({userId:identity.user.userId,libraryId:'library-a'});return{status:await repository.status(id),pending:(await repository.pending()).filter(row=>row.mutation.attemptId===id).map(row=>({kind:row.mutation.kind,operationId:row.mutation.operationId}))};};
window.__dashboardProbe.recordDelivery=async eventId=>{const row=await getLocalStudyRecord('account:'+identity.user.userId,'library-a',eventId);return{record:row?.record??null,recordCloud:row?.cloud??null};};
window.__dashboardProbe.readScope=async scope=>{const repository=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId});return(await repository.list()).filter(row=>row.checkpoint.mode==='calculation'&&row.checkpoint.purpose==='first').map(row=>({id:row.attemptId,itemKey:row.binding.itemKey,contentHash:row.binding.contentHash,answer:row.answer,submitted:row.submitted?.answer??null,evaluation:row.evaluation.status,formal:row.formal}));};
window.__dashboardProbe.readAll=async()=>{const repository=createLocalAttemptRepository({userId:identity.user.userId,libraryId:'library-a'});return(await repository.list()).map(row=>({id:row.attemptId,mode:row.checkpoint.mode,purpose:row.checkpoint.purpose,parent:row.parentAttemptId,answer:row.answer,submitted:row.submitted,evaluation:row.evaluation,formal:row.formal,traversed:row.checkpoint.traversed}));};
import '/@fs/${project}/app/globals.css';import '/@fs/${project}/app/c-study.css';
import '/@fs/${project}/app/study-overview.css';
import '/@fs/${project}/app/study-interactions.css';
import '/@fs/${project}/app/study-core-ui.css';
import '/@fs/${project}/app/site-hierarchy.css';
import '/@fs/${project}/app/settings-progress-hierarchy.css';
await saveWorkspaceRecord('account:'+identity.user.userId,'account-study-preference','account');
createRoot(document.getElementById('root')).render(<OnboardingProvider><StudyLayoutRuntime/><ReleaseNotice/><Dashboard/></OnboardingProvider>);
`);
 server=await createServer({configFile:false,root,publicDir:args.scenario==='code-flow'?resolve(repo,'public'):false,css:{postcss:repo},cacheDir:resolve(root,'.vite'),optimizeDeps:{include:['react','react-dom','react-dom/client','katex','ts-fsrs']},plugins:[react(),{name:'owned-synthetic-api',configureServer(s){
  s.middlewares.use(async(req,res,next)=>{
   const url=new URL(req.url,'http://127.0.0.1:'+s.httpServer.address().port);
   const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
   if(!url.pathname.startsWith('/api/'))return next();
   if(url.pathname==='/api/session')return json({authenticated:true,user:{userId:account.userId,displayName:'完整页面隔离测试',email:''}});
   if(url.pathname==='/api/account-study'){
    try{
     const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
     const response=await account.handle(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body}:{})}));
     requests.push({method:req.method,action:req.method==='POST'?JSON.parse(body.toString()).action:url.searchParams.get('action'),status:response.status});
     res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
    }catch(error){return json({error:String(error)},500);}
   }
   if(url.pathname==='/api/sync'&&req.method==='GET')return json({hasProgress:false,progress:{answered:0,correct:0,itemStages:{},fsrsData:{}},cursor:0,syncedAt:null});
   return json({error:'synthetic-remote-write-blocked'},404);
  });
 }}],resolve:{alias:{react:resolve(repo,'node_modules/react'),'react-dom':resolve(repo,'node_modules/react-dom')}},
 server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,repo]}},logLevel:'error'});
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 if(args.scenario==='code-flow')runtimeAssets=await verifyDashboardCodeAssets(repo,origin);
 const day=studyDay(new Date().toISOString());
 const materialScenario=args.scenario==='quiz-flow'?'quiz-multiple':args.scenario==='flashcard-flow'?'nonvocab-flashcard':'guided-maths';
 account=args.scenario==='code-flow'?await createDashboardCodeAccount({repo,origin,day},'correct'):await createNonwordAccount({repo,origin,scenario:materialScenario,day,stage3:true});
 const {chromium}=(driver?createRequire(resolve(driver,'package.json')):createRequire(import.meta.url))('playwright');
 browser=await chromium.launch({headless:true,executablePath:args.chrome??process.env.EDU_CHROMIUM_PATH});
 const cases=args.scenario==='scope-switch'?[{width:1440,variant:'owner'},{width:1440,variant:'library'},{width:390,variant:'owner'},{width:390,variant:'library'}]
  :['quiz-flow','flashcard-flow','code-flow'].includes(args.scenario)?[1440,390].flatMap(width=>['light','dark'].flatMap(theme=>
    (args.scenario==='quiz-flow'?['correct','partial','wrong']:args.scenario==='code-flow'?['correct','retry','test-error']:['good','again','hard','easy']).map(variant=>({width,variant,theme}))))
  :[1440,390].map(width=>({width}));
 for(const {width,variant,theme} of cases){
  if(pages.length){
   const previous=account;account=null;lastPage=null;previous.close();
   account=args.scenario==='code-flow'?await createDashboardCodeAccount({repo,origin,day},variant):await createNonwordAccount({repo,origin,scenario:materialScenario,day,stage3:true});
  }
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],documentNavigations=[];
  const runtimeNetwork=[],consoleMessages=[],httpProblems=[],httpReads=[];lastRuntimeNetwork=runtimeNetwork;lastConsole=consoleMessages;lastHttpProblems=httpProblems;
  if(args.scenario==='code-flow'){
   page.on('response',response=>{const path=new URL(response.url()).pathname;if(path.startsWith('/workers/')||path.startsWith('/vendor/'))runtimeNetwork.push({path,status:response.status()});});
   page.on('console',message=>{if(['warning','error'].includes(message.type())&&consoleMessages.length<30)consoleMessages.push({type:message.type(),text:message.text().slice(0,500)});});
   page.on('response',response=>{
    const url=new URL(response.url());if(url.origin!==origin||response.status()<400||httpProblems.length>=40)return;
    const request=response.request(),entry={method:request.method(),path:url.pathname,status:response.status()};
    if(url.pathname==='/api/account-study'&&request.method()==='POST'){
     try{entry.action=request.postDataJSON()?.action;}catch{/* Only a valid synthetic JSON action is observed. */}
    }
    httpProblems.push(entry);
    if(url.pathname.startsWith('/api/'))httpReads.push(response.json().then(body=>{
     if(typeof body.error==='string'&&/^[a-z0-9:-]{1,80}$/.test(body.error))entry.errorCode=body.error;
    }).catch(()=>{/* Non-JSON or retired response bodies provide no error code. */}));
   });
  }
  lastDocuments=documentNavigations;page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())documentNavigations.push(request.url());});
  lastPage=page;lastErrors=errors;page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{
   const accepted=args.scenario==='scope-switch'&&variant==='library'&&dialog.type()==='confirm'
    &&dialog.message()==='确认使用账号当前关联的学习库？旧库记录和进度保留，不自动合并到新库；当前页未提交的输入会清除。';
   dialogs.push({type:dialog.type(),message:dialog.message(),disposition:accepted?'accepted-synthetic-library-switch':'dismissed'});
   if(accepted)await dialog.accept();else await dialog.dismiss();
  });
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await page.goto(origin+'/study?companionPort=59999');await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:'开始今日自测',exact:true}).waitFor({timeout:30000});
  if(theme==='dark'){
   await page.getByRole('button',{name:'数据与设置',exact:true}).click();
   await page.getByRole('button',{name:/^深色模式/}).click();
   await page.locator('html.dark').waitFor();
   await page.getByRole('button',{name:'今日',exact:true}).click();
   await page.getByRole('button',{name:'开始今日自测',exact:true}).waitFor();
  }
  if(theme)assert.equal(await page.locator('.dark').count()>0,theme==='dark','Verify actual site theme, not browser preference');
  await page.getByRole('button',{name:'开始今日自测',exact:true}).click();
  if(args.scenario==='code-flow'){
   const checked=await runDashboardCodeFlow({page,account,width,variant,theme,out,errors});
   assert.equal(documentNavigations.length,2,'Code flow only uses initial navigation and final explicit reload');
   await Promise.allSettled(httpReads);
   console.log(JSON.stringify({width,variant,theme,passed:true}));pages.push({...checked,documentNavigations,runtimeNetwork,consoleMessages,httpProblems});await context.close();continue;
  }
  if(args.scenario==='flashcard-flow'){
   await page.getByRole('button',{name:/^显示答案/}).waitFor({timeout:30000});
   const checked=await runDashboardFlashcardFlow({page,account,width,variant,theme,out,errors,origin});
   assert.equal(documentNavigations.length,3,'Flashcard flow only uses initial navigation and two explicit reloads');
   console.log(JSON.stringify({width,variant,theme,passed:true}));
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  if(args.scenario==='quiz-flow'){
   await page.getByRole('group',{name:'选择所有正确选项',exact:true}).waitFor({timeout:30000});
   const checked=await runDashboardQuizFlow({page,account,width,variant,theme,out,errors,origin});
   assert.equal(documentNavigations.length,2,'Quiz flow only uses initial navigation and explicit final reload');
   console.log(JSON.stringify({width,variant,theme,passed:true}));
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  await page.getByRole('textbox',{name:'你的答案'}).waitFor({timeout:30000});
  if(args.scenario==='source-update'){
   const checked=await runDashboardSourceUpdate({page,context,account,width,out,errors});
   assert.equal(documentNavigations.length,1,'Source update uses existing refresh controls');
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  if(args.scenario==='scope-switch'){
   const original=account;
   const activate=async extra=>{const next=await createNonwordAccount({repo,origin,scenario:'guided-maths',day,stage3:true,...extra});retired.push(account);account=next;return next;};
   const checked=await runDashboardScopeSwitch({page,context,account:original,activate,variant,width,out,errors});
   assert.equal(documentNavigations.length,1,'Scope changes use actual recovery controls, not document replacement');
   pages.push({...checked,documentNavigations});await context.close();for(const old of retired.splice(0))old.close();continue;
  }
  if(args.scenario==='formal-receipt-loss'||args.scenario==='formal-receipt-no-replay'){
   const checked=await runDashboardFormalReceiptLoss({page,context,account,width,out,errors,dropRecoveredReceipts:args.scenario==='formal-receipt-no-replay'});
   assert.equal(documentNavigations.length,2,'Only initial and explicit formal receipt recovery reload are allowed');
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  if(args.scenario==='receipt-loss'||args.scenario==='pending-continuation'){
   let checked=await runDashboardReceiptLoss({page,context,account,width,out,errors});
   if(args.scenario==='pending-continuation')checked=await runDashboardPendingContinuation({page,account,width,out,previous:checked,errors});
   assert.equal(documentNavigations.length,args.scenario==='pending-continuation'?3:2,'Only explicit scenario reloads are allowed');
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  if(args.scenario==='late-result'||args.scenario==='completion'){
   let checked=await runDashboardLateResult({page,context,account,width,out,errors});
   if(args.scenario==='completion')checked=await runDashboardCompletion({page,account,width,out,previous:checked,errors});
   assert.equal(documentNavigations.length,args.scenario==='completion'?2:1,'Only explicit scenario document navigations are allowed');
   pages.push({...checked,documentNavigations});await context.close();continue;
  }
  const input=page.getByRole('textbox',{name:'你的答案'});await input.fill(' 1/2 ');
  await page.getByRole('button',{name:'暂停并保存',exact:true}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  const paused=await page.evaluate(()=>window.__dashboardProbe.read());assert.equal(paused[0].answer,' 1/2 ');
  await page.getByRole('button',{name:'继续学习',exact:true}).click();
  await page.getByRole('button',{name:'提交',exact:true}).click();
  await page.getByText('首轮答案已保留 · 待核对',{exact:true}).waitFor();
  const pending=await page.evaluate(()=>window.__dashboardProbe.read());assert.equal(pending[0].submitted,' 1/2 ');assert.equal(pending[0].evaluation,'pending');assert.equal(pending[0].formal,null);
  await page.reload();await page.waitForLoadState('networkidle');await page.getByRole('button',{name:/^(开始|继续)今日自测$/}).click();await input.waitFor();
  assert.equal(await input.inputValue(),' 1/2 ');assert.deepEqual(await page.evaluate(()=>window.__dashboardProbe.read()),pending);
  await context.route('**/api/account-study**',route=>route.abort('failed'));
  await page.reload();await page.waitForLoadState('networkidle');await page.getByText('待核对答案',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__dashboardProbe.read()),pending);
  await page.screenshot({path:resolve(out,'api-offline-'+width+'.png'),fullPage:true});
  await context.unroute('**/api/account-study**');
  await page.reload();await page.waitForLoadState('networkidle');await page.getByRole('button',{name:/^(开始|继续)今日自测$/}).click();await input.waitFor();
  assert.equal(await input.inputValue(),' 1/2 ');assert.deepEqual(await page.evaluate(()=>window.__dashboardProbe.read()),pending);

  await page.screenshot({path:resolve(out,'initial-'+width+'.png'),fullPage:true});
  const body=await page.locator('body').innerText();
  assert.equal(documentNavigations.length,4,'No development reload may reset this learning flow');
  const status=await account.status();assert.equal(status.counts.records,0);assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
  pages.push({width,documentNavigations,passed:true,wholeDashboard:true,pausedRawPreserved:true,pendingRefreshPreserved:true,accountApiOutageOriginalPreserved:true,reconnectedOriginalPreserved:true,rawAnswer:pending[0].submitted,formal:null,body,errors,status});await context.close();
 }
}catch(error){failure=String(error.stack||error);if(lastPage){await lastPage.screenshot({path:resolve(out,'failure.png'),fullPage:true});diagnostics={body:await lastPage.locator('body').innerText(),allText:await lastPage.locator('body').textContent(),errors:lastErrors,documentNavigations:lastDocuments,runtimeNetwork:lastRuntimeNetwork,consoleMessages:lastConsole,httpProblems:lastHttpProblems,attempts:await lastPage.evaluate(()=>window.__dashboardProbe?.readAll?.()),accountStatus:await account?.status(),buttons:await lastPage.getByRole('button').evaluateAll(buttons=>buttons.map(button=>({text:button.innerText,label:button.getAttribute('aria-label'),disabled:button.disabled})))};}}
finally{
 await browser?.close();await server?.close();account?.close();for(const old of retired.splice(0))old.close();
 await writeFile(resolve(out,'results.json'),JSON.stringify({scenario:args.scenario??'recovery',expected:casesExpected(args.scenario),passed:pages.length,complete:!failure,phase:failure?'failed':'completed',failure,diagnostics,pages,requests,dialogs,runtimeAssets,realModelCalls:0,productionWrites:0,userAcceptance:'unverified',limits:'Actual Dashboard/Controller/SubjectView, root client providers/styles, browser IndexedDB, SDK and real isolated account handlers/SQLite. Only selected scenario; synthetic API identity, no Vinext SSR/hosted authentication, real account, physical device, uncancellable provider, two-device or all-plugins acceptance. Code uses real existing local opaque runtime for ordinary code, no escape probes. Scope/source switches only in their selected scenarios; recovery interrupts account API only, identity and assets stay online.'},null,2));
 console.log(JSON.stringify({passed:pages.length,complete:!failure,failure}));process.exitCode=failure?1:0;
}
function casesExpected(scenario){return scenario==='scope-switch'?4:['quiz-flow','code-flow'].includes(scenario)?12:scenario==='flashcard-flow'?16:2;}
