import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {waitForReadback} from './readback-observation.mjs';

/** Keep the original graded event; drop only its actually accepted account response. */
export async function runDashboardFormalReceiptLoss({page,context,account,width,out,errors,dropRecoveredReceipts=false}) {
  const input=page.getByRole('textbox',{name:'你的答案'});await input.fill(' 4 ');
  let lost=null,blocked=true;
  const dispatches=[],replayReceipts=[];
  await context.route('**/api/account-study**',async route=>{
    const request=route.request(),body=request.method()==='POST'?request.postDataJSON():null;
    if(body?.action!=='append-records')return route.continue();
    assert.equal(body.records.length,1);
    const record=body.records[0],eventId=record.event.eventId;
    dispatches.push({eventId,coreHash:record.event.coreHash,envelopeHash:record.envelopeHash});
    if(blocked&&lost&&eventId===lost.record.event.eventId)return route.abort('failed');
    const response=await route.fetch(),reply=await response.json();
    const entry=reply.results?.find(row=>row.eventId===eventId);
    if(!lost){lost={httpStatus:response.status(),record,entry};return route.abort('failed');}
    if(dropRecoveredReceipts)return route.abort('failed');
    await route.fulfill({response});
    replayReceipts.push({eventId:entry?.eventId,status:entry?.status,durable:entry?.durable,
      receiptEventId:entry?.receipt?.eventId,envelopeHash:entry?.receipt?.envelopeHash});
  });
  try {
    await page.getByRole('button',{name:'提交',exact:true}).dblclick();
    const accepted=await waitForReadback(async()=>lost,value=>Boolean(value),{label:'Formal event accepted before lost receipt'});
    assert.equal(accepted.httpStatus,200);assert.equal(accepted.entry.status,'accepted');assert.equal(accepted.entry.durable,true);
    assert.equal(accepted.entry.receipt.eventId,accepted.record.event.eventId);
    assert.equal(accepted.entry.receipt.envelopeHash,accepted.record.envelopeHash);
    const original=await waitForReadback(async()=>page.evaluate(()=>window.__dashboardProbe.read()),
      rows=>rows.length===1&&rows[0].formal?.status==='linked'&&rows[0].evaluation==='resolved',
      {label:'Locally linked formal result'}).then(rows=>rows[0]);
    assert.equal(original.submitted,' 4 ');assert.equal(original.formal.rating,'good');
    assert.equal(original.formal.eventId,accepted.record.event.eventId);
    assert.equal(original.formal.coreHash,accepted.record.event.coreHash);
    const before=await page.evaluate(id=>window.__dashboardProbe.recordDelivery(id),original.formal.eventId);
    assert.equal(before.recordCloud,'pending');assert.deepEqual(before.record,accepted.record);
    const records=(await account.client.load()).records;
    assert.equal(records.length,1);assert.deepEqual(records[0].record,accepted.record);
    await page.screenshot({path:resolve(out,'formal-receipt-lost-'+width+'.png'),fullPage:true});
    blocked=false;
    await page.reload();await page.waitForLoadState('networkidle');
    const after=await waitForReadback(()=>page.evaluate(id=>window.__dashboardProbe.recordDelivery(id),original.formal.eventId),
      value=>value.recordCloud==='acked',{label:'Actual formal cloud acknowledgment'});
    assert.deepEqual(after.record,accepted.record);
    assert.deepEqual(await page.evaluate(()=>window.__dashboardProbe.read()),[original]);
    assert.deepEqual((await account.client.load()).records,records);
    await waitForReadback(async()=>replayReceipts,rows=>rows.some(row=>
      row.eventId===original.formal.eventId&&row.receiptEventId===original.formal.eventId
      &&row.envelopeHash===accepted.record.envelopeHash&&row.status==='duplicate'&&row.durable===true),
      {label:'Browser formal duplicate receipt',timeoutMs:dropRecoveredReceipts?1500:15000});
    // Exact SDK replay is an API idempotency check, separate from the browser's recovery path.
    const duplicate=await account.client.appendRecords([accepted.record]);
    const entry=duplicate.results.find(row=>row.eventId===original.formal.eventId);
    assert.equal(entry.status,'duplicate');assert.equal(entry.durable,true);
    assert.equal(entry.receipt.envelopeHash,accepted.record.envelopeHash);
    assert.deepEqual((await account.client.load()).records,records);
    assert.deepEqual([...new Set(dispatches.map(row=>row.eventId))],[original.formal.eventId]);
    assert.deepEqual([...new Set(dispatches.map(row=>row.coreHash))],[original.formal.coreHash]);
    const status=await account.status();assert.equal(status.counts.records,1);assert.equal(status.counts.aiRequests,0);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:resolve(out,'formal-receipt-recovered-'+width+'.png'),fullPage:true});
    return {width,passed:true,rawAnswer:original.submitted,attemptId:original.id,formal:original.formal,
      acceptedBeforeAbort:true,beforeCloud:before.recordCloud,afterCloud:after.recordCloud,
      dispatches,browserReplayReceipts:replayReceipts,exactSdkReplayStatus:entry.status,
      officialRecords:1,originalRecordUnchanged:true,body:await page.locator('body').innerText(),errors,status};
  } finally {await context.unroute('**/api/account-study**');}
}
