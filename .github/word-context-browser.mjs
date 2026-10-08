// Run with the repository's locked dependencies. No production services or learning records.
// UX_BROWSER_DRIVER points at a separate installation of Playwright; no lockfile edits.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const driver=process.env.UX_BROWSER_DRIVER;
if(!driver)throw new Error('Set UX_BROWSER_DRIVER to the directory containing a Playwright installation.');
const {chromium}=createRequire(resolve(driver,'package.json'))('playwright');
const root=resolve('scratch/ci-word-context'),evidence=resolve(process.env.UX_EVIDENCE||'scratch/ci-evidence/word-context');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(resolve(root,'entry.tsx'),"import {useMemo, useState, useEffect} from 'react';\nimport {StudyAIOfflineContext,useStudyAIContext} from '../../app/components/ai-sidebar/study-ai-workspace';\nimport '../../app/globals.css';\nimport '../../app/c-study.css';\nimport '../../app/study-guidance.css';\nimport {createRoot} from 'react-dom/client';\nimport {PluginThreeStage} from '../../app/plugins/plugin-three-stage';\nimport {StudySessionShell} from '../../app/study-session-shell';\nimport {createLearningDraftStore} from '../../app/learning-draft-store';\nimport {LearningDraftBoundary} from '../../app/learning-draft';\nimport {StudyGuidanceHelp} from '../../app/study-guidance';\nconst fixtures={\n long:{word:'datasets',example:'We trained the classifier with much larger **datasets** to reduce overfitting.'},\n short:{word:'datasets',example:'use much larger **datasets**'},\n wrapped:{word:'neural network',example:'We trained this **neural** network using examples from several independent sources.'},\n unsafe:{word:'datasets',example:'We use <img src=x onerror=\"window.__xss=1\"> **datasets** for our independent evaluation.'},\n large:{word:'datasets',example:('The surrounding text describes how evidence should be checked against original conditions. ').repeat(30)+'We use **datasets** to evaluate this particular model.'},\n math:{word:'datasets',example:'We use **datasets** across several independent evaluations with $x*y + a_b$ and `x**2`.'},\n empty:{word:'datasets',example:''},\n};\nwindow.__grades=[];window.__speech=[];window.__cancels=0;window.__queue=[];window.__reported=null;\nObject.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){window.__cancels++;window.__queue=[];},speak(value){window.__speech.push(value.text);window.__queue.push(value.text);}}});\nwindow.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};\nfunction Exercise({name,stage,mask,nonce}){\n const store=useMemo(()=>{const d=createLearningDraftStore('isolated:'+nonce);const a=d.adapter('word','stage:'+stage);a.write('clozeEnabled',mask);return d;},[nonce,stage,mask]);\n const draft=useMemo(()=>store.adapter('word','stage:'+stage),[store,stage]);\n const data={...fixtures[name],stage,meaning:'n. 数据集（本地合成测试数据）',phonetic:'',source:'合成测试资料；不是用户的原始笔记'};\n return <StudySessionShell title=\"学术英语 · 隔离验证\" scope=\"合成题目 · 本组 1 词\" mode={['认义','语境','自评'][stage-1]+' · '+stage+'/3'} progress=\"已完成 0 / 1\" onExit={()=>{}} source={<p>合成测试材料</p>} queue={<p>隔离测试，不连接学习库。</p>} subjects={<p>测试学科</p>} options={<StudyGuidanceHelp kind=\"three-stage\"/>}>\n  <LearningDraftBoundary store={store}><PluginThreeStage.renderUI data={data} context={{draft,aiItem:{id:'fixture:'+nonce,title:'隔离语境'},guidanceScope:'context-fixture',guidanceInOptions:true}} onGrade={rating=>window.__grades.push(rating)}/></LearningDraftBoundary>\n </StudySessionShell>;\n}\nfunction App(){\n const [scenario,setScenario]=useState({name:'long',stage:2,mask:true,nonce:0});\n window.__scenario=(name,stage=2,mask=true)=>{window.__grades=[];window.__speech=[];setScenario(current=>({name,stage,mask,nonce:current.nonce+1}));};\n return <main className=\"app-shell study-app study-focus\"><section className=\"workspace\"><Exercise key={scenario.nonce} {...scenario}/></section></main>;\n}\nfunction Probe(){const {context}=useStudyAIContext();useEffect(()=>{window.__reported=context;},[context]);return null;}\nconst pageContext={id:'fixture-page',title:'隔离检查'};\ncreateRoot(document.getElementById('root')).render(<StudyAIOfflineContext pageContext={pageContext}><App/><Probe/></StudyAIOfflineContext>);\n");

