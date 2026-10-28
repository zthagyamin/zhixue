import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';

/** Exercise normal result navigation; never call internal completion or grading callbacks. */
export async function runDashboardCompletion({page,account,width,out,previous,errors}) {
  const original=(await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.formal?.eventId===previous.currentFormal.eventId);
  assert.ok(original);
  const loaded=await account.client.load(),records=loaded.records;
  assert.equal(records.length,1);
  const plan=(await account.client.getPlanState(account.day)).approvedPlan;
  const catalog=loaded.catalogs.find(row=>row.catalogHash===plan.catalogHash);
  const activity=await accountTaskActivity(plan,catalog,loaded.bundles,records);
  assert.deepEqual(activity.completedTaskIds,plan.tasks.map(task=>task.taskId));
  await page.getByRole('button',{name:'继续',exact:true}).dblclick();
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  await page.getByText('已练 1 / 1 · 待巩固 0',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'你的答案'}).count(),0);
  assert.deepEqual((await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===original.id),original);
  assert.deepEqual((await account.client.load()).records,records);
  await page.screenshot({path:resolve(out,'round-complete-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'返回今日',exact:true}).click();
  const finished=page.getByRole('heading',{name:/^(今日这一轮已结束|当前没有待自测任务)$/});
  await finished.waitFor();
  const start=page.getByRole('region',{name:'今日自测入口'}).getByRole('button',{name:'开始下一项',exact:true});
  assert.equal(await start.isDisabled(),true);
  const todayBeforeReload=await page.locator('body').innerText();
  const headingBeforeReload=await finished.innerText();
  await page.reload();await page.waitForLoadState('networkidle');
  await finished.waitFor();
  assert.equal(await start.isDisabled(),true);
  assert.deepEqual((await page.evaluate(()=>window.__dashboardProbe.read())).find(row=>row.id===original.id),original);
  assert.deepEqual((await account.client.load()).records,records);
  const refreshed=await account.client.load();
  assert.deepEqual(await accountTaskActivity(plan,catalog,refreshed.bundles,refreshed.records),activity);
  const status=await account.status();
  assert.equal(status.counts.records,1);assert.equal(status.counts.aiRequests,0);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(out,'today-complete-refreshed-'+width+'.png'),fullPage:true});
  return {...previous,completion:{nativeDoubleClickContinue:true,roundPracticed:1,needsReview:0,
    todayStartDisabled:true,refreshCompletionPreserved:true,answerAndFormalUnchanged:true,officialRecords:1,
    completedTaskIds:activity.completedTaskIds,headingBeforeReload,headingAfterReload:await finished.innerText(),
    todayBeforeReload},body:await page.locator('body').innerText(),status};
}
