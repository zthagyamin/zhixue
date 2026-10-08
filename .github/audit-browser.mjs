// Persistent review regressions. Real UI + IndexedDB; synthetic owners and fault injection only.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/ci-audit'),evidence=resolve(process.env.UX_EVIDENCE||'scratch/ci-evidence/audit');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(resolve(root,'entry.tsx'),String.raw`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {LearningLibrary} from '../../app/learning-library';
import {OnboardingDialog} from '../../app/onboarding';
import {ReleaseSupport} from '../../app/release-support';
import {StudyAIMarkdown} from '../../app/components/ai-sidebar/study-ai-chat-stream';
import '../../app/globals.css';import '../../app/c-study.css';import '../../app/study-overview.css';
import '../../app/components/ai-sidebar/study-ai.css';
document.documentElement.classList.toggle('dark',window.__auditTheme==='dark');
window.__auditIO={failRead:location.search.includes('read=fail'),failWrite:false,deferWrite:false,releaseWrite:null,writes:0};
const subjects=[{id:'python',name:'Python 100天',pluginType:'code',items:[{}]},{id:'vision',name:'CS231n',pluginType:'recall',items:[{}]},{id:'english',name:'学术英语',pluginType:'three-stage',items:[{}]}];
function App(){const [owner,setOwner]=useState('audit-a'),[chosen,setChosen]=useState(''),[empty,setEmpty]=useState(false),[tutorial,setTutorial]=useState(false),[step,setStep]=useState(0),[code,setCode]=useState('print(1)');return <>
 <main className="study-app" data-page="today" data-owner={owner} data-chosen={chosen}><div className="workspace">
 <h1>知学 · 隔离综合回归</h1><div><button onClick={()=>setOwner(owner==='audit-a'?'audit-b':'audit-a')}>切换测试学习库</button><button onClick={()=>setEmpty(value=>!value)}>切换空资料</button><button onClick={()=>{setStep(0);setTutorial(true);}}>打开教学</button></div>
 <LearningLibrary subjects={empty?[]:subjects} owner={owner} library={owner+'-library'} onChoose={setChosen} onSources={()=>setChosen('sources')} paper={<button>论文入口</button>}/>
 <section className="study-ai-sidebar" data-copy-fixture><h2>回答复制</h2><StudyAIMarkdown text={'\u0060\u0060\u0060python\n'+code+'\n\u0060\u0060\u0060'}/><button onClick={()=>setCode('print(2)')}>更新测试回答</button></section>
 </div></main>
 <section className="support-page"><h1>帮助与版本</h1><ReleaseSupport/></section>
 {tutorial&&<OnboardingDialog progress={{version:1,step,path:null,status:'active'}} signedIn={false} storageError={false} onChange={value=>setStep(value.step??step)} onSkip={()=>setTutorial(false)} onFinish={()=>setTutorial(false)} onSignIn={()=>{}}/>}
 </>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
`);
// Delay the completion notification, not the real transaction. This reproduces owner changes
// while a write is in flight without adding test-only hooks to application components.
// Resolve before Vite's filesystem resolver, otherwise it bypasses the synthetic failures.
const ioModule='\0audit-library-io';
const faultInjection={name:'audit-library-io',enforce:'pre',resolveId(source,importer){if(source==='./local-study-db'&&importer?.split('?')[0].endsWith('/app/learning-library.tsx'))return ioModule;},load(id){if(id!==ioModule)return;return `
import * as db from ${JSON.stringify(resolve('app/local-study-db.ts'))};
export async function loadWorkspaceRecord(...args){if(window.__auditIO.failRead)throw new Error('synthetic read failure');return db.loadWorkspaceRecord(...args);}
export async function updateWorkspaceRecord(...args){const io=window.__auditIO;io.writes++;if(io.failWrite)throw new Error('synthetic write failure');await db.updateWorkspaceRecord(...args);if(io.deferWrite){io.deferWrite=false;await new Promise(resolve=>{io.releaseWrite=resolve;});}}
`;}};
const origin='http://127.0.0.1:4181';
const server=await createServer({configFile:false,root,plugins:[faultInjection,react()],server:{host:'127.0.0.1',port:4181,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
let browser,failure=null;const results=[],contrasts=[];
function metric(element){
 const parse=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;return [r,g,b,a/255];};
 const over=(f,b)=>{const a=f[3]+b[3]*(1-f[3]);return a?[0,1,2].map(i=>(f[i]*f[3]+b[i]*b[3]*(1-f[3]))/a).concat(a):[0,0,0,0];};
 let fg=parse(getComputedStyle(element).color),bg=[0,0,0,0];
 for(let node=element;node;node=node.parentElement){const css=getComputedStyle(node),back=parse(css.backgroundColor);fg=over(fg,back);bg=over(bg,back);fg[3]*=Number(css.opacity);bg[3]*=Number(css.opacity);}
 fg=over(fg,[255,255,255,1]);bg=over(bg,[255,255,255,1]);
 const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 const a=luminance(fg),b=luminance(bg);return {foreground:fg,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
}
async function contrast(locator,label,theme){const value=await locator.evaluate(metric);contrasts.push({theme,label,...value});assert.ok(value.ratio>=4.5,label+': '+value.ratio);return value;}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function open(viewport,theme,query=''){
 const context=await browser.newContext({viewport,colorScheme:theme==='dark'?'light':'dark'});context.setDefaultTimeout(20000);
 const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 await context.route('**/*',route=>{const url=new URL(route.request().url());
  if(url.origin!==origin)return route.abort('blockedbyclient');
  if(url.pathname==='/api/release')return route.fulfill({status:503,json:{error:'synthetic-unavailable'}});
  if(url.pathname.startsWith('/api/'))return route.abort('blockedbyclient');return route.continue();
 });
 // Init scripts may run before documentElement exists. Apply the DOM theme in entry.tsx.
 await context.addInitScript(({origin,theme})=>{if(location.origin===origin)window.__auditTheme=theme;},{origin,theme});
 const page=await context.newPage();await page.goto(origin+query);await page.getByRole('searchbox').waitFor();await settle(page);
 return {page,context,errors};
}
async function enabled(select){await select.waitFor();await select.evaluate(el=>new Promise((resolve,reject)=>{const end=Date.now()+15000;const check=()=>!el.disabled?resolve():Date.now()>end?reject(new Error('classification remained disabled')):requestAnimationFrame(check);check();}));}
const selector=page=>page.getByRole('combobox',{name:'Python 100天 的所属学科组',exact:true});
async function expandPython(page){await page.getByRole('button',{name:/Python 100天/}).locator('..').locator('summary').click();await enabled(selector(page));}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark']){
  const common={viewport:viewport.width,theme};
  {
   const {page,context,errors}=await open(viewport,theme);const search=page.getByRole('searchbox');
   await search.fill('  PYTHON　');await page.getByText('显示 1 / 2 个学科 / 课程',{exact:true}).waitFor();assert.equal(await page.locator('.learning-discipline article').count(),1);
   await search.fill('missing course');await page.getByText('没有匹配的学科或本机材料。可以调整关键词，或添加学习资料。',{exact:true}).waitFor();
   await search.fill(' ');assert.equal(await page.locator('.learning-discipline article').count(),3);
   await page.getByRole('button',{name:'切换空资料',exact:true}).click();await page.getByText('还没有正式题库；可先试学并保存本机材料。',{exact:true}).waitFor();
   await page.getByRole('button',{name:'添加学习资料',exact:true}).click();assert.equal(await page.locator('main').getAttribute('data-chosen'),'sources');
   assert.deepEqual(errors,[]);results.push({...common,case:'trimmed search, truthful counts, no results and empty library recovery',passed:true});await context.close();
  }
  {
   const {page,context,errors}=await open(viewport,theme);await expandPython(page);
   await page.evaluate(()=>{window.__auditIO.deferWrite=true;});await selector(page).selectOption('math');
   await page.waitForFunction(()=>typeof window.__auditIO.releaseWrite==='function');assert.equal(await selector(page).isDisabled(),true);
   await page.getByRole('button',{name:'切换测试学习库',exact:true}).click();await page.locator('main[data-owner="audit-b"]').waitFor();await expandPython(page);
   assert.equal(await selector(page).inputValue(),'computing');await page.evaluate(()=>window.__auditIO.releaseWrite());await settle(page);
   assert.equal(await selector(page).isDisabled(),false);assert.equal(await selector(page).inputValue(),'computing');
   await page.evaluate(()=>{window.__auditIO.failWrite=true;});await selector(page).selectOption('math');await page.getByText('分类未保存，请重试；原内容和进度未移动。',{exact:true}).waitFor();
   assert.equal(await selector(page).inputValue(),'computing');await page.evaluate(()=>{window.__auditIO.failWrite=false;});await selector(page).selectOption('math');
   await page.getByText('分类已保存；原内容和学习进度不变。',{exact:true}).waitFor();assert.equal(await page.locator('.learning-discipline').filter({has:page.getByRole('heading',{name:'数学与统计',exact:true})}).getByRole('button',{name:/Python 100天/}).count(),1);
   assert.deepEqual(errors,[]);results.push({...common,case:'in-flight save owner isolation, failure preserves grouping and retry commits',passed:true});await context.close();
  }
  {
   const {page,context,errors}=await open(viewport,theme,'?read=fail');await page.getByRole('button',{name:'重新读取分类',exact:true}).waitFor();
   await page.getByRole('button',{name:/Python 100天/}).click();assert.equal(await page.locator('main').getAttribute('data-chosen'),'python');
   await page.evaluate(()=>{window.__auditIO.failRead=false;});await page.getByRole('button',{name:'重新读取分类',exact:true}).click();await expandPython(page);
   assert.equal(await selector(page).isDisabled(),false);assert.deepEqual(errors,[]);results.push({...common,case:'read failure does not block study and has a working recovery action',passed:true});await context.close();
  }
  {
   const {page,context,errors}=await open(viewport,theme);await page.getByRole('button',{name:'打开教学',exact:true}).click();await page.locator('.site-onboarding[open]').waitFor();
   const next=page.getByRole('button',{name:'下一步',exact:true});await contrast(next,'tutorial primary',theme);await next.hover();await contrast(next,'tutorial hovered primary',theme);
   await next.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.ok(await next.evaluate(el=>el.matches(':focus-visible')&&parseFloat(getComputedStyle(el).outlineWidth)>=2));
   await next.click();await page.getByRole('heading',{name:'先认识你的知识库',exact:true}).waitFor();
   await page.screenshot({path:resolve(evidence,`tutorial-${theme}-${viewport.width}.png`)});
   await page.getByRole('button',{name:'跳过新手教学，稍后再看',exact:true}).click();await page.locator('.site-onboarding[open]').waitFor({state:'detached'});
   assert.deepEqual(errors,[]);results.push({...common,case:'real tutorial normal, hover, focus and next-step interaction',passed:true});await context.close();
  }
  {
   const {page,context,errors}=await open(viewport,theme);await page.getByRole('button',{name:'生成诊断报告',exact:true}).click();
   const input=page.getByRole('textbox',{name:'诊断报告预览',exact:true});await input.waitFor();assert.equal(await input.getAttribute('readonly'),'');
   const style=await contrast(input,'diagnostic textarea',theme);await contrast(page.getByRole('button',{name:'检查更新',exact:true}),'support control',theme);
   if(theme==='dark')assert.ok(Math.max(...style.background.slice(0,3))<100);
   await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByText('暂时无法检查更新，请稍后重试。',{exact:true}).waitFor();
   await page.screenshot({path:resolve(evidence,`support-${theme}-${viewport.width}.png`),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.deepEqual(errors,[]);results.push({...common,case:'version/help themed controls, diagnostic preview and network failure recovery',passed:true});await context.close();
  }
  {
   const {page,context,errors}=await open(viewport,theme);const area=page.locator('[data-copy-fixture]');
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined}));await area.getByRole('button',{name:'复制',exact:true}).click();
   await area.getByText('复制不可用，请选中原文手动复制。',{exact:true}).waitFor();
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('blocked','NotAllowedError');}}}));
   await area.getByRole('button',{name:'复制',exact:true}).click();await settle(page);assert.equal(await area.getByText('复制不可用，请选中原文手动复制。',{exact:true}).count(),1);
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedText=text;}}}));
   await area.getByRole('button',{name:'复制',exact:true}).click();await area.getByRole('button',{name:'已复制',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__copiedText),'print(1)\n');
   await area.getByRole('button',{name:'更新测试回答',exact:true}).click();await area.getByRole('button',{name:'复制',exact:true}).waitFor();assert.equal(await area.getByRole('button',{name:'已复制',exact:true}).count(),0);
   assert.deepEqual(errors,[]);results.push({...common,case:'real AI copy handles missing/denied APIs and never labels changed text copied',passed:true});await context.close();
  }
 }
 assert.equal(results.length,24,'Every audit scenario must execute');
}catch(error){failure=String(error.stack||error);throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected:24,passed:results.length,complete:failure===null&&results.length===24,failure,results,contrasts};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
