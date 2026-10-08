import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/study-attempt'),evidence=resolve(process.env.UX_EVIDENCE);
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./study-attempt-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4191';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4191,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['delayed','prewrite-failure','lost-reply','owner-switch','cancel','next-once','round-return','queue-scope'];
const expected=56,results=[];let browser,activePage,failure=null;
const inspect=page=>page.evaluate(()=>window.__attempt.read());
const wait=async(page,check)=>{await page.waitForFunction(check);};
async function answer(page){
 await page.getByRole('textbox',{name:'写下你回忆到的内容',exact:true}).fill('先控制其他条件，再比较目标因素变化；也要考虑测量误差。');
 await page.getByRole('button',{name:'提交并核对',exact:true}).click();
}
async function finish(page,host){
 await page.getByRole('heading',{name:host==='inline'?'内联本轮结束':'本轮练习结束',exact:true}).waitFor();
}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const host of ['subject','inline'])for(const scenario of cases){
  const navigationCase=['round-return','queue-scope'].includes(scenario);
  if(host==='inline'&&navigationCase)continue;
  const context=await browser.newContext({viewport,hasTouch:viewport.width<800});context.setDefaultTimeout(15000);const errors=[];
  context.on('page',page=>page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack||error.message);}));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();activePage=page;
  await page.goto(`${origin}/?theme=${theme}&host=${host}&case=${scenario}`);
  if(navigationCase){
   await page.getByRole('textbox',{name:'你的答案',exact:true}).waitFor();
   await page.evaluate(()=>window.__attempt.range(false));
   const solve=async()=>{await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('4');await page.getByRole('button',{name:'提交',exact:true}).click();await page.getByRole('button',{name:'继续',exact:true}).waitFor();};
   await solve();
   if(scenario==='round-return'){
    await page.evaluate(()=>window.__attempt.leaveSubject());await page.getByText('今日占位',{exact:true}).waitFor();
    await page.evaluate(()=>window.__attempt.returnSubject());await page.getByRole('button',{name:'继续',exact:true}).waitFor();
    await page.getByRole('button',{name:'展开本组清单',exact:true}).click();await page.locator('.word-stage-list button:visible').nth(1).click();await solve();await page.getByRole('button',{name:'继续',exact:true}).click();
    await page.getByRole('button',{name:'展开本组清单',exact:true}).click();await page.locator('.word-stage-list button:visible').nth(0).click();await page.getByRole('button',{name:'继续',exact:true}).click();
    await page.getByText('计算题 3：计算 2 + 2。',{exact:true}).first().waitFor();
    assert.deepEqual(await page.evaluate(()=>[...window.__attempt.rounds.python.correctKeys].sort()),['practice:q0','practice:q1']);
   }else{
    await page.evaluate(()=>window.__attempt.range(true));
    const input=page.getByRole('textbox',{name:'你的答案',exact:true});await input.waitFor();assert.equal(await input.inputValue(),'');
    assert.equal(await page.getByRole('button',{name:'继续',exact:true}).count(),0);
    assert.deepEqual(await page.evaluate(()=>window.__attempt.rounds.python.correctKeys),[]);
    await page.evaluate(()=>window.__attempt.range(false));await page.getByRole('button',{name:'继续',exact:true}).click();
    await page.getByText('计算题 2：计算 2 + 2。',{exact:true}).first().waitFor();
   }
   const count=scenario==='round-return'?2:1,state=await inspect(page);
   assert.equal(state.events.length,count);assert.equal(state.journal.length,count);assert.equal(await page.evaluate(()=>window.__attempt.projected),count);
   assert.equal(await page.evaluate(()=>window.__attempt.pending()),false);assert.deepEqual(errors,[]);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.screenshot({path:resolve(evidence,`${host}-${scenario}-${theme}-${viewport.width}.png`)});
   results.push({host,viewport:viewport.width,theme,case:scenario,passed:true});await context.close();activePage=null;continue;
  }
  await answer(page);
  if(scenario==='cancel'){
   await page.getByRole('button',{name:'停止核对，保留待核对答案',exact:true}).click();
   await page.getByRole('region',{name:'待核对答案',exact:true}).waitFor();
   assert.equal(await page.getByRole('radio').count(),0);
   const pending=await inspect(page);assert.equal(pending.events.length,0);assert.equal(pending.journal.length,0);
   const original=pending.attempts.find(item=>item.submitted?.answer==='先控制其他条件，再比较目标因素变化；也要考虑测量误差。');
   assert.ok(original);assert.equal(original.evaluation.status,'pending');assert.equal(original.formal,null);
   await page.evaluate(()=>window.__attempt.releaseAI());
   assert.equal(await page.getByText('LATE RESPONSE',{exact:true}).count(),0);
   const retained=(await inspect(page)).attempts.find(item=>item.attemptId===original.attemptId);
   assert.deepEqual(retained.submitted,original.submitted);assert.equal(retained.evaluation.status,'pending');assert.equal(retained.formal,null);
   await page.getByText('口头回忆后自评',{exact:true}).click();
   await page.getByRole('button',{name:'想好了，核对要点',exact:true}).click();
   await page.getByRole('radio',{name:'部分记得',exact:true}).check();
   assert.equal(await page.evaluate(()=>window.__attempt.pending()),false);
   assert.equal(await page.getByText('LATE RESPONSE',{exact:true}).count(),0);
  }
  const save=page.getByRole('button',{name:scenario==='next-once'?'下一题':'结束本轮',exact:true});
  await save.click();
  if(scenario==='delayed'||scenario==='owner-switch'){
   await wait(page,()=>window.__attempt.writes===1);
   const before=await inspect(page);assert.equal(before.events.length,0);
   assert.equal(await page.evaluate(()=>window.__attempt.projected),0);
   assert.equal(await page.evaluate(()=>window.__attempt.pending()),true);
   assert.equal(await page.getByRole('button',{name:'正在保存…',exact:true}).isDisabled(),true);
   if(scenario==='owner-switch'){
    await page.evaluate(()=>window.__attempt.switchOwner());
    await page.getByRole('heading',{name:'新学习空间',exact:true}).waitFor();
   }
   await page.evaluate(()=>window.__attempt.releaseWrite());
  }
  if(scenario==='prewrite-failure'||scenario==='lost-reply'){
   await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
   const failed=await inspect(page);
   assert.equal(failed.events.length,scenario==='lost-reply'?1:0);
   assert.equal(await page.evaluate(()=>window.__attempt.projected),0);
   await page.getByText('你的回答',{exact:true}).click();
   await page.getByText('先控制其他条件，再比较目标因素变化；也要考虑测量误差。',{exact:true}).waitFor();
   await page.getByRole('button',{name:'重试保存',exact:true}).click();
  }
  if(scenario==='owner-switch'){
   await wait(page,()=>window.__attempt.records.length===1);
   assert.equal(await page.evaluate(()=>window.__attempt.projected),0);
   assert.equal(await page.evaluate(()=>window.__attempt.networkCalls),0);
   assert.equal(await page.evaluate(()=>window.__attempt.finished),0);
  }else if(scenario==='next-once'){
   await page.getByRole('heading',{name:itemsHeading(2),exact:true}).waitFor();
   assert.equal((await inspect(page)).events.length,1);
   assert.equal(await page.getByRole('textbox',{name:'写下你回忆到的内容',exact:true}).inputValue(),'');
   // A second click cannot reuse the first question's saved continuation.
   assert.equal(await page.getByRole('button',{name:'下一题',exact:true}).count(),0);
   await answer(page);await page.getByRole('button',{name:'结束本轮',exact:true}).click();await finish(page,host);
  }else await finish(page,host);
  const state=await inspect(page),count=scenario==='next-once'?2:1;
  assert.equal(state.events.length,count);assert.equal(state.journal.length,count);assert.equal(state.other.length,0);
  assert.equal(state.journal.every(row=>row.coreStored),true);
  assert.equal(new Set(state.events.map(row=>row.eventId)).size,count);
  assert.deepEqual(state.events.map(row=>row.event.attempt.rating).sort(),scenario==='cancel'?['hard']:Array(count).fill('good'));
  if(scenario==='lost-reply'){
   const records=await page.evaluate(()=>window.__attempt.records);assert.equal(records.length,1,'verified saved core is recovered without calling the formal writer again');
   assert.equal(await page.evaluate(()=>window.__attempt.writes),1);
   assert.equal(records[0].eventId,state.events[0].eventId);assert.equal(records[0].event.coreHash,state.journal[0].payload.core.event.coreHash);
   assert.equal(state.events[0].event.scheduling.clientStateAfter.reps,1);
   assert.equal(state.events[0].companion,'pending');assert.equal(state.journal[0].cloudAck,null);
   assert.equal(await page.evaluate(()=>window.__attempt.pending()),false);
   assert.ok(!(await page.locator('body').innerText()).includes('作答尚未保存成功'));
  }
  if(scenario!=='owner-switch'&&scenario!=='lost-reply'){
   await wait(page,()=>window.__attempt.networkCalls>0);
   assert.equal(await page.evaluate(()=>window.__attempt.projected),count);
   assert.equal(await page.evaluate(()=>window.__attempt.pending()),false);
   if(host==='inline')assert.equal(await page.evaluate(()=>window.__attempt.finished),1);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(evidence,`${host}-${scenario}-${theme}-${viewport.width}.png`)});
  results.push({host,viewport:viewport.width,theme,case:scenario,passed:true});
  await context.close();activePage=null;
 }
 assert.equal(results.length,expected);
}catch(error){
 failure=String(error.stack||error);
 if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));await writeFile(resolve(evidence,'failure-state.json'),JSON.stringify(await inspect(activePage).catch(()=>null),null,2));}
 throw error;
}finally{
 const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:failure===null&&results.length===expected,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
function itemsHeading(index){return `回忆题 ${index}：为什么需要控制其他条件？`;}
