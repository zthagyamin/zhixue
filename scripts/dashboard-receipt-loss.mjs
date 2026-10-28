import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createAccountAttemptClient} from '../src/infrastructure/learning-attempt/index.ts';
import {waitForReadback} from './readback-observation.mjs';

/** Lose only the HTTP receipt of an actually accepted first-answer operation. */
export async function runDashboardReceiptLoss({page,context,account,width,out,errors}) {
  const origin=new URL(page.url()).origin;
  const remote=createAccountAttemptClient({ownerId:account.userId,libraryId:'library-a',
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),
      {...init,headers:{...init?.headers,Origin:origin}}))});
  const input=page.getByRole('textbox',{name:'你的答案'});
  await input.fill(' 1/2 ');
  let lost=null,blocked=true;
  const submissions=[],replayReceipts=[];
  await context.route('**/api/account-study**',async route=>{
    const request=route.request(),body=request.method()==='POST'?request.postDataJSON():null;
    if(body?.action!=='attempt-mutate'||body.mutation?.kind!=='submit')return route.continue();
    const mutation=body.mutation;
    submissions.push({attemptId:mutation.attemptId,operationId:mutation.operationId,expectedRevision:mutation.expectedRevision});
    if(blocked&&lost&&mutation.operationId===lost.operationId)return route.abort('failed');
    const response=await route.fetch(),receipt=await response.json();
    if(!lost){
      lost={httpStatus:response.status(),status:receipt.status,durable:receipt.durable,
        operationId:mutation.operationId,attemptId:mutation.attemptId,attempt:receipt.attempt};
      return route.abort('failed');
    }
    replayReceipts.push({operationId:mutation.operationId,httpStatus:response.status(),status:receipt.status,durable:receipt.durable});
    return route.fulfill({response});
  });
  try {
    await page.getByRole('button',{name:'提交',exact:true}).click();
    const accepted=await waitForReadback(async()=>lost,row=>Boolean(row),{label:'Server saved before receipt loss'});
    assert.equal(accepted.httpStatus,200);assert.equal(accepted.status,'accepted');assert.equal(accepted.durable,true);
    await page.getByText('首轮答案已保留 · 待核对',{exact:true}).waitFor();
    const original=(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===accepted.attemptId);
    assert.equal(original.submitted,' 1/2 ');assert.equal(original.evaluation,'pending');assert.equal(original.formal,null);
    const serverSaved=await remote.read(original.id);
    assert.equal(serverSaved.submitted.answer,original.submitted);
    assert.equal(serverSaved.binding.contentHash,original.contentHash);
    assert.equal(serverSaved.operations.filter(row=>row.operationId===accepted.operationId).length,1);
    const unacknowledged=await page.evaluate(id=>window.__dashboardProbe.delivery(id),original.id);
    assert.equal(unacknowledged.status,'device-only');
    assert.equal(unacknowledged.pending.filter(row=>row.kind==='submit'&&row.operationId===accepted.operationId).length,1);
    assert.equal((await account.status()).counts.records,0);
    await page.screenshot({path:resolve(out,'receipt-lost-'+width+'.png'),fullPage:true});
    blocked=false;
    await page.reload();await page.waitForLoadState('networkidle');
    await page.getByRole('region',{name:'今日自测入口'}).getByRole('button',{name:/^(开始下一项|继续今日任务)$/}).click();await input.waitFor();
    assert.equal(await input.inputValue(),' 1/2 ');
    await page.getByRole('button',{name:'提交',exact:true}).dblclick();
    await page.getByText('首轮答案已保留 · 待核对',{exact:true}).waitFor();
    await waitForReadback(async()=>replayReceipts,
      rows=>rows.some(row=>row.operationId===accepted.operationId&&row.status==='duplicate'&&row.durable===true),
      {label:'Exact first-answer duplicate receipt'});
    const acknowledged=await waitForReadback(()=>page.evaluate(id=>window.__dashboardProbe.delivery(id),original.id),
      row=>row.status==='cloud-acked'&&row.pending.length===0,{label:'Same attempt cloud acknowledgment'});
    const current=(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===original.id);
    assert.equal(current.submitted,original.submitted);assert.equal(current.contentHash,original.contentHash);
    assert.equal(current.formal,null);assert.equal(current.evaluation,'pending');
    const remoteAfter=await remote.read(original.id);
    assert.equal(remoteAfter.submitted.answer,original.submitted);
    assert.equal(remoteAfter.operations.filter(row=>row.operationId===accepted.operationId).length,1);
    assert.deepEqual([...new Set(submissions.map(row=>row.attemptId))],[original.id]);
    assert.deepEqual([...new Set(submissions.map(row=>row.operationId))],[accepted.operationId]);
    assert.equal((await remote.list()).filter(row=>row.checkpoint.mode==='calculation'&&row.checkpoint.purpose==='first').length,1);
    const status=await account.status();assert.equal(status.counts.records,0);assert.equal(status.counts.aiRequests,0);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:resolve(out,'receipt-recovered-'+width+'.png'),fullPage:true});
    return {width,passed:true,rawAnswer:original.submitted,attemptId:original.id,operationId:accepted.operationId,
      savedBeforeAbort:true,exactDuplicateReceipt:true,submitOperations:submissions,replayReceipts,
      beforeRecovery:unacknowledged,afterRecovery:acknowledged,
      formal:null,remoteFirstAttempts:1,officialRecords:0,body:await page.locator('body').innerText(),errors,status};
  } finally {await context.unroute('**/api/account-study**');}
}
