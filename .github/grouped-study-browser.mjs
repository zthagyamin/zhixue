// Real dashboard and persistence handlers. All accounts, material and attempts are synthetic.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {startAccountPagePreview} from '../tests/fixtures/automatic-day-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {installGroupedStudyProbe,groupedStudyTrace} from './grouped-study-probe.mjs';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const evidence=resolve(process.env.UX_EVIDENCE||'scratch/grouped-study-evidence');await mkdir(evidence,{recursive:true});
const log=createWriteStream(resolve(evidence,'application.log'));
const dev=spawn(process.execPath,['node_modules/vinext/dist/cli.js','dev','--hostname','127.0.0.1','--port','4188'],{env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
dev.stdout.pipe(log);dev.stderr.pipe(log);
const results=[];let browser,preview,activePage,failure=null;
async function until(check){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('expected persisted fixture condition');}
async function recallPass(page,temporary=false){
  await page.getByRole('heading',{name:'回忆练习 A：请说明适用条件。',exact:true}).waitFor();
  if(temporary)await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('合成巩固输入');
  await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();
  await page.getByRole('button',{name:temporary?'结束补练并继续':'看完了，下一题',exact:true}).click();
  await page.getByRole('heading',{name:'回忆练习 B：请说明适用条件。',exact:true}).waitFor();
  await page.getByRole('button',{name:'忘记了，查看要点',exact:true}).click();
  await page.getByRole('button',{name:temporary?'结束补练并继续':'看完了，结束本轮',exact:true}).click();
  if(temporary)await page.locator('.extra-practice-result').waitFor();else await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
}
try{
  await until(async()=>{try{return(await fetch('http://127.0.0.1:4188/',{redirect:'manual',signal:AbortSignal.timeout(5000)})).status<500;}catch{return false;}});
  browser=await chromium.launch({headless:true});
  for(const width of [1440,390])for(const theme of ['light','dark']){
    const origin='http://127.0.0.1:4187',account=await createAccountPreview({origin,userId:'e'.repeat(64),groupedStudy:true,manyReviews:true,reviewTarget:width===390?1:6});
    const client=createAccountStudyClient({companionUrl:origin,expectedUserId:account.userId,cache:null,fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
    preview=await startAccountPagePreview({account,client,port:4187,devPort:4188});
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme}),page=await context.newPage(),errors=[];activePage=page;page.setDefaultTimeout(45000);
    await installGroupedStudyProbe(context,origin);
    await context.addInitScript(({origin,theme})=>{if(location.origin===origin)localStorage.setItem('zhixue:appearance:theme:v1',theme);},{origin,theme});
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>[origin,'http://127.0.0.1:4188'].includes(new URL(route.request().url()).origin)?route.continue():route.abort('blockedbyclient'));
    await page.goto(origin+'/study');
    await page.waitForFunction(theme=>document.documentElement.classList.contains('dark')===(theme==='dark'),theme);
    await page.getByRole('button',{name:'开始今日自测',exact:true}).waitFor();
    if(width===390){
      await page.getByText('查看今日任务与进度',{exact:true}).click();
      // Initial account reconciliation can briefly enable and disable this action.
      // Wait for its requests to settle before the single trusted append click.
      await page.waitForLoadState('networkidle');
      await page.evaluate(()=>window.__groupedSnapshot('before-append'));
      await page.getByRole('button',{name:'再加 5 条复习',exact:true}).and(page.locator(':enabled')).click();
      await page.evaluate(()=>window.__groupedSnapshot('after-append-click'));
      await page.getByText('今日先复习 6 条',{exact:true}).waitFor();
    }
    await page.getByRole('region',{name:'今日自测入口'}).getByText(/今日待自测\s*3\s*组/).waitFor();
    // The account may briefly reconcile again; click only while the same three-group entry is ready.
    await page.waitForLoadState('networkidle');
    await page.getByRole('region',{name:'今日自测入口'}).filter({hasText:/今日待自测\s*3\s*组/}).getByRole('button',{name:'开始今日自测',exact:true}).click();
    await page.getByText('到期复习 · 本组 2 题',{exact:true}).waitFor();await recallPass(page);
    await until(()=>preview.inspect().records===2);
    assert.equal((await preview.records()).filter(row=>row.record.event.attempt?.correct).length,0);
    await page.getByRole('button',{name:'再巩固一遍',exact:true}).click();await recallPass(page,true);
    const result=page.locator('.extra-practice-result');
    const bounds=await result.evaluate(element=>({height:element.getBoundingClientRect().height,viewport:innerHeight,top:element.getBoundingClientRect().top}));
    assert.ok(bounds.height<bounds.viewport&&bounds.top>=0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const exitBounds=await page.getByRole('button',{name:'结束巩固',exact:true}).boundingBox();assert.ok(exitBounds.height<=52,'text exit control remains on one line');
    assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark');
    await page.screenshot({path:resolve(evidence,`extra-result-${theme}-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'再巩固一遍',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'写下你回忆到的内容'}).inputValue(),'');await recallPass(page,true);
    assert.match(await result.innerText(),/已练 2 \/ 2/);assert.equal(preview.inspect().records,2);
    await page.getByRole('button',{name:'返回本轮完成页',exact:true}).click();
    await page.waitForLoadState('networkidle');
    if(width===390){await page.getByRole('button',{name:'返回今日',exact:true}).click();await page.getByRole('button',{name:'开始今日自测',exact:true}).click();}
    else await page.getByRole('button',{name:'继续今日自测',exact:true}).click();
    await page.getByText('到期复习 · 本组 3 词',{exact:true}).waitFor();
    await page.getByRole('heading',{name:'disturb',exact:true}).waitFor();
    await page.getByRole('button',{name:'想好了，核对',exact:true}).click();await page.getByRole('button',{name:'想对了',exact:true}).click();
    // Three-stage practice randomizes the next unfinished word. Both alternatives must stay eligible.
    await page.getByRole('heading',{name:/^(retain|reflect)$/}).waitFor();
    await until(()=>preview.inspect().records===3);
    await page.getByRole('button',{name:'返回今日',exact:true}).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('region',{name:'今日自测入口'}).filter({hasText:/今日待自测\s*2\s*组/}).getByRole('button',{name:/^(开始|继续)今日自测$/}).click();
    await page.locator('.study-word-card').waitFor();assert.equal(await page.getByRole('heading',{name:'本轮练习结束',exact:true}).count(),0);
    await page.screenshot({path:resolve(evidence,`group-resume-${theme}-${width}.png`),fullPage:true});assert.deepEqual(errors,[]);
    results.push({viewport:width,theme,case:'grouped recall, extra practice, next group and partial vocabulary resume',passed:true});
    await writeFile(resolve(evidence,`interaction-${theme}-${width}.json`),JSON.stringify(await groupedStudyTrace(page),null,2));
    await context.close();await preview.close();preview=null;
  }
}catch(error){failure=String(error.stack||error);if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(evidence,'failure-page.txt'),await activePage.locator('body').innerText().catch(()=>''));await writeFile(resolve(evidence,'failure-interaction.json'),JSON.stringify(await groupedStudyTrace(activePage).catch(()=>null),null,2));}throw error;}
finally{const report={sha:process.env.GITHUB_SHA||null,expected:4,passed:results.length,complete:!failure&&results.length===4,failure,results};await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await preview?.close();dev.kill();log.end();}
