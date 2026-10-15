import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {boundarySetup,runBoundaryScenario} from './nonword-host-boundaries.mjs';
import {copyCompanionPreviewPayload} from '../tests/helpers/companion-preview.mjs';
const {values:args}=parseArgs({options:{python:{type:'string'},payload:{type:'string'},'browser-driver':{type:'string'},chrome:{type:'string'},out:{type:'string'},scenario:{type:'string'}}});
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const driver=args['browser-driver']??process.env.UX_BROWSER_DRIVER;
const run=await mkdtemp(resolve(tmpdir(),'zhixue-nonword-host-')),root=resolve(run,'ui');
const evidence=resolve(args.out??resolve(run,'evidence')),copied=resolve(run,'companion');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(evidence,'results.json'),JSON.stringify({expected:2,passed:0,complete:false,phase:'setup',failure:null}));
let server,child,browser,info,exitPromise,lastPage,lastErrors=[],diagnostics=null,childExit=null,failure=null;const rows=[];
async function stopChild(){
 if(!child?.pid||childExit!==null)return;
 child.stdin.end('stop\n');
 const kill=setTimeout(()=>child.kill(),5000);
 let limit;
 try{await Promise.race([exitPromise,new Promise((_,reject)=>{limit=setTimeout(()=>reject(Error('Owned fixture termination unconfirmed')),10000);})]);}
 finally{clearTimeout(kill);clearTimeout(limit);}
}
try{
 if(args.scenario&&!['recovery','boundaries'].includes(args.scenario))throw Error('Unknown host-check scenario');
 await copyCompanionPreviewPayload(resolve(args.payload??resolve(repo,'companion')),copied);
 const {chromium}=(driver?createRequire(resolve(driver,'package.json')):createRequire(import.meta.url))('playwright');
 server=await createServer({configFile:false,root,plugins:[react()],
  resolve:{alias:{react:resolve(repo,'node_modules/react'),'react-dom':resolve(repo,'node_modules/react-dom')}},
  server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[repo,run]}},logLevel:'error'});
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 await writeFile(resolve(copied,'config.json'),JSON.stringify({learning_vault_root:'',
  study_loop_integration_root:'_System/Integrations/Study Loop',allowed_origins:[origin],
  deepseek_model:'deepseek-v4-flash',deepseek_model_migrated:true}));
 child=spawn(args.python??process.env.PYTHON??'python',['-I','-B','-X','utf8',resolve(repo,'scripts/nonword-host-recovery-fixture.py'),copied,origin],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 exitPromise=new Promise(resolve=>child.once('exit',code=>{childExit=code;resolve(code);}));
 child.stdin.on('error',()=>{});
 let raw='',err='';child.stderr.on('data',value=>{err=(err+value).slice(-4096);});
 info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned fixture startup timed out')),15000);
  const done=(fn,value)=>{clearTimeout(timer);fn(value);};
  child.stdout.on('data',chunk=>{raw+=chunk.toString();const end=raw.indexOf('\n');if(end>=0){try{done(resolve,JSON.parse(raw.slice(0,end)));}catch(error){done(reject,error);}}});
  child.once('error',error=>done(reject,error));child.once('exit',()=>done(reject,Error('Owned fixture ended: '+err)));});
 const project=repo.replaceAll('\\','/');
 await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
 await writeFile(resolve(root,'entry.jsx'),`
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{CalculationPlugin}from${JSON.stringify('/@fs/'+project+'/app/plugin-calculation.tsx')};
import{NonWordPluginHost}from${JSON.stringify('/@fs/'+project+'/app/study-dashboard/nonword-plugin-host.tsx')};
import{createLearningDraftStore,learningDraftItemId}from${JSON.stringify('/@fs/'+project+'/app/learning-draft-store.ts')};
import{createCompanionPlanClient}from${JSON.stringify('/@fs/'+project+'/app/companion-plan-client.ts')};
import{createSourceAdmissionClient}from${JSON.stringify('/@fs/'+project+'/src/infrastructure/source-admission/index.ts')};
import{createLocalAttemptRepository,attemptFingerprint}from${JSON.stringify('/@fs/'+project+'/src/infrastructure/learning-attempt/index.ts')};
import '/@fs/${project}/app/globals.css';
import '/@fs/${project}/app/c-study.css';
const requests=[],grades=[];window.__host={requests,grades,moves:0};
const fetcher=async(url,options)=>{const response=await fetch(url,options);const body=await response.clone().json();requests.push({path:new URL(url).pathname,action:options.body?JSON.parse(options.body).action:null,status:response.status,body});return response;};
const client=createCompanionPlanClient({baseUrl:${JSON.stringify(info.base)},sessionToken:${JSON.stringify(info.session)},fetcher});
const original={questionType:'calculation',prompt:'计算 $1/2$ 的数值。',answer:'0.5',explanation:'分子除以分母。'};
const scope={workspaceId:'synthetic-full-host',ownerId:${JSON.stringify(info.owner)},libraryId:${JSON.stringify(info.library)},
 snapshotId:'synthetic-local',itemKey:'full-host-'+window.innerWidth,contentHash:await attemptFingerprint(original),
 groupId:'group-'+window.innerWidth,roundId:'first-round',cloud:false,sourceConfirmationRequired:true};
const data={...original,id:scope.itemKey,itemId:scope.itemKey,contentHash:scope.contentHash};
const store=createLearningDraftStore('host-'+window.innerWidth),draft=store.adapter(learningDraftItemId('synthetic-subject',scope.itemKey,data),'calculation:1','合成计算题');
const repository=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId});
window.__host.read=async()=>{const all=await repository.list();const row=all.find(row=>row.binding.itemKey===scope.itemKey&&!row.parentAttemptId&&row.checkpoint.purpose==='first'&&row.checkpoint.mode==='calculation');
 if(!row)return null;return{answer:row.answer,submitted:row.submitted?.answer??null,evaluation:row.evaluation.status,formal:row.formal,
  paused:row.checkpoint.view?.paused??false,traversed:row.checkpoint.traversed??false,seconds:row.checkpoint.activeSeconds??0};};
const admission=(libraryId,current)=>createSourceAdmissionClient({baseUrl:${JSON.stringify(info.base)},sessionToken:${JSON.stringify(info.session)},
 libraryId,remoteOwnerId:scope.ownerId,capabilities:['nonword-source-v1'],fetcher,isCurrent:current});
window.__host.verifyRemote=async()=>{
 const row=(await repository.list()).find(row=>row.binding.itemKey===scope.itemKey&&row.checkpoint.purpose==='first'&&row.checkpoint.mode==='calculation');
 const {answer,answerRevision,submittedAt,assistance,maxPreHintLevel,answerRevealed}=row.submitted;
 const expected={attemptId:row.attemptId,itemKey:scope.itemKey,contentHash:scope.contentHash,libraryId:scope.libraryId,
  answer,answerRevision,submittedAt,purpose:row.checkpoint.purpose,parentAttemptId:row.parentAttemptId,assistance,
  ...(maxPreHintLevel===undefined?{}:{maxPreHintLevel}),...(answerRevealed===undefined?{}:{answerRevealed})};
 const read=await admission(scope.libraryId).read(row.attemptId,expected);
 return{answer:read.submission.answer,status:read.status,durable:read.durable,sourceBound:Boolean(read.sourceBinding),evaluation:read.evaluation,formal:row.formal};
};
const bindings=[{scope,data,original,draft}];
${args.scenario==='boundaries'?boundarySetup:''}
function App(){const [continued,setContinued]=useState(false),[selected,setSelected]=useState(0);
 window.__host.select=index=>{setContinued(false);setSelected(index);};
 const {scope,data,original,draft}=bindings[selected];
 const context={draft,nonWordScope:scope,contentSource:{mode:'calculation',data:original},
  gradeCalculation:(item,answer)=>client.gradePractice(item,answer),sourceAdmission:admission,
  nonWordNavigation:{continuePending:()=>{window.__host.moves++;setContinued(true);},resumeFormal:()=>{throw Error('No formal result expected');}}};
 return <main className="study-app" style={{maxWidth:850,margin:'0 auto',padding:24}}>{continued?<p role="status">待核对答案已保留，已继续。</p>:
  <NonWordPluginHost plugin={CalculationPlugin} data={data} context={context} onGrade={rating=>grades.push(rating)}/>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
 browser=await chromium.launch({headless:true,executablePath:args.chrome??process.env.EDU_CHROMIUM_PATH});
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
  lastPage=page;lastErrors=errors;page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>[origin,info.base].includes(new URL(route.request().url()).origin)?route.continue():route.abort('blockedbyclient'));
  if(args.scenario==='boundaries'){rows.push(await runBoundaryScenario({page,origin,width,evidence,errors}));await context.close();continue;}
  await page.goto(origin);const input=page.getByRole('textbox',{name:'你的答案'});await input.waitFor();
  await input.fill(' 1/2 ');await page.getByRole('button',{name:'暂停并保存',exact:true}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  const paused=await page.evaluate(()=>window.__host.read());assert.equal(paused.answer,' 1/2 ');assert.equal(paused.paused,true);assert.equal(paused.submitted,null);
  await page.reload();await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  const restored=await page.evaluate(()=>window.__host.read());assert.equal(restored.answer,' 1/2 ');assert.equal(restored.paused,true);
  // The measured pause is the subject of the assertion, not a readiness sleep.
  await page.waitForTimeout(2200);const stillPaused=await page.evaluate(()=>window.__host.read());assert.equal(stillPaused.seconds,restored.seconds);
  await page.getByRole('button',{name:'继续学习',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),' 1/2 ');
  await page.getByRole('button',{name:'提交',exact:true}).click();await page.getByText('首轮答案已保留 · 待核对',{exact:true}).waitFor();
  const submitted=await page.evaluate(()=>window.__host.read());assert.equal(submitted.submitted,' 1/2 ');assert.equal(submitted.evaluation,'pending');assert.equal(submitted.formal,null);
  assert.deepEqual(await page.evaluate(()=>window.__host.grades),[]);assert.ok(await page.locator('h2 .katex').count()>0);
  await page.reload();await input.waitFor();assert.equal(await input.inputValue(),' 1/2 ');
  await page.getByRole('button',{name:'恢复核对',exact:true}).click();
  await page.waitForFunction(()=>window.__host.requests.some(row=>row.path==='/v1/nonword/source'&&row.action==='submit'&&row.status===200));
  await page.getByRole('button',{name:'恢复核对',exact:true}).click();
  await page.waitForFunction(()=>window.__host.requests.some(row=>row.path==='/v1/nonword/source'&&row.action==='read'&&row.status===200));
  await page.screenshot({path:resolve(evidence,'pending-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'保留答案，继续',exact:true}).click();
  await page.getByText('待核对答案已保留，已继续。',{exact:true}).waitFor();
  const finished=await page.evaluate(()=>window.__host.read());assert.equal(finished.submitted,' 1/2 ');assert.equal(finished.formal,null);assert.equal(finished.traversed,true);
  const sourceCalls=await page.evaluate(()=>window.__host.requests.filter(row=>row.path==='/v1/nonword/source').map(row=>({action:row.action,status:row.status})));
  assert.ok(sourceCalls.some(row=>row.action==='capture'&&row.status===200));
  assert.equal(sourceCalls.filter(row=>row.action==='submit'&&row.status===200).length,1);
  assert.deepEqual(await page.evaluate(()=>window.__host.verifyRemote()),{answer:' 1/2 ',status:'saved',durable:true,sourceBound:false,evaluation:null,formal:null});
  assert.equal(await page.evaluate(()=>window.__host.moves),1);assert.deepEqual(await page.evaluate(()=>window.__host.grades),[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(evidence,'continued-'+width+'.png'),fullPage:true});
  rows.push({width,passed:true,actualBoundHost:true,pausedRefreshPreserved:true,pauseDoesNotCount:true,pendingRefreshPreserved:true,
    sourceClientInvoked:true,sourceCalls,remoteOriginalReadback:true,sourceSubmits:1,traversed:true,moves:1,formal:null});await context.close();
 }
 await stopChild();assert.equal(childExit,0);
}catch(error){
 failure=String(error.stack||error);
 if(lastPage)try{
  await lastPage.screenshot({path:resolve(evidence,'failure.png'),fullPage:true});
  diagnostics={body:await lastPage.locator('body').innerText(),pageErrors:lastErrors};
 }catch(observationError){diagnostics={observationError:String(observationError),pageErrors:lastErrors};}
}
finally{
 for(const close of [()=>browser?.close(),()=>server?.close()]){
  try{await close();}catch(error){failure=[failure,String(error)].filter(Boolean).join('\n');}
 }
 try{await stopChild();}catch(error){failure=[failure,String(error)].filter(Boolean).join('\n');}
 const report={scenario:args.scenario??'recovery',expected:2,passed:rows.length,complete:!failure,phase:failure?'failed':'completed',failure,diagnostics,rows,childExit,bundledCompanion:info?{module:info.module,python:info.python}:null,
 realModelCalls:0,productionWrites:0,limits:'Actual NonWordPluginHost/BoundNonWordHost/NonWordStudyHost, browser IndexedDB, real SDK/source client/selected copied Handler. Only managed public Python/seed/version copied, no private config/data or installed startup. Navigation/onGrade are controlled collectors; no full Dashboard, real material, account sync or physical-device acceptance.'};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:rows.length,complete:!failure,failure,childExit}));
}
process.exitCode=failure?1:0;
