import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {waitForReadback} from './readback-observation.mjs';

/** Hold only a real synthetic math response; normal navigation still belongs to Dashboard. */
export async function runDashboardLateResult({page,context,account,width,out,errors}){
 const input=page.getByRole('textbox',{name:'你的答案'});
 await input.fill(' 4 ');
 let release,held,delivery=null,resolveFinished;
 const gate=new Promise(resolve=>{release=resolve;});
 const finished=new Promise(resolve=>{resolveFinished=resolve;});
 await context.route('**/api/account-study**',async route=>{
  const request=route.request();
  if(request.method()!=='POST'||request.postDataJSON()?.action!=='math-evaluate')return route.continue();
  try{
   const response=await route.fetch();
   held={status:response.status(),body:await response.json()};
   await gate;
   try{await route.fulfill({response});delivery='route-fulfilled';}
   catch{delivery='client-aborted';}
  }catch(error){held={error:String(error)};delivery='fetch-failed';}
  finally{resolveFinished();}
 });
 try{
  await page.getByRole('button',{name:'提交',exact:true}).click();
  const observed=await waitForReadback(async()=>held,value=>Boolean(value),{label:'Real math reply'});
  assert.equal(observed.status,200);
  assert.equal(observed.body.final.status,'correct');
  assert.equal(observed.body.final.source,'deterministic');
  const submitted=(await page.evaluate(()=>window.__dashboardProbe.read()))[0];
  assert.equal(submitted.submitted,' 4 ');assert.equal(submitted.formal,null);
  assert.equal(observed.body.attemptId,submitted.id);
  assert.equal(observed.body.sourceVersion,submitted.contentHash);
  await page.getByRole('button',{name:'返回今日',exact:true}).click();
  await page.getByRole('button',{name:/^(开始|继续)今日自测$/}).waitFor();
  assert.equal(await input.count(),0);
  assert.equal((await account.status()).counts.records,0);
  release();await finished;await page.waitForLoadState('networkidle');
  const after=(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===submitted.id);
  assert.equal(after.submitted,' 4 ');assert.equal(after.evaluation,'pending');assert.equal(after.formal,null);
  assert.equal(await page.getByText('最终结果与来源参考一致。',{exact:true}).count(),0);
  const pendingStatus=await account.status();
  assert.equal(pendingStatus.counts.records,0);assert.equal(pendingStatus.counts.aiRequests,0);
  await page.screenshot({path:resolve(out,'late-after-leave-'+width+'.png'),fullPage:true});
  await context.unroute('**/api/account-study**');
  await page.getByRole('button',{name:/^(开始|继续)今日自测$/}).click();await input.waitFor();
  assert.equal(await input.inputValue(),' 4 ');
  await page.getByRole('button',{name:'提交',exact:true}).dblclick();
  const resolved=await waitForReadback(async()=>(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===after.id),
   row=>row?.formal?.status==='linked'&&row.evaluation==='resolved',{label:'Local formal link'});
  assert.equal(resolved.submitted,' 4 ');assert.equal(resolved.contentHash,submitted.contentHash);
  const official=await waitForReadback(()=>account.status(),value=>value.recordCounts['calculation:good']===1,
   {label:'Account formal receipt'});
  assert.equal(official.counts.records,1);assert.equal(official.counts.aiRequests,0);
  const published=(await account.client.load()).records.map(row=>row.record);
  assert.equal(published.length,1);
  assert.equal(published[0].event.eventId,resolved.formal.eventId);
  assert.equal(published[0].event.coreHash,resolved.formal.coreHash);
  assert.equal(published[0].contentHash,resolved.contentHash);
  assert.equal(published[0].event.attempt.rating,'good');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(out,'current-result-'+width+'.png'),fullPage:true});
  return {width,passed:true,actualMathReply:'correct',rawAnswer:resolved.submitted,lateState:'pending',lateFormal:null,
   currentFormal:resolved.formal,officialRecords:1,duplicateClickDidNotDuplicate:true,delivery,body:await page.locator('body').innerText(),errors,status:official};
 }finally{release();await context.unroute('**/api/account-study**');}
}