const origin='http://127.0.0.1:4184';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4184,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
let browser,failure=null;const results=[];
const frame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function select(page,name,stage=2,mask=true){
 await page.evaluate(([name,stage,mask])=>window.__scenario(name,stage,mask),[name,stage,mask]);await frame(page);
 const tip=page.getByRole('button',{name:'知道了',exact:true});if(await tip.isVisible())await tip.click();
}
async function options(page){await page.getByRole('button',{name:'学习选项',exact:true}).click();await page.locator('dialog[open]').waitFor();return page.locator('dialog[open]');}
async function closeOptions(page){await page.getByRole('button',{name:'关闭学习选项',exact:true}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport,colorScheme:theme==='light'?'dark':'light'});context.setDefaultTimeout(15000);
  const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();await page.goto(origin);await page.locator('[data-context-view]').waitFor();await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
  const surface=page.locator('[data-context-view]'),pass=name=>results.push({viewport,theme,case:name,passed:true});
  await select(page,'long');assert.equal(await surface.getByRole('img',{name:'待回想的词'}).count(),1);assert.equal(await surface.getByRole('button',{name:'朗读单词'}).count(),0);
  assert.doesNotMatch(await surface.innerText(),/datasets/);assert.doesNotMatch(await page.evaluate(()=>window.__reported.question),/datasets/);assert.deepEqual(await page.evaluate(()=>window.__speech),[]);
  await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});await page.keyboard.press('Space');assert.deepEqual(await page.evaluate(()=>window.__speech),[]);assert.deepEqual(await page.evaluate(()=>window.__grades),[]);pass('concealment includes visual, audio, keyboard and real AI context');
  await page.screenshot({path:resolve(evidence,`context-${theme}-${viewport.width}.png`),fullPage:true});
  let panel=await options(page);await panel.getByRole('checkbox',{name:'例句挖空',exact:true}).uncheck();await closeOptions(page);await surface.getByRole('heading',{name:'datasets',exact:true}).waitFor();
  await surface.getByRole('button',{name:'朗读单词',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__queue),['datasets']);panel=await options(page);await panel.getByRole('checkbox',{name:'例句挖空',exact:true}).check();await closeOptions(page);
  assert.deepEqual(await page.evaluate(()=>window.__queue),[]);assert.deepEqual(await page.evaluate(()=>window.__grades),[]);assert.equal(await surface.getByRole('img',{name:'待回想的词'}).count(),1);pass('live setting in existing options and speech cancellation');
  await surface.getByRole('button',{name:/核对答案/}).click();assert.equal(await surface.locator('.study-context-answer strong').innerText(),'datasets');assert.deepEqual(await page.evaluate(()=>window.__grades),[]);
  panel=await options(page);assert.equal(await panel.getByRole('checkbox',{name:'例句挖空',exact:true}).isDisabled(),true);await closeOptions(page);await surface.getByRole('button',{name:/想对了/}).click();assert.deepEqual(await page.evaluate(()=>window.__grades),['good']);pass('reveal original answer before explicit correct self-rating');
  await select(page,'long');await surface.getByRole('button',{name:/想不起来/}).click();assert.equal(await surface.getByRole('button',{name:/没想对/}).count(),0);await surface.getByRole('button',{name:/继续练习/}).waitFor();assert.deepEqual(await page.evaluate(()=>window.__grades),[]);
  await page.evaluate(()=>document.body.focus());await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>window.__grades),['again']);pass('single unknown-word continuation preserves relearning rating');
  await select(page,'short');assert.equal(await surface.locator('blockquote').innerText(),'use much larger datasets');panel=await options(page);assert.equal(await panel.getByRole('checkbox',{name:'例句挖空',exact:true}).isDisabled(),true);assert.match(await panel.innerText(),/原文片段较短/);await closeOptions(page);
  await select(page,'empty');assert.equal(await surface.locator('blockquote').count(),0);assert.match(await surface.innerText(),/当前材料没有例句，使用词义核对。/);pass('short and absent context fall back without synthesizing a sentence');
  await select(page,'wrapped');assert.equal(await surface.getByRole('img',{name:'待回想的词'}).count(),1);assert.doesNotMatch(await surface.innerText(),/neural|network/);await surface.getByRole('button',{name:/核对答案/}).click();assert.match(await surface.locator('blockquote').innerText(),/neural network/);
  await select(page,'long',1,false);assert.deepEqual(await page.evaluate(()=>window.__speech),['datasets']);await select(page,'long',2,true);assert.deepEqual(await page.evaluate(()=>window.__queue),[]);pass('multi-run target and speech-safe stage transitions');
  await select(page,'unsafe');assert.equal(await surface.locator('img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.__xss)),false);assert.match(await surface.locator('blockquote').innerText(),/<img/);
  await select(page,'math');await surface.locator('.katex').waitFor();assert.equal(await surface.locator('code').innerText(),'x**2');await select(page,'large');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));pass('inert literal HTML, real KaTeX and long examples');
  await select(page,'long');assert.ok(await surface.locator('blockquote').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)<=32));assert.ok(await surface.getByRole('button',{name:/核对答案/}).evaluate(el=>el.getBoundingClientRect().height>=44));assert.equal(await page.getByRole('button',{name:'学习选项',exact:true}).isVisible(),true);assert.deepEqual(errors,[]);pass('theme, mobile typography and accessible controls');
  await context.close();
 }
 assert.equal(results.length,32);
}catch(error){failure=String(error.stack||error);throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected:32,passed:results.length,complete:!failure&&results.length===32,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
