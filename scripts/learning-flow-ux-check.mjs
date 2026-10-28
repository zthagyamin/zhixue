import assert from 'node:assert/strict';
// Optional local browser check. Set UX_BROWSER_DRIVER and EDU_CHROMIUM_PATH
// when the host does not provide the Windows development defaults below.
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

if(!process.env.AGENT_EVIDENCE_DIR)throw Error('Run through Invoke-AgentTemp: evidence directory required');
const repo=resolve(import.meta.dirname,'..'),project=repo.replaceAll('\\','/');
const root=await mkdtemp(resolve(tmpdir(),'learning-flow-ux-'));
const out=resolve(process.env.AGENT_EVIDENCE_DIR,'learning-flow-ux-results.json');
const results=[];let browser,server,failure=null,lastPage;
try {
 await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
 await writeFile(resolve(root,'entry.jsx'),`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{PracticeSession}from'/@fs/${project}/app/practice-session.tsx';
import{PracticeResult}from'/@fs/${project}/src/features/review-session/index.ts';
import{SyncSummary,useSyncDetails}from'/@fs/${project}/src/features/sync/index.ts';
import{StudyPanel}from'/@fs/${project}/app/study-session-shell.tsx';
import{bindInlineNonWordRound}from'/@fs/${project}/src/features/nonword-study/index.ts';
import{createNonWordRoundRuntime}from'/@fs/${project}/src/infrastructure/nonword-study/index.ts';
import{continueNonWordRound}from'/@fs/${project}/src/application/nonword-study/index.ts';
import'/@fs/${project}/app/globals.css';import'/@fs/${project}/app/c-study.css';import'/@fs/${project}/app/study-core-ui.css';
const item={itemId:'synth-1',abilityId:'synth-1',domain:'synthetic',sourceNote:'',stateRef:'',questionType:'quiz',prompt:'合成测试问题',options:['正确选项','干扰选项'],answer:0,sourceLabel:'合成学科',fingerprint:'synthetic'};
const params=new URLSearchParams(location.search),empty=params.get('empty')==='1',recall=params.get('recall')==='1',round=params.get('round')==='1';
const rows=['A','B','C'].map((id,i)=>({...item,itemId:id,prompt:id,contentHash:String(i+1).repeat(64)}));
const scopeFor=row=>({workspaceId:'synthetic',ownerId:'synthetic',libraryId:'library',snapshotId:'snapshot',itemKey:row.itemId,contentHash:row.contentHash,groupId:'group',roundId:JSON.stringify(['2026-10-05','inline',null]),cloud:false});
const items=empty?[]:round?rows:[recall?{...item,questionType:'recall',answer:'合成参考',reviewPoint:'合成参考'}:item];
if(round){const binding=bindInlineNonWordRound(rows,scopeFor);const port=await createNonWordRoundRuntime({scope:{ownerId:'synthetic',libraryId:'library',groupId:JSON.stringify(['group',scopeFor(rows[0]).roundId]),day:binding.scope.day,cloud:false},members:binding.scope.members});await continueNonWordRound(port,'A','pending');await continueNonWordRound(port,'B','skipped');await continueNonWordRound(port,'C','skipped');}
function App(){const[result,setResult]=useState(null),details=useSyncDetails('account:synthetic',()=>{});
window.__uxResult=result;
return <main className="study-app"><SyncSummary pending={null} workspaceId="account:synthetic" onOpenDetails={details.show}/>
{result?<PracticeResult result={result} onBack={()=>{}}/>:<PracticeSession items={items} temporary={!round} nonWordScopeFor={round?scopeFor:undefined} onFinish={setResult} onRecordAttempt={(_a,r)=>r.durable()}/>}
<StudyPanel open={details.open} onClose={details.close} title="同步与记录"><div ref={details.focusTarget}><h3 tabIndex={-1} id="study-sync-details">同步详情</h3><p>只读测试面板</p></div></StudyPanel></main>}
createRoot(document.getElementById('root')).render(<App/>);`);
 server=await createServer({configFile:false,root,publicDir:false,cacheDir:resolve(root,'.vite'),plugins:[react()],optimizeDeps:{include:['react','react-dom','react-dom/client','katex','ts-fsrs']},resolve:{alias:{react:resolve(repo,'node_modules/react'),'react-dom':resolve(repo,'node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,repo]}},logLevel:'error'});
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 const driver=process.env.UX_BROWSER_DRIVER??resolve(repo,'../.browser-driver-1.63');
 const {chromium}=createRequire(resolve(driver,'package.json'))('playwright');
 browser=await chromium.launch({headless:true,executablePath:process.env.EDU_CHROMIUM_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 for(const width of [1440,390])for(const theme of ['light','dark'])for(const scenario of ['stopped','empty','exhausted','input','round']){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();lastPage=page;const errors=[],blocked=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort('blockedbyclient');});
  await page.goto(origin+'/?empty='+(scenario==='empty'?'1':'0')+'&recall='+(scenario==='input'?'1':'0')+'&round='+(scenario==='round'?'1':'0'));if(theme==='dark')await page.evaluate(()=>document.documentElement.classList.add('dark'));
  if(scenario==='input'){
    const input=page.getByRole('textbox',{name:'写下你回忆到的内容'});await input.waitFor();await input.fill('合成草稿，原样保留');
    await page.getByRole('button',{name:'查看同步详情'}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='study-sync-details',null,{timeout:3000});
    await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'同步与记录'}).waitFor({state:'hidden'});
    assert.equal(await input.inputValue(),'合成草稿，原样保留');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'查看同步详情');
    assert.deepEqual(errors,[]);results.push({width,theme,scenario,draftPreserved:true,externalRequestsBlocked:blocked.length});await context.close();continue;
  }
  if(scenario==='round'){
    await page.getByRole('heading',{name:'本轮已练'}).waitFor();await page.getByText(/待核对 1.*暂时跳过 2/).waitFor();
    await page.getByRole('button',{name:'结束复习',exact:true}).click();await page.getByRole('region',{name:'本轮练习结果'}).waitFor();
    const result=await page.evaluate(()=>window.__uxResult);assert.equal(result.reason,'exhausted');assert.equal(result.awaitingReview,1);assert.equal(result.skipped,2);assert.equal(result.answered,0);
    await page.getByText(/待核对 1 题.*暂时跳过 2 题/).waitFor();assert.equal(await page.getByText('今日这项任务已完成',{exact:true}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Round summary fits the viewport');
    await page.screenshot({path:resolve(process.env.AGENT_EVIDENCE_DIR,`result-round-${width}-${theme}.png`),fullPage:true});
    assert.deepEqual(errors,[]);results.push({width,theme,scenario,result,externalRequestsBlocked:blocked.length});await context.close();continue;
  }
  if(scenario==='empty'){
    await page.getByRole('heading',{name:'当前范围暂无可练复习题'}).waitFor();await page.getByRole('button',{name:'返回今日',exact:true}).click();
  } else {
    await page.getByText('合成测试问题',{exact:true}).waitFor();
    if(scenario==='exhausted'){
      await page.getByRole('button',{name:/正确选项/}).click();
      const feedback=page.getByRole('button',{name:'继续',exact:true});await feedback.waitFor();
      const open=page.getByRole('button',{name:'查看同步详情'});await open.click();await page.getByRole('heading',{name:'同步详情'}).waitFor();
      await page.waitForFunction(()=>document.activeElement?.id==='study-sync-details',null,{timeout:3000});
      await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'同步与记录'}).waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'查看同步详情');
      await feedback.waitFor();assert.equal(await page.getByText('合成测试问题',{exact:true}).count(),1);
      await feedback.click();
    }else await page.getByRole('button',{name:'结束复习',exact:true}).click();
  }
  await page.getByRole('region',{name:'本轮练习结果'}).waitFor();
  const result=await page.evaluate(()=>window.__uxResult);
  assert.equal(result.reason,scenario);assert.equal(await page.getByText('今日这项任务已完成',{exact:true}).count(),0);
  assert.equal(await page.getByText('本轮复习完成',{exact:true}).count(),0);
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(layout.scroll<=layout.width,`No document overflow at ${width}px: ${layout.scroll}`);
  if(scenario==='stopped'||scenario==='round')await page.screenshot({path:resolve(process.env.AGENT_EVIDENCE_DIR,`result-${scenario}-${width}-${theme}.png`),fullPage:true});
  assert.deepEqual(errors,[]);results.push({width,theme,scenario,result,externalRequestsBlocked:blocked.length});await context.close();
 }
}catch(error){failure=String(error.stack||error);if(lastPage)try{await lastPage.screenshot({path:resolve(process.env.AGENT_EVIDENCE_DIR,'learning-flow-ux-failure.png')});}catch{/* The original failure remains authoritative if the page has already closed. */}}
finally{await browser?.close();await server?.close();await writeFile(out,JSON.stringify({complete:!failure,passed:results.length,results,failure,limitations:'合成题目与面板；待核对和跳过使用隔离浏览器数据库的真实题组状态，不代表生产账号验收。无生产写入和 AI 调用。'},null,2));console.log(JSON.stringify({complete:!failure,passed:results.length,failure}));if(failure)process.exitCode=1;}
