import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {waitForReadback} from './readback-observation.mjs';

/** Use normal source refresh/recovery controls after a synthetic server identity/profile change. */
export async function runDashboardScopeSwitch({page,context,account,activate,variant,width,out,errors}) {
  const oldLoaded=await account.client.load();
  const oldScope={ownerId:account.userId,libraryId:oldLoaded.bundle.snapshot.libraryId};
  const read=scope=>page.evaluate(scope=>window.__dashboardProbe.readScope(scope),scope);
  const input=page.getByRole('textbox',{name:'你的答案'});await input.fill(' 4 ');
  let release,held,delivery=null,finished;
  const gate=new Promise(resolve=>{release=resolve;});
  const done=new Promise(resolve=>{finished=resolve;});
  await context.route('**/api/account-study**',async route=>{
    const request=route.request();
    if(request.method()!=='POST'||request.postDataJSON()?.action!=='math-evaluate')return route.continue();
    try {
      const response=await route.fetch();held={status:response.status(),body:await response.json()};
      await gate;
      try{await route.fulfill({response});delivery='route-fulfilled';}catch{delivery='client-aborted';}
    } finally {finished();}
  });
  try {
    await page.getByRole('button',{name:'提交',exact:true}).click();
    await waitForReadback(async()=>held,value=>Boolean(value),{label:'Original scope real math response'});
    assert.equal(held.status,200);assert.equal(held.body.final.status,'correct');
    const original=(await read(oldScope))[0];
    assert.equal(original.submitted,' 4 ');assert.equal(original.evaluation,'pending');assert.equal(original.formal,null);
    assert.equal(held.body.attemptId,original.id);
    await page.getByRole('button',{name:'返回今日',exact:true}).click();
    await page.getByRole('button',{name:/^(开始|继续)今日自测$/}).waitFor();
    const next=await activate(variant==='owner'?{ownerTag:'owner-b'}:{libraryId:'library-b'});
    const nextLoaded=await next.client.load(),nextScope={ownerId:next.userId,libraryId:nextLoaded.bundle.snapshot.libraryId};
    assert.equal(nextLoaded.bundle.items[0].itemKey,oldLoaded.bundle.items[0].itemKey);
    assert.equal(nextLoaded.bundle.items[0].contentHash,oldLoaded.bundle.items[0].contentHash);
    if(variant==='owner')assert.notEqual(nextScope.ownerId,oldScope.ownerId);
    else{assert.equal(nextScope.ownerId,oldScope.ownerId);assert.notEqual(nextScope.libraryId,oldScope.libraryId);}
    await page.getByText('资料与同步详情',{exact:true}).click();
    await page.locator('.study-account-read-note').getByRole('button',{name:'刷新',exact:true}).click();
    if(variant==='owner'){
      await page.getByRole('heading',{name:'暂时无法确认账号',exact:true}).waitFor();
      assert.equal(await input.count(),0);
      await page.getByRole('button',{name:'重新检查',exact:true}).click();
    } else {
      await page.getByRole('button',{name:'确认学习库',exact:true}).click();
      await page.getByRole('button',{name:'使用账号当前关联的学习库',exact:true}).click();
      await page.getByRole('button',{name:'今日',exact:true}).click();
    }
    const start=page.getByRole('button',{name:/^(开始|继续)今日自测$/});
    await start.waitFor();await waitForReadback(()=>start.isEnabled(),ready=>ready,{label:'New scope task entry'});
    release();await done;
    await start.click();await input.waitFor();
    await writeFile(resolve(out,'scope-observation-'+variant+'-'+width+'.json'),JSON.stringify({oldScope,nextScope,
      oldRows:await read(oldScope),newRows:await read(nextScope),input:await input.inputValue(),delivery},null,2));
    assert.equal(await input.inputValue(),'');
    assert.equal(await page.getByText('最终结果与来源参考一致。',{exact:true}).count(),0);
    const newRows=await read(nextScope);assert.equal(newRows.length,1);
    assert.equal(newRows[0].submitted,null);assert.equal(newRows[0].answer,'');assert.equal(newRows[0].formal,null);
    assert.notEqual(newRows[0].id,original.id);
    assert.deepEqual(await read(oldScope),[original]);
    const oldStatus=await account.status(),newStatus=await next.status();
    assert.equal(oldStatus.counts.records,0);assert.equal(newStatus.counts.records,0);
    assert.equal(oldStatus.counts.aiRequests,0);assert.equal(newStatus.counts.aiRequests,0);assert.deepEqual(errors,[]);
    await page.screenshot({path:resolve(out,variant+'-isolated-'+width+'.png'),fullPage:true});
    return {width,variant,passed:true,oldScope,nextScope,sameItemAndHash:true,oldAnswerPreserved:true,
      newInputEmpty:true,oldFeedbackAbsent:true,officialRecords:0,delivery,body:await page.locator('body').innerText(),errors};
  } finally {release();await context.unroute('**/api/account-study**');}
}
