// Real RecallPlugin, synthetic items only. No AI calls or production persistence.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/recall-content'),evidence=resolve(process.env.UX_EVIDENCE||'scratch/recall-content-evidence');
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./recall-flow-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4184';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4184,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
let browser,failure=null;const results=[];
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of ['legacy-echo','echo-answer','echo-only','legacy-grade','specific-grade']){
  const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);
  const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();await page.goto(`${origin}/?theme=${theme}&mode=${mode}`);
  const legacy=mode.startsWith('legacy-');
  const expectedPrompt=mode==='specific-grade'?'只观察两个因素一起变化的结果，为什么不能直接判断其中一个因素的贡献？':'为什么要进行对照实验？';
  if(legacy){
   const material=page.getByRole('region',{name:'待完善的阅读材料',exact:true});await material.waitFor();
   assert.match(await material.innerText(),/待补具体问题，暂不自测/);
   assert.equal(await page.getByRole('textbox').count(),0);assert.equal(await page.getByRole('radio').count(),0);
   assert.equal(await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).count(),0);
   await page.getByText('查看原始摘记（仍需核对）',{exact:true}).click();
   assert.match(await material.innerText(),/区分模型的观察结果与单项贡献；组合效果不能直接给出单项贡献。/);
  }else{
   await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).waitFor();
   assert.equal(await page.locator('.study-question').innerText(),expectedPrompt);
  }
  assert.equal(await page.locator('.recall-reference').count(),0);
  if(mode==='legacy-echo')await page.screenshot({path:resolve(evidence,`recall-content-before-${theme}-${viewport.width}.png`),fullPage:true});
  if(legacy){
   assert.equal(await page.evaluate(()=>window.__recallProbe.aiCalls),0);
   await page.getByRole('button',{name:'下一项，不计成绩',exact:true}).click();
  }else if(mode==='specific-grade'){
   await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('组合表现与单项贡献需要区分。');
   await page.getByRole('button',{name:'提交并核对',exact:true}).click();
   await page.getByText('AI 判定 · 部分正确',{exact:true}).waitFor();
   const questions=await page.evaluate(()=>window.__recallProbe.gradeQuestions);
   assert.equal(questions.length,1);assert.equal(questions[0].prompt,expectedPrompt);assert.equal(questions[0].fingerprint,'synthetic-0');
   await page.getByRole('button',{name:'结束本轮',exact:true}).click();
  }else{
   await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.__recallProbe.aiCalls),0);
   if(mode==='echo-only'){
    await page.getByText('缺少可核对的参考要点',{exact:true}).waitFor();
    assert.equal(await page.locator('.recall-reference').count(),0);
    assert.equal(await page.getByRole('radio').count(),0);
    assert.equal(await page.getByRole('button',{name:'看完了，结束本轮',exact:true}).count(),0);
    await page.getByRole('button',{name:'暂时跳过，不计成绩',exact:true}).click();
   }else{
    const reference=mode==='legacy-echo'?'区分模型的观察结果与单项贡献；组合效果不能直接给出单项贡献。':'控制其他条件后，比较目标因素变化对应的结果。';
    const shown=await page.locator('.recall-reference').innerText();
    assert.ok(shown.includes(reference));assert.notEqual(reference,expectedPrompt);
    if(mode==='echo-answer')assert.ok(!shown.includes(expectedPrompt));
    await page.screenshot({path:resolve(evidence,`recall-content-${mode}-${theme}-${viewport.width}.png`),fullPage:true});
    await page.getByRole('button',{name:'看完了，结束本轮',exact:true}).click();
   }
  }
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  const probe=await page.evaluate(()=>({grades:window.__recallProbe.grades,writes:window.__recallProbe.writeCalls,unchanged:JSON.stringify(window.__recallProbe.originalItems)===window.__recallProbe.originalJson}));
  assert.deepEqual(probe.grades,legacy||mode==='echo-only'?[]:mode==='specific-grade'?['hard']:['again']);
  assert.equal(probe.writes,legacy||mode==='echo-only'?0:1);assert.equal(probe.unchanged,true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);results.push({viewport:viewport.width,theme,case:mode,passed:true});await context.close();
 }
 assert.equal(results.length,20);
}catch(error){failure=String(error.stack||error);throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected:20,passed:results.length,complete:failure===null&&results.length===20,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
