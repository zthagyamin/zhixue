import assert from 'node:assert/strict';
import {resolve} from 'node:path';

/** Actual Dashboard and SourcesView with the isolated account handler. */
export async function runDashboardUxNavigation({page,account,width,out,errors,requests,todayStart}) {
  const before=await account.status(),priorPosts=requests.filter(row=>row.method==='POST').length;
  const opener=page.getByRole('button',{name:'查看同步详情',exact:true});
  await opener.waitFor();await opener.click();
  const dialog=page.getByRole('dialog',{name:'同步与记录'});await dialog.waitFor();
  await page.waitForFunction(()=>document.activeElement?.id==='study-sync-details');
  await dialog.getByText('检查与发送记录是两个独立操作。',{exact:false}).waitFor();
  await dialog.getByText('检查这台设备、账号与本地资料助手收到的学习记录；这里只检查，不会修改记录',{exact:true}).waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await opener.evaluate(node=>document.activeElement===node),true,'Escape returns focus to the original sync entry');
  assert.equal(requests.filter(row=>row.method==='POST').length,priorPosts,'Opening details sends no account mutation');
  let after=await account.status();assert.equal(after.counts.records,before.counts.records);assert.equal(after.counts.aiRequests,before.counts.aiRequests);
  await todayStart.click();await page.getByRole('textbox',{name:'你的答案'}).waitFor({timeout:30000});
  after=await account.status();assert.equal(after.counts.records,before.counts.records);assert.equal(after.counts.aiRequests,before.counts.aiRequests);assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(out,'ux-navigation-'+width+'.png'),fullPage:true});
  return {width,focusTarget:'study-sync-details',returnedToOpener:true,practiceInputReachable:true,recordCount:after.counts.records,aiRequests:after.counts.aiRequests};
}
