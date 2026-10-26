// Public, persistent regressions for F01-F07 / A01-A03. No production connection.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=resolve(process.env.UX_EVIDENCE||join(tmpdir(),'zhixue-reliability-evidence'));
// Fixed CI contract: twelve cases in eight environments. Changing either table
// requires deliberately updating the reporter's expected count alongside this file.
const EXPECTED=96;
const environments=[
 {id:'320-light',width:320,height:700,theme:'light',layout:'auto'},
 {id:'390-dark',width:390,height:844,theme:'dark',layout:'auto'},
 {id:'768-light',width:768,height:900,theme:'light',layout:'auto'},
 {id:'1280-dark',width:1280,height:900,theme:'dark',layout:'auto'},
 {id:'390-low-light',width:390,height:420,theme:'light',layout:'auto'},
 {id:'390-content200-dark',width:390,height:844,theme:'dark',layout:'auto',zoom:2},
 {id:'390-manual-desktop-light',width:390,height:844,theme:'light',layout:'desktop'},
 {id:'1280-manual-mobile-dark',width:1280,height:900,theme:'dark',layout:'mobile'},
];
const cases=[
 ['F01-save-recovery',paperRecovery],['F01-lost-receipt',paperLostReceipt],['F01-version-conflict',paperConflict],
 ['F02-frozen-first-rating',quizRatings],['A01-result-focus',structuredFocus],['A02-tutor-error-retry',tutorRetry],
 ['A03-paper-source-tabs',paperTabs],['F03-pairing-busy',pairBusy],['F04-connection-entry',connectionEntry],
 ['F05-ai-settings-entry',aiEntry],['F06-source-scan-feedback',scanFeedback],['F07-ai-independent-read',aiRead],
];
assert.equal(cases.length*environments.length,EXPECTED,'Expected-count contract drift');
// Local diagnosis may rerun explicit failing pairs. It can never produce a
// complete CI manifest; the default matrix and fixed expected count stay intact.
const diagnosticPairs=process.env.UX_RELIABILITY_DIAGNOSTIC_PAIRS?new Set(JSON.parse(process.env.UX_RELIABILITY_DIAGNOSTIC_PAIRS)):null;
if(diagnosticPairs){
 assert.notEqual(process.env.CI,'true','Subset diagnosis is unavailable in CI');
 const known=new Set(environments.flatMap(env=>cases.map(([name])=>env.id+'/'+name)));
 assert.ok(diagnosticPairs.size>0&&[...diagnosticPairs].every(pair=>known.has(pair)),'Unknown diagnostic environment/case pair');
}
await mkdir(evidence,{recursive:true});
let root,server,browser,origin,failure=null,browserVersion=null;
const results=[],failures=[];
const frames=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
async function reachable(locator){
 await locator.waitFor({state:'visible'});
 await locator.scrollIntoViewIfNeeded();
 const geometry=await locator.evaluate(element=>{
  const r=element.getBoundingClientRect(),desktop=document.documentElement.dataset.studyLayout==='desktop';
  const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
  const x=desktop?(left+right)/2:(r.left+r.right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);
  return {desktop,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visibleWidth:right-left,visibleHeight:bottom-top,position:{x:x-r.left,y:y-r.top},viewport:innerWidth,viewportHeight:innerHeight,uncovered:Boolean(hit&&(hit===element||element.contains(hit)))};
 });
 assert.ok(geometry.width>0&&geometry.height>0,'Control has no physical hit area');
 if(geometry.desktop)assert.ok(geometry.visibleWidth>=Math.min(44,geometry.width),'Desktop control has no usable visible hit area: '+JSON.stringify(geometry));
 else assert.ok(geometry.left>=-1&&geometry.right<=geometry.viewport+1,'Control is horizontally clipped: '+JSON.stringify(geometry));
 assert.ok(geometry.top>=-1&&geometry.bottom<=geometry.viewportHeight+1,'Control cannot be scrolled into the viewport: '+JSON.stringify(geometry));
 assert.equal(geometry.uncovered,true,'Another element covers the control center');
 return geometry;
}
async function click(locator){const geometry=await reachable(locator);await locator.click(geometry.desktop?{position:geometry.position}:{});}
async function noOverflow(page){
 const value=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,viewport:innerWidth,layout:document.documentElement.dataset.studyLayout,bodyMinWidth:parseFloat(getComputedStyle(document.body).minWidth),contentWidth:document.querySelector('.study-app').getBoundingClientRect().width,overflow:getComputedStyle(document.scrollingElement).overflowX,scrollX}));
 if(value.layout==='desktop'&&value.viewport<1100){
  assert.equal(value.bodyMinWidth,1100,'Explicit desktop layout lost its declared minimum width');
  assert.ok(value.actual>=1100&&value.contentWidth>=1100,'Desktop layout did not retain desktop content width: '+JSON.stringify(value));
  assert.ok(!['hidden','clip'].includes(value.overflow),'Desktop horizontal scrolling is disabled');
  await page.mouse.move(value.viewport/2,5);await page.mouse.wheel(value.scrollX>0?-240:240,0);
  await page.waitForFunction(previous=>window.scrollX!==previous,value.scrollX);
 }else assert.ok(value.actual<=value.viewport+1,'Unexpected horizontal page overflow: '+JSON.stringify(value));
}
async function focused(locator){assert.equal(await locator.evaluate(element=>document.activeElement===element),true,'Expected actual DOM focus');}
async function visit(t,mode,extra={}){
 const query=new URLSearchParams({mode,theme:t.env.theme,zoom:String(t.env.zoom||1),...extra});
 await t.page.goto(origin+'/?'+query);
 await t.page.waitForFunction(()=>window.__reliability?.ready||window.__reliability?.setupError);
 assert.equal(await t.page.evaluate(()=>window.__reliability.setupError||null),null,'Synthetic setup failed');
 const layout=t.page.getByRole('combobox',{name:'选择网站布局',exact:true});
 await layout.selectOption(t.env.layout);
 await t.page.waitForFunction(layout=>document.documentElement.dataset.studyLayout===layout,t.env.layout);
 if(t.env.zoom===2){
  const scale=await layout.evaluate(async element=>{
   const root=document.getElementById('product-root');root.style.zoom='1';await new Promise(done=>requestAnimationFrame(done));const normal=element.getBoundingClientRect().height;
   root.style.zoom='2';await new Promise(done=>requestAnimationFrame(done));return {normal,enlarged:element.getBoundingClientRect().height,effectiveWidth:innerWidth/2};
  });
  assert.ok(scale.normal>0&&Math.abs(scale.enlarged/scale.normal-2)<.05,'CSS content zoom did not double a real product control: '+JSON.stringify(scale));
  assert.equal(scale.effectiveWidth,t.env.width/2);
  t.zoom=scale;
 }
 await frames(t.page);
}
const io=(page,read)=>page.evaluate(read);
async function paperRecovery(t){
 await visit(t,'paper-save');const p=t.page;
 await click(p.getByRole('button',{name:'查看关键要点',exact:true}));
 const retry=p.getByRole('button',{name:'重试保存',exact:true});await retry.waitFor();
 assert.equal(await p.getByRole('button',{name:'继续',exact:true}).isDisabled(),true);
 assert.equal(await p.getByRole('textbox',{name:'已保存的提交回答',exact:true}).inputValue(),'Original answer');
 await click(retry);await p.getByRole('heading',{name:'参考要点',exact:true}).waitFor();
 const writes=await io(p,()=>window.__reliability.paperWrites.filter(m=>m.kind==='reference'));
 assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
 assert.equal(await io(p,()=>window.__reliability.paperSnapshot().workspace.operations.filter(m=>m.kind==='reference').length),1);
 await click(p.getByRole('button',{name:'继续',exact:true}));assert.equal(await io(p,()=>window.__reliability.continued),1);
}
async function paperLostReceipt(t){
 await visit(t,'paper-lost');const p=t.page;
 await click(p.getByRole('button',{name:'查看关键要点',exact:true}));await p.getByRole('button',{name:'重试保存',exact:true}).waitFor();
 await click(p.getByRole('button',{name:'重试保存',exact:true}));await p.getByRole('heading',{name:'参考要点',exact:true}).waitFor();
 assert.deepEqual(await io(p,()=>window.__reliability.paperReceipts),['accepted','duplicate']);
 const writes=await io(p,()=>window.__reliability.paperWrites.filter(m=>m.kind==='reference'));assert.deepEqual(writes[0],writes[1]);
 assert.equal(await io(p,()=>window.__reliability.paperSnapshot().workspace.operations.filter(m=>m.kind==='reference').length),1);
 assert.equal(await p.getByRole('textbox',{name:'已保存的提交回答',exact:true}).inputValue(),'Original answer');
}
async function paperConflict(t){
 await visit(t,'paper-conflict');const p=t.page;
 await p.getByRole('button',{name:'重试保存',exact:true}).waitFor();
 assert.equal(await p.getByRole('textbox',{name:'你的回答',exact:true}).inputValue(),'Local unsubmitted text');
 await p.evaluate(()=>window.__reliability.externalPaperChange());
 await click(p.getByRole('button',{name:'重试保存',exact:true}));await p.getByRole('button',{name:'重新读取已保存内容',exact:true}).waitFor();
 const writes=await io(p,()=>window.__reliability.paperWrites.filter(m=>m.kind==='draft'&&m.answer==='Local unsubmitted text'));assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
 await click(p.getByRole('button',{name:'重新读取已保存内容',exact:true}));
 await p.getByRole('button',{name:'保留本页输入，使用已保存回答',exact:true}).waitFor();
 assert.equal(await p.getByRole('textbox',{name:'已保存的提交回答',exact:true}).inputValue(),'External submitted answer');
 assert.equal(await p.getByRole('textbox',{name:'本页未保存输入',exact:true}).inputValue(),'Local unsubmitted text');
 assert.equal(await p.getByRole('button',{name:'继续',exact:true}).isDisabled(),true);
 await click(p.getByRole('button',{name:'保留本页输入，使用已保存回答',exact:true}));
 await p.waitForFunction(()=>window.__reliability.paperSnapshot().saveRecovery===null&&!window.__reliability.paperSnapshot().saving);
 assert.equal(await p.getByRole('textbox',{name:'已保存的提交回答',exact:true}).inputValue(),'External submitted answer');
 assert.equal(await p.getByRole('textbox',{name:'本页未保存输入',exact:true}).inputValue(),'Local unsubmitted text');
 assert.equal(await io(p,()=>window.__reliability.paperSnapshot().workspace.referenceSeen),false);
 assert.equal(await io(p,()=>window.__reliability.paperSnapshot().workspace.operations.filter(m=>m.kind==='reference').length),0);
 await click(p.getByRole('button',{name:'继续',exact:true}));assert.equal(await io(p,()=>window.__reliability.continued),1);
}
async function quizRatings(t){
 for(const [choices,rating] of [[['Claim A','Claim B'],'good'],[['Claim A'],'hard'],[['Claim A','Wrong claim'],'again']]){
  for(const remediation of [false,true]){
   await visit(t,'nonword');const p=t.page;
   for(const name of choices)await click(p.getByRole('button',{name,exact:true}));
   await click(p.getByRole('button',{name:'提交答案',exact:true}));await p.locator('.nonword-feedback').waitFor();
   assert.equal(await io(p,()=>window.__reliability.assessed[0].rating),rating);
   const original=await io(p,()=>window.__reliability.quizSnapshot().first);
   if(remediation&&rating!=='good'){
    await click(p.getByRole('button',{name:'收起解释，再试一次',exact:true}));
    for(const name of ['Claim A','Claim B'])await click(p.getByRole('button',{name,exact:true}));
    await click(p.getByRole('button',{name:'核对这次补练',exact:true}));await p.locator('.nonword-feedback').waitFor();
    assert.equal(await io(p,()=>window.__reliability.remediated[0].rating),'good');assert.deepEqual(await io(p,()=>window.__reliability.quizSnapshot().first),original);
   }
   await click(p.getByRole('button',{name:rating==='good'?'继续':'跳过补练或结束补练，继续',exact:true}));
   assert.deepEqual(await io(p,()=>window.__reliability.grades),[rating]);
  }
 }
}
async function structuredFocus(t){
 for(const [choices,label,rating] of [[['a Claim A','b Claim B'],'回答正确','good'],[['a Claim A'],'部分正确','hard'],[['c Wrong claim'],'这次需要复习','again']]){
  await visit(t,'structured');const p=t.page;
  for(const name of choices)await click(p.getByRole('button',{name,exact:true}));
  await click(p.getByRole('button',{name:'提交答案',exact:true}));
  const title=p.getByRole('heading',{name:label,exact:true});await title.waitFor();await focused(title);
  assert.equal(await title.getAttribute('tabindex'),'-1');
  await p.getByRole('status').filter({hasText:`已提交：${label}。`}).waitFor();
  const next=p.getByRole('button',{name:rating==='good'?'继续':'记为需复习并继续',exact:true});
  // Traverse the real DOM order, including optional source review actions.
  let reached=false;for(let i=0;i<12;i++){await p.keyboard.press('Tab');if(await next.evaluate(el=>document.activeElement===el)){reached=true;break;}}
  assert.equal(reached,true,'Continue is missing from the natural keyboard sequence');
  const tutor=p.getByRole('textbox',{name:'向 AI 导师追问',exact:true});await tutor.fill('A later question');await frames(p);await focused(tutor);
  await click(next);assert.deepEqual(await io(p,()=>window.__reliability.grades),[rating]);
 }
}
async function tutorRetry(t){
 await visit(t,'tutor');const p=t.page,input=p.getByRole('textbox',{name:'向 AI 导师追问',exact:true}),region=p.locator('.study-tutor [role=status]');
 assert.equal(await region.count(),1);const regionId=await region.getAttribute('id');
 await input.fill('Why is A incomplete?');await input.dispatchEvent('compositionstart');await input.dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});await input.dispatchEvent('compositionend');assert.equal(await io(p,()=>window.__reliability.tutorRequests.length),0);
 await input.press('Enter');await p.waitForFunction(()=>window.__reliability.tutorRequests.length===1);
 await p.evaluate(()=>window.__reliability.tutorRequests[0].reject(Error('Synthetic failure')));await region.getByText('Synthetic failure',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),'Why is A incomplete?');assert.equal(await input.getAttribute('aria-describedby'),regionId);
 await click(p.getByRole('button',{name:'提问',exact:true}));await p.waitForFunction(()=>window.__reliability.tutorRequests.length===2);
 assert.equal(await region.textContent(),'');assert.equal(await region.getAttribute('id'),regionId);assert.equal(await input.inputValue(),'Why is A incomplete?');
 await input.fill('A newer question');await p.evaluate(()=>window.__reliability.tutorRequests[1].resolve('A omits B'));
 await p.getByText('A omits B',{exact:true}).waitFor();assert.equal(await input.inputValue(),'A newer question');await focused(input);
 assert.equal(await region.textContent(),'');
}
async function paperTabs(t){
 await visit(t,'paper-sources');const p=t.page;
 await click(p.getByRole('button',{name:'选择论文 / 上传文件',exact:true}));
 const tabs=p.getByRole('tab'),names=['上传文件','Obsidian / 本机','Notion'];
 await tabs.nth(0).focus();
 for(const [key,index] of [['ArrowRight',1],['End',2],['ArrowRight',0],['ArrowLeft',2],['Home',0]]){
  await p.keyboard.press(key);const selected=tabs.nth(index);await focused(selected);assert.equal(await selected.getAttribute('aria-selected'),'true');
  assert.equal(await p.locator('[role=tab][tabindex="0"]').count(),1);
  const panel=p.getByRole('tabpanel');assert.equal(await panel.getAttribute('id'),await selected.getAttribute('aria-controls'));assert.equal(await panel.getAttribute('aria-labelledby'),await selected.getAttribute('id'));await reachable(selected);
 }
 await click(p.getByRole('tab',{name:names[1],exact:true}));await click(p.getByRole('tab',{name:names[2],exact:true}));
 await p.evaluate(()=>{const requests=window.__reliability.catalogRequests;requests.at(-2).reject(Error('obsolete catalog error'));requests.at(-1).resolve({localLibraryId:'synthetic-library',accountLibraryId:null,documents:[],destinations:[],limited:false});});
 await p.getByText('尚无已连接的 Notion 页面，请在资料连接中添加并授权具体页面。',{exact:true}).waitFor();
 assert.equal(await p.getByText('obsolete catalog error',{exact:true}).count(),0);await focused(p.getByRole('tab',{name:'Notion',exact:true}));
}
async function pairBusy(t){
 await visit(t,'pair');const p=t.page;
 await click(p.getByRole('button',{name:'立即配对',exact:true}));await p.locator('#companion-pairing[aria-busy=true]').waitFor();
 assert.equal(await p.getByRole('textbox',{name:'当前窗口的配对码',exact:true}).isDisabled(),true);
 for(const name of ['正在配对…','检测连接','启动已安装 Companion'])assert.equal(await p.getByRole('button',{name,exact:true}).isDisabled(),true);
 assert.equal(await io(p,()=>window.__reliability.pairCalls),1);
 await p.evaluate(()=>window.__reliability.pairRequest.resolve());await p.getByText('Synthetic pairing accepted',{exact:true}).waitFor();
 await p.evaluate(()=>window.__reliability.setPairing(true));await p.locator('#companion-pairing[aria-busy=true]').waitFor();
 assert.equal(await p.getByRole('button',{name:'立即同步资料',exact:true}).isDisabled(),true);
 await p.evaluate(()=>window.__reliability.setPairing(false));await reachable(p.getByRole('button',{name:'立即同步资料',exact:true}));
}
async function connectionEntry(t){
 for(const name of ['前往连接设备 →','先安装并配对 →','前往连接设备']){
  await visit(t,'sources');const p=t.page;
  await click(p.getByRole('button',{name,exact:true}));await p.getByRole('heading',{name:'连接与设备',exact:true}).waitFor();
  const target=p.locator('#companion-pairing');await focused(target);await reachable(p.getByRole('button',{name:'立即配对',exact:true}));
  assert.equal(await io(p,()=>window.__reliability.sourceSnapshot().sourceView),'connections');
  assert.equal(await p.getByRole('heading',{name:'资料来源与映射',exact:true}).count(),0);
 }
}
async function aiEntry(t){
 await visit(t,'sources',{section:'connections'});const p=t.page;
 await click(p.getByRole('button').filter({has:p.getByRole('heading',{name:'本机 AI',exact:true})}));await p.getByRole('dialog',{name:'受控 AI 设置面板',exact:true}).waitFor();
 await p.keyboard.press('Escape');await p.getByRole('dialog').waitFor({state:'detached'});
 await click(p.getByRole('button',{name:/^AI 与密钥/}));await p.getByRole('heading',{name:'AI 模型与密钥',exact:true}).waitFor();
 await click(p.getByRole('button',{name:'打开 AI 与 API Key 设置',exact:true}));await p.getByRole('dialog',{name:'受控 AI 设置面板',exact:true}).waitFor();
 assert.equal(await io(p,()=>window.__reliability.aiOpenCalls),2);assert.equal(await io(p,()=>window.__reliability.modelCalls),0);
 await click(p.getByRole('button',{name:'关闭设置',exact:true}));await p.getByRole('dialog').waitFor({state:'detached'});
}
async function scanFeedback(t){
 await visit(t,'sources');const p=t.page,scan=p.getByRole('button',{name:'立即扫描',exact:true});
 assert.equal(await scan.isDisabled(),true);await p.getByRole('status').filter({hasText:'连接本地资料助手后可扫描资料变更'}).waitFor();
 await p.evaluate(()=>window.__reliability.setConnected(true));await p.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='立即扫描')?.disabled);
 await click(scan);await p.getByRole('button',{name:'扫描中…',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'扫描中…',exact:true}).isDisabled(),true);
 await p.evaluate(()=>window.__reliability.scanRequests.at(-1).reject(Error('Synthetic permission failure')));await p.getByRole('status').filter({hasText:'Synthetic permission failure'}).waitFor();
 await click(scan);await p.waitForFunction(()=>window.__reliability.scanRequests.length===2);await p.evaluate(()=>window.__reliability.scanRequests.at(-1).resolve({changes:[],scannedAt:'2026-10-26T09:00:00Z'}));
 await p.getByRole('status').filter({hasText:'扫描完成，未发现需要确认的资料变更。'}).waitFor();
 await click(scan);await p.waitForFunction(()=>window.__reliability.scanRequests.length===3);await p.evaluate(()=>window.__reliability.scanRequests.at(-1).resolve({changes:[{changeId:'synthetic-change',kind:'added',path:'synthetic-course.md',contentHash:'a'.repeat(64)}],scannedAt:'2026-10-26T09:01:00Z'}));
 await p.getByRole('status').filter({hasText:'发现 1 项资料变更'}).waitFor();await p.getByText('synthetic-course.md',{exact:true}).waitFor();
 assert.equal(await io(p,()=>window.__reliability.sourceSnapshot().sourceView),'sources');await reachable(p.getByRole('button',{name:'批准',exact:true}));
}
async function aiRead(t){
 await visit(t,'sources',{section:'connections',account:'1'});const p=t.page;
 const overview=p.getByRole('button').filter({has:p.getByRole('heading',{name:'账号 AI',exact:true})});
 await p.waitForFunction(()=>window.__reliability.aiReads.length===1);await overview.getByText('已启用',{exact:true}).waitFor();
 assert.equal(await io(p,()=>window.__reliability.restoreExports),0);
 for(const [kind,label] of [['disabled','未启用'],['unconfigured','待配置'],['failed','暂无法核对']]){
  await p.evaluate(kind=>{window.__reliability.aiKind=kind;},kind);
  await click(p.getByRole('button',{name:'重新核对 AI 状态',exact:true}));await overview.getByText(label,{exact:true}).waitFor();
 }
 await p.evaluate(()=>{window.__reliability.aiKind='deferred';});await click(p.getByRole('button',{name:'重新核对 AI 状态',exact:true}));await p.waitForFunction(()=>Boolean(window.__reliability.aiRequest));
 await p.evaluate(()=>{window.__reliability.aiKind='disabled';window.__reliability.setAccount('account-b');});await overview.getByText('未启用',{exact:true}).waitFor();
 await p.evaluate(()=>window.__reliability.aiRequest.resolve({serverAvailable:true,settings:{revision:9,configured:true,enabled:true}}));await frames(p);
 assert.equal(await overview.getByText('已启用',{exact:true}).count(),0);await overview.getByText('未启用',{exact:true}).waitFor();
 assert.equal(await io(p,()=>window.__reliability.modelCalls),0);assert.equal(await io(p,()=>window.__reliability.restoreExports),0);
}

