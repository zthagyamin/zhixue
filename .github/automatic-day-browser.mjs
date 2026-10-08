// Actual application, actual account stores and synthetic records only.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {startAutomaticDayPreview} from '../tests/fixtures/automatic-day-preview.mjs';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const evidence=resolve(process.env.UX_EVIDENCE||'scratch/automatic-day-evidence');await mkdir(evidence,{recursive:true});
const log=createWriteStream(resolve(evidence,'application.log'));
const dev=spawn(process.execPath,['node_modules/vinext/dist/cli.js','dev','--hostname','127.0.0.1','--port','4188'],{env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
dev.stdout.pipe(log);dev.stderr.pipe(log);
let browser,preview,failure=null;const results=[];
try{
  const deadline=Date.now()+120000;let available=false;
  while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:4188/',{redirect:'manual',signal:AbortSignal.timeout(5000)});if(response.status<500){available=true;break;}}catch{/* The dev server is still starting. */}
    if(dev.exitCode!==null)throw new Error('Application exited before preview');await new Promise(resolve=>setTimeout(resolve,500));}
  assert.ok(available,'application dev server became ready');
  browser=await chromium.launch({headless:true});
  for(const width of [1440,390])for(const scenario of ['enabled','paused','existing','rejected']){
    preview=await startAutomaticDayPreview({port:4187,devPort:4188,scenario});
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(45000);
    await context.route('**/*',route=>{const url=new URL(route.request().url());return [preview.origin,'http://127.0.0.1:4188'].includes(url.origin)?route.continue():route.abort('blockedbyclient');});
    await page.goto(preview.origin+'/study');
    if(scenario==='enabled'){
      await page.getByRole('button',{name:'确认并开始今日自测',exact:true}).waitFor();
      const first=await preview.state();assert.equal(first.decision,'draft');assert.equal(first.approvedPlan,null);
      assert.equal(first.currentPlan.longTermAllocation.planId,'automatic-browser');assert.equal(first.currentPlan.day,preview.day);
      assert.ok((await preview.goals()).snapshot.asOfDate>=preview.day);
      assert.equal(preview.inspect().records,0);assert.deepEqual(preview.inspect().aiRequests,[]);assert.deepEqual(preview.mutations,['save']);
      assert.doesNotMatch(await page.locator('body').innerText(),/planning-scope-changed/,'Retired background reads must not leak internal cancellation notices');
      await page.screenshot({path:resolve(evidence,`automatic-day-${width}.png`),fullPage:true});
      await page.reload();await page.getByRole('button',{name:'确认并开始今日自测',exact:true}).waitFor();
      assert.equal((await preview.state()).currentPlan.cloudPlanHash,first.currentPlan.cloudPlanHash);assert.deepEqual(preview.mutations,['save']);
    }else{
      await page.getByText(preview.original.currentPlan?'今日草稿已准备好':'安排今天的学习',{exact:true}).waitFor();
      await page.waitForTimeout(2200); // Allow the existing one-second goal reconciliation timer to run.
      const state=await preview.state();assert.equal(state.revision,preview.original.revision);assert.deepEqual(preview.mutations,[]);
      assert.equal(state.currentPlan?.cloudPlanHash,preview.original.currentPlan?.cloudPlanHash);
    }
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    results.push({viewport:width,case:scenario,passed:true});await context.close();await preview.close();preview=null;
  }
}catch(error){failure=String(error.stack||error);throw error;}
finally{
  const report={sha:process.env.GITHUB_SHA||null,expected:8,passed:results.length,complete:!failure&&results.length===8,failure,results};
  await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  await browser?.close();await preview?.close();dev.kill();log.end();
}
