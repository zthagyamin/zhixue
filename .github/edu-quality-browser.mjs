// Actual lazy registry, quality boundary, plugins and draft host; synthetic data only.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/edu-quality'),evidence=resolve(process.env.UX_EVIDENCE||'scratch/edu-quality-evidence');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./edu-quality-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4188';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4188,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['echo','invalid-config','conflict','mandatory','partial','dispute','quiz','empty-back','zero','switched','inline','extra','cancel','save-fail','extra-switched','word-recall','word-flashcard','legacy-flashcard','model-easy'];
let browser,failure=null;const results=[];
try{
 await server.listen();browser=await chromium.launch({headless:true,...(process.env.EDU_CHROMIUM_PATH?{executablePath:process.env.EDU_CHROMIUM_PATH}:{})});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of cases){
  const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);const errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();await page.goto(`${origin}/?theme=${theme}&mode=${mode}`);
  if(['invalid-config','quiz','empty-back','switched','extra-switched'].includes(mode)){
   await page.getByRole('heading',{name:'本题暂不计入成绩',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'提交并核对',exact:true}).count(),0);
   await page.getByRole('button',{name:'暂时跳过，不计成绩',exact:true}).click();
  }else if(['zero','word-flashcard','legacy-flashcard'].includes(mode)){
   await page.getByRole('button',{name:/显示答案/}).click();await page.getByText(mode==='zero'?'0':mode==='word-flashcard'?/树/:/Valid reference/,{exact:mode==='zero'}).waitFor();
   await page.getByRole('button',{name:'良好',exact:true}).click();
  }else if(mode==='inline'||mode==='extra'){
   await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();
   await page.getByRole('button',{name:'暂时跳过，不计成绩',exact:true}).click();
  }else{
   await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('这是我的独立回答。');
   await page.getByRole('button',{name:'提交并核对',exact:true}).click();
   if(mode==='echo'){
    await page.getByText(/没有调用 AI/).waitFor();assert.equal(await page.evaluate(()=>window.__eduProbe.aiCalls),0);
    await page.getByRole('button',{name:'暂时跳过，不计成绩',exact:true}).click();
   }else{
    if(mode==='cancel'){
     await page.getByRole('button',{name:'停止核对，改为自评',exact:true}).click();
     await page.getByText(/已停止本次核对/).waitFor();
     await page.evaluate(()=>window.__eduProbe.resolveAI?.({source:'ai',verdict:'correct',rating:'good',feedback:'STALE RESPONSE'}));
    }else if(['conflict','mandatory','model-easy'].includes(mode))await page.getByText(/评价与评分依据不一致/).waitFor();
    else await page.getByText(/AI 判定/).waitFor();
    if(mode==='partial'){
     await page.locator('.recall-core-feedback').filter({hasText:'关键遗漏'}).waitFor();await page.getByText('详细核对与追问',{exact:true}).click();await page.getByText(/加权覆盖 25%/).waitFor();
    }
    if(mode==='dispute'){
     await page.getByRole('button',{name:'改用我的自评',exact:true}).click();await page.getByText(/离开本页不保留/).waitFor();
    }
    if(['conflict','mandatory','dispute','cancel','model-easy'].includes(mode)){
     assert.equal(await page.getByRole('button',{name:'结束本轮',exact:true}).isDisabled(),true);
     await page.getByRole('radio',{name:'部分记得',exact:true}).check();
    }
    assert.deepEqual(await page.evaluate(()=>window.__eduProbe.grades),[]);
    if(['partial','conflict','dispute'].includes(mode))await page.screenshot({path:resolve(evidence,`edu-${mode}-${theme}-${viewport.width}.png`),fullPage:true});
    await page.getByRole('button',{name:'结束本轮',exact:true}).click();
    if(mode==='save-fail'){
     await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.__eduProbe.grades),[]);
     await page.getByRole('button',{name:'重试保存',exact:true}).click();
    }
   }
  }
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  const observed=await page.evaluate(()=>({grades:window.__eduProbe.grades,calls:window.__eduProbe.aiCalls,unchanged:window.__eduProbe.unchanged()}));
  const ungraded=['echo','invalid-config','quiz','empty-back','switched','inline','extra','extra-switched'].includes(mode);
  assert.deepEqual(observed.grades,ungraded?[]:['zero','save-fail','word-recall','word-flashcard','legacy-flashcard'].includes(mode)?['good']:['hard']);
  if(ungraded)assert.equal(observed.calls,0);assert.equal(observed.unchanged,true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);results.push({viewport:viewport.width,theme,case:mode,passed:true});await context.close();
 }
 assert.equal(results.length,76);
}catch(error){failure=String(error.stack||error);throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected:76,passed:results.length,complete:failure===null&&results.length===76,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