try{
 if(!process.env.UX_BROWSER_DRIVER)throw Error('UX_BROWSER_DRIVER must point to the installed Playwright package directory');
 const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
 root=await mkdtemp(join(tmpdir(),'zhixue-reliability-browser-'));
 await writeFile(join(root,'entry.tsx'),await readFile(join(repo,'tests/fixtures/reliability-browser-entry.txt'),'utf8'));
 await writeFile(join(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
 server=await createServer({configFile:false,root,cacheDir:join(root,'vite-cache'),plugins:[react()],resolve:{alias:[{find:'@repo',replacement:repo},{find:'react',replacement:join(repo,'node_modules/react')},{find:'react-dom',replacement:join(repo,'node_modules/react-dom')}],dedupe:['react','react-dom']},css:{postcss:{plugins:[tailwind()]}},server:{host:'127.0.0.1',port:0,fs:{allow:[repo,root]}},logLevel:'error'});
 await server.listen();origin=server.resolvedUrls.local[0].replace(/\/$/,'');
 if(process.env.UX_BROWSER_CHANNEL&&process.env.UX_BROWSER_CHANNEL!=='chrome')throw Error('Only the existing local Chrome test channel is supported');
 browser=await chromium.launch({headless:true,...(process.env.UX_BROWSER_CHANNEL?{channel:'chrome'}:{})});browserVersion=browser.version();
 for(const env of environments)for(const [name,run] of cases){
  if(diagnosticPairs&&!diagnosticPairs.has(env.id+'/'+name))continue;
  let context,page;const errors=[],row={environment:env.id,viewport:env.width,height:env.height,theme:env.theme,layout:env.layout,contentZoom:env.zoom||1,case:name,executed:true,passed:false};
  try{
   context=await browser.newContext({viewport:{width:env.width,height:env.height},colorScheme:env.theme});context.setDefaultTimeout(15000);
   const modelRequests=[];
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get('action')==='ai-chat'||url.pathname.endsWith('/chat/completions')||url.pathname.endsWith('/responses'))modelRequests.push(url.pathname);
    return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');
   });
   page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   const state={page,env};await run(state);await noOverflow(page);assert.deepEqual(errors,[],'Uncaught browser errors');assert.deepEqual(modelRequests,[],'A model request was attempted');
   row.zoomMeasurement=state.zoom||null;row.passed=true;
   await page.screenshot({path:join(evidence,`${env.id}-${name}.png`),fullPage:true});
  }catch(error){
   row.error=String(error.stack||error);row.browserErrors=errors;failures.push(`${env.id}/${name}: ${row.error}`);
   try{
    row.overflowElements=await page.evaluate(()=>[...document.querySelectorAll('body *')].map(el=>{
     const r=el.getBoundingClientRect(),c=getComputedStyle(el);
     return {tag:el.tagName,id:el.id,className:String(el.className),text:el.textContent?.trim().slice(0,90),left:r.left,right:r.right,width:r.width,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,css:{width:c.width,minWidth:c.minWidth,maxWidth:c.maxWidth,boxSizing:c.boxSizing,display:c.display,fontSize:c.fontSize,flexShrink:c.flexShrink},parent:el.parentElement?.className};
    }).filter(el=>el.width>0&&(el.right>innerWidth+1||el.left< -1)).slice(-100));
    await page?.screenshot({path:join(evidence,`${env.id}-${name}-FAILED.png`),fullPage:true});
   }catch{/* Keep the original failure. */}
  }
  finally{results.push(row);await context?.close();}
 }
}catch(error){failures.push(String(error.stack||error));}
finally{
 try{await browser?.close();}catch(error){failures.push('Browser cleanup: '+error);}
 try{await server?.close();}catch(error){failures.push('Server cleanup: '+error);}
 for(const env of environments)for(const [name] of cases)if(!results.some(row=>row.environment===env.id&&row.case===name))results.push({environment:env.id,case:name,executed:false,passed:false,error:diagnosticPairs&&!diagnosticPairs.has(env.id+'/'+name)?'Not selected for this local diagnostic run':'Infrastructure failed before this case could run'});
 failure=failures.length?failures.join('\n\n'):null;
 const diagnosticComplete=Boolean(diagnosticPairs)&&!failure&&results.filter(row=>row.executed).length===diagnosticPairs.size&&results.filter(row=>row.executed).every(row=>row.passed);
 const report={sha:process.env.GITHUB_SHA||null,browserVersion,browserChannel:process.env.UX_BROWSER_CHANNEL||'bundled-chromium',expected:EXPECTED,passed:results.filter(row=>row.passed).length,executed:results.filter(row=>row.executed).length,complete:!diagnosticPairs&&!failure&&results.length===EXPECTED&&results.every(row=>row.passed),failure,results,diagnosticExpected:diagnosticPairs?.size??null,diagnosticComplete,scenarioCount:cases.length,environmentCount:environments.length,environments,scenarioNames:cases.map(([name])=>name),scratch:root||null,mode:diagnosticPairs?'diagnostic-subset':'project-locked-runtime',limitations:['CSS zoom:2 is content scaling, not native browser zoom or a physical device.','Synthetic SourcesView model and controlled AI panel test actual product entry controls; root controller and real provider configuration require their own regressions.','No production records, real Companion, paid model, or screen reader is exercised.']};
 await writeFile(join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 if(!(diagnosticPairs?diagnosticComplete:report.complete))process.exitCode=1;
}
