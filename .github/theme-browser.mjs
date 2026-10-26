import {existsSync,statSync} from 'node:fs';
// Theme regression: real library, focused paper route and optional legacy draft tools.
// Synthetic browser-only stores; no production login, API or learning records.
import assert from 'node:assert/strict';
import {mkdir, writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium} = createRequire(resolve(process.env.UX_BROWSER_DRIVER, 'package.json'))('playwright');
const project=process.cwd().replaceAll('\\','/');
const root=await mkdtemp(resolve(tmpdir(),'zhixue-theme-browser-'));
const evidence=resolve(process.env.UX_EVIDENCE||resolve(root,'evidence'));
/** Generated fixtures live outside the repository; retain exact source extensions. */
function fixtureSource(text){
 return text.replace(/(['"])\.\.\/\.\.\/([^'"]+)\1/g,(_match,quote,specifier)=>{
  const base=resolve(project,specifier),candidates=[base,...['.ts','.tsx','.mjs','.js','.json','.css'].map(extension=>base+extension),...['index.ts','index.tsx','index.mjs','index.js'].map(name=>resolve(base,name))];
  const file=candidates.find(path=>existsSync(path)&&statSync(path).isFile());
  if(!file)throw Error('Browser fixture source unavailable: '+specifier);
  return quote+'/@fs/'+file.replaceAll('\\','/')+quote;
 });
}
await mkdir(root, {recursive:true}); await mkdir(evidence, {recursive:true});
await writeFile(resolve(root,'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(resolve(root,'entry.tsx'), fixtureSource(`
import React,{useLayoutEffect,useSyncExternalStore,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LearningLibrary} from '../../app/learning-library';
import {PaperWorkshopLauncher} from '../../app/paper-workshop-launcher';
import {PaperReadingEntry} from '../../app/paper-reading/entry';
import {PaperWorkshop} from '../../app/plugins/plugin-paper';
import {DEMO_PAPER_ALEXNET} from '../../app/paper-study';
import {paperFingerprint} from '../../app/paper-draft-store';
import {savePreparedPaperTask} from '../../app/paper-reading/prepared';
import {paperReadingUnit} from '../../src/domain/paper-reading';
import {studyHash} from '../../src/domain/sync';
import {studyThemePreference,serverStudyTheme} from '../../app/study-theme';
import '../../app/globals.css';import '../../app/c-study.css';
import '../../app/study-overview.css';import '../../app/study-interactions.css';
const services={owner:'theme-regression-synthetic',library:'theme-regression-library'};
// The actual preparation service stores a source-bound question, without a model or grades.
const paper=DEMO_PAPER_ALEXNET,fingerprint=await paperFingerprint(paper);
const paragraph=paper.sections[0].paragraphs[0];
const source={ownerId:services.owner,libraryId:services.library,materialFingerprint:fingerprint,
 sourceVersion:fingerprint,sectionId:paper.sections[0].id,
 paragraphs:[{id:paragraph.id,rawEn:paragraph.rawEn,pageNumber:paragraph.pageNumber}]};
const goal='解释当前原文的关键概念、方法或机制';
const unit=paperReadingUnit({schemaVersion:1,unitId:'paper-unit:'+await studyHash({source,goal,title:paper.title}),title:paper.title,goal,source});
await savePreparedPaperTask({ownerId:services.owner,libraryId:services.library},unit,{schemaVersion:1,documentType:'paper-reading-prepared-question',
 materialFingerprint:fingerprint,sourceVersion:fingerprint,sectionId:source.sectionId,paragraphIds:[paragraph.id],
 question:'原文中的 f 和 x 分别表示神经元的什么量？',ability:'definition',
 reference:[{point:'f 表示神经元输出，x 表示输入。',paragraphId:paragraph.id,quote:paragraph.rawEn}]});
const subjects=[
 {id:'speaking',name:'IELTS Speaking · 口语复习',pluginType:'three-stage',disciplineId:'language',items:[{}]},
 {id:'vocab',name:'学术英语词库',pluginType:'three-stage',disciplineId:'language',items:[{},{}]},
 {id:'vision',name:'CS231n · 课程复习',pluginType:'recall',disciplineId:'computing',items:[{}]},
 {id:'python',name:'Python 100天 · 代码练习',pluginType:'code',disciplineId:'computing',items:[{}]}
];
function App(){
 const theme=useSyncExternalStore(studyThemePreference.subscribe,studyThemePreference.getSnapshot,serverStudyTheme);
 const [chosen,setChosen]=useState('');
 useLayoutEffect(()=>{document.documentElement.classList.toggle('dark',theme==='dark');},[theme]);
 return <main className="study-app" data-page="today" data-theme={theme} data-chosen={chosen}>
  <div className="workspace">
   <header style={{display:'flex',gap:20,justifyContent:'space-between',alignItems:'center',marginBottom:32}}>
    <div><h1 style={{fontSize:32,fontWeight:700}}>知学</h1><p style={{color:'var(--muted)'}}>学科页面 · 隔离主题验证</p></div>
    <button className="study-secondary-action" onClick={()=>studyThemePreference.set(theme==='dark'?'light':'dark')}>{theme==='dark'?'使用浅色模式':'使用深色模式'}</button>
   </header>
   {location.pathname==='/study/paper'?<PaperReadingEntry services={services} initialPaper={paper} returnHref="/"
    renderTools={current=><><PaperWorkshop services={services} initialPaper={current} restoreLast={false} showMaterialManager={false}/>
     <PaperWorkshopLauncher services={services} legacyDialog/></>}/>:<section className="study-library"><header><h2>按学科学习</h2><span>继续今日任务，或进入学科选择自由练习</span></header>
    <LearningLibrary subjects={subjects} owner={services.owner} library={services.library} onChoose={setChosen} onSources={()=>setChosen('sources')} paper={<PaperWorkshopLauncher services={services}/>}/>
   </section>}
  </div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
`));
const origin='http://127.0.0.1:4177';
const server=await createServer({configFile:false,root,publicDir:false,css:{postcss:project},cacheDir:resolve(root,'.vite'),resolve:{alias:{react:resolve(project,'node_modules/react'),'react-dom':resolve(project,'node_modules/react-dom')}},plugins:[react()],server:{host:'127.0.0.1',port:4177,strictPort:true,fs:{allow:[project,root]}},logLevel:'error'});
let browser, failure=null;
const results=[], contrasts=[];
// Use resolved CSS colours, including foreground alpha and ancestor opacity.
// No screenshots/OCR or source-code colour assertions stand in for computed contrast.
function inspectContrast(element, pseudo) {
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;return [r,g,b,a/255];};
 const over=(f,b)=>{const a=f[3]+b[3]*(1-f[3]);return a?[0,1,2].map(i=>(f[i]*f[3]+b[i]*b[3]*(1-f[3]))/a).concat(a):[0,0,0,0];};
 const style=getComputedStyle(element,pseudo||null);
 let fg=rgba(style.color),bg=[0,0,0,0];
 if(pseudo)fg[3]*=Number(style.opacity);
 for(let el=element;el;el=el.parentElement){const s=getComputedStyle(el),back=rgba(s.backgroundColor);fg=over(fg,back);bg=over(bg,back);fg[3]*=Number(s.opacity);bg[3]*=Number(s.opacity);}
 fg=over(fg,[255,255,255,1]);bg=over(bg,[255,255,255,1]);
 const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const l1=lum(fg),l2=lum(bg);
 return {ratio:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05),foreground:fg.slice(0,3),background:bg.slice(0,3),cssBackground:getComputedStyle(element).backgroundColor,colorScheme:style.colorScheme};
}
async function check(locator,label,theme,pseudo=null){
 assert.equal(await locator.isVisible(),true,label+' must be visible');
 const metric=await locator.evaluate(inspectContrast,pseudo);contrasts.push({theme,label,...metric});
 assert.ok(metric.ratio>=4.5,label+' has insufficient text contrast: '+metric.ratio);
 return metric;
}
async function surface(locator,label,theme){
 const metric=await check(locator,label,theme);
 assert.equal(metric.colorScheme,theme,label+' native colour scheme follows selected theme');
 if(theme==='dark')assert.ok(Math.max(...metric.background)<100,label+' must not fall back to a white surface');
}
async function focus(locator){
 await locator.focus();
 const css=await locator.evaluate(el=>{const s=getComputedStyle(el);return {visible:el.matches(':focus-visible'),width:parseFloat(s.outlineWidth),style:s.outlineStyle};});
 assert.ok(css.visible&&css.width>=2&&css.style!=='none','Keyboard focus must stay visible');
}
async function waitTheme(page,theme){
 await page.locator('[data-theme="'+theme+'"]').waitFor();
 await page.waitForFunction(t=>document.documentElement.classList.contains('dark')===(t==='dark'),theme);
 // Wait for the existing body colour transition before measuring composited colours.
 await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
}
try {
 await server.listen();browser=await chromium.launch({headless:true,...(process.env.EDU_CHROMIUM_PATH?{executablePath:process.env.EDU_CHROMIUM_PATH}:{})});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['dark','light']){
  const opposite=theme==='dark'?'light':'dark';
  const context=await browser.newContext({viewport,colorScheme:opposite});context.setDefaultTimeout(20000);
  const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin!==origin||url.pathname.startsWith('/api/')?route.abort('blockedbyclient'):route.continue();});
  // Seed only once on the fixture origin. Reloads must read the real saved preference.
  await context.addInitScript(({origin,theme})=>{if(location.origin!==origin)return;if(!localStorage.getItem('theme-fixture-seeded')){localStorage.setItem('zhixue:appearance:theme:v1',theme);localStorage.setItem('theme-fixture-seeded','1');}},{origin,theme});
  const page=await context.newPage();await page.goto(origin);await waitTheme(page,theme);
  const search=page.getByRole('searchbox'),first=page.locator('.learning-subject-open').first();
  assert.equal(await page.locator('.learning-discipline article').count(),4);
  await surface(first.locator('strong'),'subject title',theme);
  await check(first.locator('span'),'subject metadata',theme);
  await check(page.locator('.learning-discipline header p').first(),'discipline description',theme);
  await surface(search,'search input',theme);await check(search,'search placeholder',theme,'::placeholder');
  await surface(page.locator('.paper-launch'),'paper launcher',theme);await surface(page.getByRole('button',{name:'添加资料',exact:true}),'add sources',theme);
  await focus(search);await search.fill('Python');assert.equal(await page.locator('.learning-discipline article').count(),1);await search.fill('');
  await first.hover();await check(first.locator('strong'),'hover title',theme);await check(first.locator('span'),'hover metadata',theme);
  const summary=page.locator('.learning-discipline summary').first();await summary.click();
  const select=page.locator('.learning-discipline select').first();await page.waitForFunction(()=>!document.querySelector('.learning-discipline select').disabled);
  await surface(select,'discipline select',theme);await focus(select);await check(summary,'classification summary',theme);await summary.click();
  await first.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('main').getAttribute('data-chosen'),'speaking');
  await page.mouse.move(0,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:resolve(evidence,`library-${theme}-${viewport.width}.png`),fullPage:true});
  results.push({viewport:viewport.width,theme,case:'library, search, placeholder, hover, focus and native select',passed:true});
  assert.equal(await page.locator('.paper-launch').getAttribute('href'),'/study/paper');
  await page.locator('.paper-launch').click();await page.waitForURL(origin+'/study/paper');await waitTheme(page,theme);
  const focused=page.getByRole('region',{name:'论文专注阅读',exact:true});await focused.waitFor();
  assert.equal(await page.locator('.paper-dialog[open]').count(),0,'Default paper entry is a focused route');
  await focused.getByRole('button',{name:'开始学习',exact:true}).click();
  const answer=focused.getByRole('textbox',{name:'你的回答',exact:true});await answer.waitFor();
  await surface(answer,'paper answer field',theme);await check(answer,'paper answer placeholder',theme,'::placeholder');await focus(answer);
  await surface(focused.getByRole('combobox',{name:'阅读范围',exact:true}),'reading range select',theme);
  await check(focused.getByRole('article',{name:'当前单元原文',exact:true}),'original paragraph',theme);
  await focused.getByText('更换论文或上传原文',{exact:true}).click();
  await focused.getByRole('button',{name:'选择论文 / 上传文件',exact:true}).click();
  await surface(focused.locator('.paper-file-upload input'),'file input',theme);await check(focused.locator('.paper-file-upload input'),'native file button',theme,'::file-selector-button');
  await focused.getByRole('button',{name:'收起资料选择',exact:true}).click();await focused.getByText('更换论文或上传原文',{exact:true}).click();
  await answer.fill('主题切换回归：这是隔离阅读答案，不是正式学习记录。');await focused.getByText('已保存本机',{exact:true}).waitFor();
  await focused.getByText('更多工具',{exact:true}).click();
  const legacy=focused.locator('.paper-workshop');
  await legacy.locator('.paper-reading textarea').waitFor();
  await surface(legacy.locator('.paper-note-destination select'),'note destination',theme);await surface(legacy.locator('.paper-note-destination input'),'note directory',theme);
  await check(legacy.locator('.paper-tray h2 span'),'vocabulary count badge',theme);
  const word=legacy.locator('.paper-raw button').first();await word.hover();await check(word,'paper word hover',theme);
  const draft=legacy.locator('.paper-reading textarea');await surface(draft,'legacy draft field',theme);await check(draft,'legacy draft placeholder',theme,'::placeholder');await focus(draft);
  await draft.fill('主题切换回归：这是隔离草稿，不是正式学习记录。');await legacy.getByText('草稿已就绪',{exact:true}).waitFor();
  // Optional legacy modal remains covered, but is never the default paper entry.
  await focused.getByRole('button',{name:'论文精读工坊',exact:true}).click();await page.locator('.paper-dialog[open]').waitFor();
  await surface(page.locator('.paper-close'),'portaled close control',theme);
  await page.getByText('更换论文 / 上传材料',{exact:true}).click();await surface(page.locator('.paper-import button').first(),'paper import button',theme);
  await page.locator('.paper-close').click();await page.locator('.paper-dialog[open]').waitFor({state:'detached'});
  await page.mouse.move(0,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Focused reading must fit the viewport');
  await page.screenshot({path:resolve(evidence,`paper-${theme}-${viewport.width}.png`)});
  await focused.getByRole('link',{name:'返回学习',exact:true}).click();await page.waitForURL(origin+'/');await waitTheme(page,theme);
  results.push({viewport:viewport.width,theme,case:'focused paper route, optional legacy tools, native controls and hovered word contrast',passed:true});
  // Switch through the same preference store used by the app, then reload.
  await page.getByRole('button',{name:opposite==='dark'?'使用深色模式':'使用浅色模式',exact:true}).click();await waitTheme(page,opposite);
  await surface(first.locator('strong'),'switched title',opposite);await surface(search,'switched input',opposite);await surface(page.locator('.paper-launch'),'switched launcher',opposite);
  await page.reload();await waitTheme(page,opposite);await surface(page.locator('.learning-subject-open strong').first(),'persisted title',opposite);
  await page.locator('.paper-launch').click();await page.waitForURL(origin+'/study/paper');await waitTheme(page,opposite);
  const reopened=page.getByRole('region',{name:'论文专注阅读',exact:true});
  const savedAnswer=reopened.getByRole('textbox',{name:'你的回答',exact:true});await savedAnswer.waitFor();
  assert.equal(await savedAnswer.inputValue(),'主题切换回归：这是隔离阅读答案，不是正式学习记录。');
  await surface(savedAnswer,'reopened saved reading answer',opposite);
  await reopened.getByText('更多工具',{exact:true}).click();
  const savedDraft=reopened.locator('.paper-workshop .paper-reading textarea');await savedDraft.waitFor();
  assert.equal(await savedDraft.inputValue(),'主题切换回归：这是隔离草稿，不是正式学习记录。');
  await surface(savedDraft,'reopened saved draft',opposite);
  assert.deepEqual(errors,[]);results.push({viewport:viewport.width,theme,case:'manual preference overrides OS, survives reload and keeps draft',passed:true});
  await context.close();
 }
 assert.equal(results.length,12,'All theme scenarios must execute');
} catch(error){failure=String(error.stack||error);throw error;}
finally {
 const report={sha:process.env.GITHUB_SHA||null,expected:12,passed:results.length,complete:failure===null&&results.length===12,failure,results,contrasts};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await browser?.close();await server.close();
}
