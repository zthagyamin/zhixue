import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/planning'),evidence=resolve(process.env.UX_EVIDENCE),origin='http://127.0.0.1:4192';
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./planning-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>main{max-width:850px;margin:40px auto;padding:20px}button{display:inline-block;max-width:100%;margin:8px;padding:12px;border:1px solid #8b9999;border-radius:6px}</style><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4192,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['lost-reply','stale-refresh','automatic-scope','automatic-editor','navigation-group','navigation-cancel','legacy-scope'],expected=28,results=[];
let browser,activePage,failure=null;
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const width of [1440,390])for(const theme of ['light','dark'])for(const scenario of cases){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<800}),page=await context.newPage(),errors=[];activePage=page;page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  const revision=value=>page.waitForFunction(value=>document.querySelector('[data-testid="revision"]')?.textContent===String(value),value);
  if(scenario==='lost-reply'||scenario==='stale-refresh'){
   await revision(0);await click('保存计划');
   if(scenario==='lost-reply'){
    await page.getByRole('status').filter({hasText:'回执丢失'}).waitFor();await click('保存计划');await revision(1);
    const ids=await page.evaluate(()=>window.__planning.writes);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
   }else{
    await revision(1);await click('延迟读取');await page.waitForFunction(()=>window.__planning.pending===1);
    await click('暂停计划');await revision(2);await page.evaluate(()=>window.__planning.release());await page.getByText('已暂停',{exact:true}).waitFor();await revision(2);
   }
   const value=await page.evaluate(()=>window.__planning.read());assert.equal(value.revision,scenario==='lost-reply'?1:2);
   await page.reload();await revision(value.revision);
  }else if(scenario.startsWith('automatic-')){
   await page.waitForFunction(()=>window.__planning.pending===1);
   if(scenario==='automatic-scope'){await click('切换空间');await page.waitForFunction(()=>window.__planning.prepared.includes('B'));}
   else{await click('编辑长期计划');await page.evaluate(()=>window.__planning.release());await page.waitForTimeout(1200);assert.deepEqual(await page.evaluate(()=>window.__planning.prepared),[]);await click('结束编辑');await page.waitForFunction(()=>window.__planning.prepared.includes('A'));}
   await page.evaluate(()=>window.__planning.release());await page.waitForTimeout(100);
   assert.deepEqual(await page.evaluate(()=>window.__planning.prepared),[scenario==='automatic-scope'?'B':'A']);
  }else if(scenario.startsWith('navigation-')){
   await click('开始复习组');
   if(scenario==='navigation-cancel'){
    await page.waitForFunction(()=>window.__planning.pending===1);await click('查看学习进度');await page.evaluate(()=>window.__planning.release());await page.waitForTimeout(100);
    await page.getByRole('heading',{name:'学习进度',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.__planning.navigation),[]);
    assert.deepEqual((await page.evaluate(()=>window.__planning.read())).plan.manual.lockedTaskIds,[]);
   }else{
    await page.getByRole('heading',{name:'4 项同类练习',exact:true}).waitFor();await page.getByText('继续位置 2',{exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.__planning.read())).plan.manual.lockedTaskIds.length,4);
    await click('完成本轮浏览');await click('继续下一组');await page.waitForFunction(()=>window.__planning.navigation.at(-1)==='new-words');
    assert.equal(await page.evaluate(()=>window.__planning.formalEvents),0);
   }
   assert.equal(await page.evaluate(()=>window.__planning.busy),false);
  }else{
   await click('读取主计划');await revision(12);await click('准备合成候选');await page.getByText('有本页候选',{exact:true}).waitFor();await click('切换空间');await revision(0);
   await page.getByText('没有候选',{exact:true}).waitFor();await click('批准候选');assert.deepEqual(await page.evaluate(()=>window.__planning.writes),[]);
   await click('读取主计划');await revision(1);
  }
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:resolve(evidence,`${scenario}-${theme}-${width}.png`),fullPage:true});results.push({case:scenario,theme,viewport:width,passed:true});await context.close();activePage=null;
 }
}catch(error){failure=String(error.stack||error);if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));}throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:!failure&&results.length===expected,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
