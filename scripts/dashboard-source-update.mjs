import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {waitForReadback} from './readback-observation.mjs';

/** Same owner/library/item key, different actual published source and approved plan. */
export async function runDashboardSourceUpdate({page,context,account,width,out,errors}) {
  const oldLoaded=await account.client.load(),oldItem=oldLoaded.bundle.items[0];
  const input=page.getByRole('textbox',{name:'你的答案'});await input.fill(' 4 ');
  let held,release,delivery=null,finished;
  const gate=new Promise(resolve=>{release=resolve;});
  const done=new Promise(resolve=>{finished=resolve;});
  await context.route('**/api/account-study**',async route=>{
    const request=route.request();
    if(request.method()!=='POST'||request.postDataJSON()?.action!=='math-evaluate')return route.continue();
    try {
      const response=await route.fetch();held={status:response.status(),body:await response.json()};await gate;
      try{await route.fulfill({response});delivery='route-fulfilled';}catch{delivery='client-aborted';}
    } finally {finished();}
  });
  try {
    await page.getByRole('button',{name:'提交',exact:true}).click();
    await waitForReadback(async()=>held,value=>Boolean(value),{label:'Old source actual response'});
    assert.equal(held.status,200);assert.equal(held.body.final.status,'correct');assert.equal(held.body.sourceVersion,oldItem.contentHash);
    const original=(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.contentHash===oldItem.contentHash);
    assert.equal(original.submitted,' 4 ');assert.equal(original.formal,null);
    const body=structuredClone(oldItem);delete body.contentHash;
    body.title='基线 · 数学：版本 2（x = 2）';
    body.sourceHash='b'.repeat(64);body.practice={...body.practice,prompt:'实数 x = 2。求 (x + 1)^2 的最终数值。',answer:'9',
      explanation:'(x + 1)^2 = x^2 + 2x + 1；x = 2 时为 4 + 4 + 1 = 9。'};
    const updated=await account.reviseMaterial(body);
    assert.equal(updated.item.itemKey,oldItem.itemKey);assert.notEqual(updated.item.contentHash,oldItem.contentHash);
    await page.getByRole('button',{name:'返回今日',exact:true}).click();
    await page.getByText('资料与同步详情',{exact:true}).click();
    await page.locator('.study-account-read-note').getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByText('下一组：'+body.title,{exact:true}).waitFor();
    const start=page.getByRole('region',{name:'今日自测入口'}).getByRole('button',{name:/^(开始下一项|继续今日任务)$/});
    await waitForReadback(()=>start.isEnabled(),ready=>ready,{label:'Updated source task entry'});
    await start.click();await input.waitFor();
    await page.getByText(body.practice.prompt,{exact:true}).waitFor();
    assert.equal(await input.inputValue(),'');
    release();await done;await context.unroute('**/api/account-study**');await page.waitForLoadState('networkidle');
    assert.equal(await input.inputValue(),'');
    assert.equal(await page.getByText('最终结果与来源参考一致。',{exact:true}).count(),0);
    let rows=await page.evaluate(()=>window.__dashboardProbe.read());
    assert.deepEqual(rows.filter(row=>row.contentHash===oldItem.contentHash),[original]);
    const fresh=rows.filter(row=>row.contentHash===updated.item.contentHash);assert.equal(fresh.length,1);
    assert.notEqual(fresh[0].id,original.id);assert.equal(fresh[0].submitted,null);
    assert.equal((await account.status()).counts.records,0);
    await page.screenshot({path:resolve(out,'new-source-empty-'+width+'.png'),fullPage:true});
    await input.fill(' 4 ');await page.getByRole('button',{name:'提交',exact:true}).click();
    const resolved=await waitForReadback(()=>page.evaluate(()=>window.__dashboardProbe.read()),
      values=>values.some(row=>row.id===fresh[0].id&&row.formal?.status==='linked'&&row.evaluation==='resolved'),
      {label:'New reference actual wrong-answer result'}).then(values=>values.find(row=>row.id===fresh[0].id));
    assert.equal(resolved.formal.rating,'again');assert.equal(resolved.contentHash,updated.item.contentHash);
    const status=await waitForReadback(()=>account.status(),value=>value.recordCounts['calculation:again']===1,
      {label:'Version-two formal receipt'});
    const records=(await account.client.load()).records;assert.equal(records.length,1);
    assert.equal(records[0].record.contentHash,updated.item.contentHash);
    assert.equal(records[0].record.snapshotId,updated.snapshot.snapshotId);
    assert.equal(records[0].record.event.eventId,resolved.formal.eventId);
    rows=await page.evaluate(()=>window.__dashboardProbe.read());
    assert.deepEqual(rows.filter(row=>row.contentHash===oldItem.contentHash),[original]);
    assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
    const solution=page.locator('details').filter({has:page.getByText('查看题目完整解法',{exact:true})});
    await solution.locator('summary').click();
    await solution.getByText(body.practice.explanation,{exact:true}).waitFor();
    assert.equal(await solution.getByText(oldItem.practice.explanation,{exact:true}).count(),0);
    await page.screenshot({path:resolve(out,'new-reference-wrong-'+width+'.png'),fullPage:true});
    return {width,passed:true,sameItemKey:true,oldHash:oldItem.contentHash,newHash:updated.item.contentHash,
      oldAnswerPreserved:true,newInputInitiallyEmpty:true,oldFeedbackAbsent:true,newAnswerAgainstNewReference:'again',
      oldFormal:null,newFormal:resolved.formal,officialRecords:1,newSolutionVerified:true,delivery,body:await page.locator('body').innerText(),errors,status};
  } finally {release();await context.unroute('**/api/account-study**');}
}
