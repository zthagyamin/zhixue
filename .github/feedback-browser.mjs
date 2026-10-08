// Persistent version of the 10 reviewed calculation/continuation browser cases.
// The fixture is synthetic; application components and the local grader Worker are real.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const evidence=resolve(process.env.UX_EVIDENCE||'scratch/ci-evidence/feedback');
mkdirSync(evidence,{recursive:true});
mkdirSync('scratch/ux-browser',{recursive:true});
writeFileSync('scratch/ux-browser/main.tsx',`
import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CalculationPlugin} from '../../app/plugin-calculation';
import {ExtraPracticeSession} from '../../app/extra-practice-session';
import {createLearningDraftStore} from '../../app/learning-draft-store';
import {LearningDraftBoundary,LearningDraftLeaveGuard} from '../../app/learning-draft';
import {DashboardFocusHero} from '../../app/dashboard-focus-hero';
const probe={gradeCalls:0,saveCalls:0,records:0,advances:0,starts:0,completeSave:null as null|(()=>void),failSave:null as null|(()=>void)};
Object.assign(window,{__uxProbe:probe});
const store=createLearningDraftStore('synthetic-browser-only');
function Normal(){
 const [index,setIndex]=useState(0);const draft=store.adapter('q'+index,'calculation:1');
 return <><LearningDraftLeaveGuard store={store}/><LearningDraftBoundary store={store}><CalculationPlugin.renderUI key={index} data={{prompt:'浏览器测试题 '+index,answer:'2'}} context={{draft,gradeCalculation:async()=>{probe.gradeCalls++;return {verdict:new URLSearchParams(location.search).get('wrong')?'wrong':'correct',explanation:'完整解析应保留直到点击继续。'};}}} onGrade={(_rating,options)=>{
  const ticket=draft.begin();if(!ticket)return;probe.saveCalls++;
  if(!options?.deferAdvance)throw new Error('missing deferred advance');
  probe.completeSave=()=>{if(store.commit(ticket,()=>{probe.advances++;setIndex(value=>value+1);})){probe.records++;}};
  probe.failSave=()=>store.fail(ticket);
 }}/></LearningDraftBoundary></>;
}
function Demo(){
 const params=new URLSearchParams(location.search),mode=params.get('mode');
 if(mode==='extra')return <ExtraPracticeSession snapshot={{scopeKey:'browser-fixture',title:'隔离计算',items:Array.from({length:Number(params.get('count')||2)},(_,i)=>({id:'q'+i,prompt:'巩固测试题 '+i,answer:'2'})),modes:Array(Number(params.get('count')||2)).fill('calculation'),source:{title:'测试资料',scope:'合成数据'}}} canOpenLocal={false} getObsidianUri={()=>''} onExit={()=>{document.body.dataset.exited='true';}}/>;
 if(mode==='hero')return <><DashboardFocusHero summary={{groups:1,minutes:5,blocked:0}} lead={{taskId:'a',title:'测试任务',kind:'next'}} disabled={false} onStart={()=>probe.starts++} onAdvanced={()=>{}}/><div style={{height:2000}}>普通页面内容</div></>;
 return <Normal/>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Demo/></StrictMode>);
`);
writeFileSync('scratch/ux-browser/index.html','<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/scratch/ux-browser/main.tsx"></script></html>');
const origin='http://127.0.0.1:4179';
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:4179,strictPort:true},logLevel:'error'});
let browser;
const results=[];
let failure=null;
try {
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
  const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin||url.pathname.startsWith('/api/'))return route.abort('blockedbyclient');
   return route.continue();
  });
  const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const page=await context.newPage();
  const open=async query=>{await page.goto(origin+'/scratch/ux-browser/index.html?'+query);await page.getByRole('button',{name:'提交',exact:true}).waitFor();};
  for(const wrong of [false,true]) {
   await open('mode=normal'+(wrong?'&wrong=1':''));await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('2');
   assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
   await page.getByRole('button',{name:'提交',exact:true}).click();await page.getByText('完整解析应保留直到点击继续。',{exact:true}).waitFor();
   await page.getByText('正在保存作答…',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'继续',exact:true}).count(),0);
   if(wrong){await page.evaluate(()=>window.__uxProbe.failSave());await page.getByRole('button',{name:'重试保存',exact:true}).click();}
   await page.evaluate(()=>window.__uxProbe.completeSave());await page.getByRole('button',{name:'继续',exact:true}).waitFor();
   assert.equal(await page.getByRole('textbox',{name:'你的答案',exact:true}).getAttribute('readonly'),'');
   assert.deepEqual(await page.evaluate(()=>({grades:window.__uxProbe.gradeCalls,records:window.__uxProbe.records,advances:window.__uxProbe.advances})),{grades:1,records:1,advances:0});
   assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false);
   await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('heading',{name:'浏览器测试题 1',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.__uxProbe.records),1);results.push({viewport,case:'saved-calculation',wrong,passed:true});
  }
  for(const count of [1,2]) {
   await open('mode=extra&count='+count);await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('0');await page.getByRole('button',{name:'提交',exact:true}).click();
   await page.getByText('✗ 回答错误',{exact:true}).waitFor();await page.getByRole('button',{name:'继续',exact:true}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'巩固测试题 0',exact:true}).count(),1);
   await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('button',{name:'提交',exact:true}).waitFor();
   assert.equal(await page.getByRole('textbox',{name:'你的答案',exact:true}).inputValue(),'');
   for(let i=0;i<count;i++) {
    await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('2');await page.getByRole('button',{name:'提交',exact:true}).click();await page.getByRole('button',{name:'继续',exact:true}).click();
   }
   await page.getByRole('heading',{name:'本轮巩固完成',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__uxProbe.records),0);results.push({viewport,case:'real-extra-worker',count,passed:true});
  }
  await page.goto(origin+'/scratch/ux-browser/index.html?mode=hero');const primary=page.locator('button.study-primary-action');await primary.waitFor();
  await page.evaluate(()=>{document.body.tabIndex=0;document.body.focus();});await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.__uxProbe.starts),0);
  await primary.focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.__uxProbe.starts),1);results.push({viewport,case:'native-space',passed:true});
  assert.deepEqual(errors,[]);await context.close();
 }
 assert.equal(results.length,10,'All 10 feedback scenarios must execute');
} catch(error) {
 failure=String(error.stack||error);
 throw error;
} finally {
 const report={sha:process.env.GITHUB_SHA||null,expected:10,passed:results.length,complete:failure===null&&results.length===10,failure,results};
 writeFileSync(resolve(evidence,'results.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 await browser?.close();await server.close();
}
