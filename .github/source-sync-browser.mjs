import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/source-sync'),evidence=resolve(process.env.UX_EVIDENCE),origin='http://127.0.0.1:4193';
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./source-sync-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>main{max-width:850px;margin:36px auto;padding:20px}button,input{display:inline-block;max-width:100%;margin:8px;padding:12px;border:1px solid #8b9999;border-radius:6px}output{display:block;padding:12px}p{line-height:1.7}</style><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4193,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['pair-account','refresh-repair','edit-during-switch','logout-client','logout-repair','partial-export','clear-during-save','old-sync','frozen-account','retired-grant'],expected=40,results=[];
let browser,activePage,failure=null;
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const width of [1440,390])for(const theme of ['light','dark'])for(const scenario of cases){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<800}),page=await context.newPage(),errors=[];activePage=page;page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
  const click=name=>page.getByRole('button',{name,exact:true}).click(),pending=()=>page.waitForFunction(()=>window.__sources.pending===1),release=()=>page.evaluate(()=>window.__sources.release());
  const value=()=>page.getByTestId('value').innerText();
  if(scenario==='pair-account'){
   await click('开始配对');await pending();await click('账号资料到达');await release();await page.getByText('配对完成',{exact:true}).waitFor();assert.equal(await value(),'paired');
  }else if(scenario==='refresh-repair'){
   await click('刷新旧连接');await pending();await click('建立新连接');await release();await page.waitForTimeout(80);assert.equal(await value(),'new');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),[]);
  }else if(scenario==='edit-during-switch'){
   await page.getByLabel('当前答案').fill('first edit');await click('切到本机');await pending();await click('切到本机');await page.getByLabel('当前答案').fill('new answer');await release();await page.getByRole('status').filter({hasText:'已保留'}).waitFor();
   assert.equal(await value(),'账号资料');assert.equal(await page.getByLabel('当前答案').inputValue(),'new answer');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),[]);
  }else if(scenario.startsWith('logout-')){
   await click('退出网站');await pending();await click(scenario==='logout-client'?'更新连接能力':'替换配对');await release();await page.getByText('已退出网站',{exact:true}).waitFor();
   assert.deepEqual(await page.evaluate(()=>window.__sources.trace),scenario==='logout-client'?['retire','revoke:old','clear-connection','redirect']:['retire','revoke:old','redirect']);
  }else if(scenario==='partial-export'){
   await click('导出恢复数据');await page.waitForFunction(()=>document.querySelector('[data-testid="value"]')?.textContent==='export-partial');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),['download']);
  }else if(scenario==='clear-during-save'){
   await click('清理读取缓存');await pending();await click('开始保存');await release();await page.waitForFunction(()=>document.querySelector('[data-testid="value"]')?.textContent==='blocked');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),[]);
  }else if(scenario==='old-sync'){
   await click('发送旧账号记录');await pending();await click('切换账号');await release();await page.waitForTimeout(80);assert.equal(await value(),'B:false');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),[]);
  }else if(scenario==='frozen-account'){
   await click('刷新账号资料');await pending();await release();await page.getByText('新资料等待当前练习结束',{exact:true}).waitFor();assert.equal(await value(),'1');await click('结束当前练习');await page.getByText('已使用新资料',{exact:true}).waitFor();assert.equal(await value(),'2');
  }else{
   await click('连接账号题库');await pending();await click('切换资料连接');await release();await page.waitForTimeout(80);assert.equal(await value(),'B:false');assert.deepEqual(await page.evaluate(()=>window.__sources.trace),[]);
  }
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__sources.formalEvents),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:resolve(evidence,`${scenario}-${theme}-${width}.png`),fullPage:true});results.push({case:scenario,theme,viewport:width,passed:true});await context.close();activePage=null;
 }
}catch(error){failure=String(error.stack||error);if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));}throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:!failure&&results.length===expected,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
