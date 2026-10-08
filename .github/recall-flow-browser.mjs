// Project React/runtime. Synthetic AI and persistence only; never production records.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';import {createRequire} from 'node:module';
import {createServer} from 'vite';import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/recall-flow'),evidence=resolve(process.env.UX_EVIDENCE||'scratch/recall-evidence');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./recall-flow-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4183';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4183,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
let browser,failure=null;const results=[];
async function open(viewport,theme,mode,count=1){
 const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
 const page=await context.newPage();await page.goto(origin+`/?theme=${theme}&mode=${mode}&count=${count}`);await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).waitFor();return {page,context,errors};
}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of ['single','multi','save-fail','missing','cancel','support','inline','extra']){
  const f=await open(viewport,theme,mode,mode==='multi'?2:1),{page}=f;
  if(mode==='save-fail'||mode==='cancel'){
   await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('我的原始回答');await page.getByRole('button',{name:'提交并核对',exact:true}).click();
   if(mode==='cancel'){
    await page.getByRole('button',{name:'停止核对，改为自评',exact:true}).click();await page.getByText('已停止本次核对，可对照已有要点自评。',{exact:true}).waitFor();
    await page.evaluate(()=>window.__recallProbe.resolveAI?.({source:'ai',rating:'good',feedback:'LATE RESPONSE'}));
    await page.getByRole('radio',{name:'部分记得',exact:true}).check();
   }
   await page.getByRole('button',{name:'结束本轮',exact:true}).click();
   if(mode==='save-fail'){
    await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.__recallProbe.grades),[]);
    await page.getByText('你的回答',{exact:true}).click();await page.getByText('我的原始回答',{exact:true}).waitFor();await page.getByRole('button',{name:'重试保存',exact:true}).click();
   }
  }else{
   if(mode==='single')await page.screenshot({path:resolve(evidence,`recall-initial-${theme}-${viewport.width}.png`),fullPage:true});
   await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.__recallProbe.aiCalls),0);
   if(mode==='missing')await page.getByRole('button',{name:'暂时跳过，不计成绩',exact:true}).click();
   else if(mode==='multi'){
    await page.getByRole('button',{name:'看完了，下一题',exact:true}).click();await page.getByRole('heading',{name:'回忆题 2',exact:true}).waitFor();
    await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();await page.getByRole('button',{name:'看完了，结束本轮',exact:true}).click();
   }else{
    if(mode==='single')await page.screenshot({path:resolve(evidence,`recall-feedback-${theme}-${viewport.width}.png`),fullPage:true});
    await page.getByRole('button',{name:'看完了，结束本轮',exact:true}).click();
   }
  }
  await page.getByRole('heading',{name:mode==='inline'?'内联本轮结束':'本轮练习结束',exact:true}).waitFor();
  const grades=await page.evaluate(()=>window.__recallProbe.grades);assert.deepEqual(grades,mode==='missing'||mode==='extra'?[]:mode==='multi'?['again','again']:mode==='cancel'||mode==='save-fail'?['hard']:['again']);
  if(mode==='single'){await page.getByText('已练 1 / 1 · 待巩固 1 · 暂跳 0',{exact:true}).waitFor();await page.screenshot({path:resolve(evidence,`recall-complete-${theme}-${viewport.width}.png`),fullPage:true});}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(f.errors,[]);results.push({viewport:viewport.width,theme,case:mode,passed:true});await f.context.close();
 }
 assert.equal(results.length,32);
}catch(error){failure=String(error.stack||error);throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected:32,passed:results.length,complete:failure===null&&results.length===32,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
