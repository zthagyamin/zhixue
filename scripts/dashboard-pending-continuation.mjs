import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';
import {waitForReadback} from './readback-observation.mjs';

/** Finishing traversal cannot turn an unknown answer into a graded task completion. */
export async function runDashboardPendingContinuation({page,account,width,out,previous,errors}) {
  const read=async()=>{
    const rows=await page.evaluate(()=>window.__dashboardProbe.read());
    assert.equal(rows.length,1,'Pending recovery must not create another mathematical first attempt');
    assert.equal(rows[0].id,previous.attemptId);
    return rows[0];
  };
  const original=await read();
  assert.equal(original.submitted,previous.rawAnswer);assert.equal(original.evaluation,'pending');assert.equal(original.formal,null);
  const plan=(await account.client.getPlanState(account.day)).approvedPlan;
  assert.equal(plan.tasks.length,1);
  assert.equal(plan.tasks[0].completionRule,'graded-practice');
  async function activity() {
    const loaded=await account.client.load();
    assert.deepEqual(loaded.records,[]);
    const catalog=loaded.catalogs.find(row=>row.catalogHash===plan.catalogHash);
    return accountTaskActivity(plan,catalog,loaded.bundles,loaded.records);
  }
  assert.deepEqual((await activity()).completedTaskIds,[]);
  await page.getByRole('button',{name:'保留待核对结果，继续',exact:true}).dblclick();
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  const summary=page.getByText('已练 0 / 1 · 待巩固 0 · 待核对 1',{exact:true});
  await summary.waitFor();
  assert.equal(await page.getByRole('textbox',{name:'你的答案'}).count(),0);
  assert.deepEqual(await read(),original);
  assert.deepEqual((await activity()).completedTaskIds,[]);
  const roundSummary=await summary.innerText();
  await page.screenshot({path:resolve(out,'pending-round-ended-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'恢复待核对的 1 份原答案',exact:true}).click();
  const input=page.getByRole('textbox',{name:'你的答案'});await input.waitFor();
  assert.equal(await input.inputValue(),previous.rawAnswer);
  assert.deepEqual(await read(),original);
  assert.deepEqual((await activity()).completedTaskIds,[]);
  await page.getByRole('button',{name:'返回今日',exact:true}).click();
  const start=page.getByRole('region',{name:'今日自测入口'}).getByRole('button',{name:/^(开始下一项|继续今日任务)$/});
  await start.waitFor();
  await waitForReadback(()=>start.isEnabled(),ready=>ready,{label:'Today entry after pending restore'});
  await page.reload();await page.waitForLoadState('networkidle');
  await start.waitFor();
  await waitForReadback(()=>start.isEnabled(),ready=>ready,{label:'Today entry after pending refresh'});
  assert.deepEqual((await activity()).completedTaskIds,[]);
  await start.click();await input.waitFor();
  assert.equal(await input.inputValue(),previous.rawAnswer);
  assert.deepEqual(await read(),original);
  const status=await account.status();
  assert.equal(status.counts.records,0);assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(out,'pending-restored-refreshed-'+width+'.png'),fullPage:true});
  return {...previous,pendingContinuation:{nativeDoubleClickContinue:true,roundSummary,
    restoredSameFirstAttempt:true,refreshRestoredSameAnswer:true,formalTaskCompleted:false,todayStartEnabled:true},
    status,body:await page.locator('body').innerText()};
}
