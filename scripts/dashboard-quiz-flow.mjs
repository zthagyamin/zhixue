import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createAccountAttemptClient} from '../src/infrastructure/learning-attempt/index.ts';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';
import {waitForReadback} from './readback-observation.mjs';

/** Actual option controls, remediation and account writer; no grading callback substitutes. */
export async function runDashboardQuizFlow({page,account,width,variant,theme,out,errors,origin}) {
  const read=()=>page.evaluate(()=>window.__dashboardProbe.readAll());
  const firstOnly=rows=>rows.filter(row=>row.mode==='quiz'&&row.purpose==='first');
  const select=async ids=>{
    const labels={A:'这个实验中验证误差降低',B:'结论依赖报告所控制的训练条件',C:'dropout 在所有模型上一定改善验证误差'};
    for(const id of ids)await page.getByRole('button',{name:new RegExp(labels[id])}).click();
  };
  const initial=variant==='correct'?['A','B']:variant==='partial'?['A']:['C'];
  await select(initial);
  await page.getByRole('button',{name:'提交答案',exact:true}).dblclick();
  const outcome=variant==='correct'?'correct':variant==='partial'?'partial':'incorrect';
  await page.getByRole('heading',{name:variant==='correct'?'回答正确':variant==='partial'?'部分正确':'这次需要复习',exact:true}).waitFor();
  let rows=await waitForReadback(read,values=>firstOnly(values).length===1&&firstOnly(values)[0].evaluation.status==='resolved',
    {label:'Quiz first response durable'});
  const original=firstOnly(rows)[0];
  assert.equal(original.submitted.answer,JSON.stringify(initial));
  assert.equal(original.evaluation.outcome,outcome);assert.equal(original.evaluation.correct,variant==='correct');
  assert.equal(original.formal,null);assert.equal((await account.status()).counts.records,0);
  const immutable=row=>({id:row.id,submitted:row.submitted,evaluation:row.evaluation});
  let child=null;
  if(variant!=='correct'){
    const feedback=page.getByRole('region',{name:'作答反馈',exact:true});
    assert.match(await feedback.innerText(),variant==='partial'?/漏选：结论依赖报告所控制的训练条件/:/错选：dropout/);
    await page.getByRole('button',{name:'收起解释，再试一次',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'作答反馈',exact:true}).count(),0);
    assert.equal(await page.getByText('完整参考答案',{exact:true}).count(),0);
    await select(['A','B']);await page.getByRole('button',{name:'核对这次补练',exact:true}).dblclick();
    await page.getByRole('heading',{name:'回答正确',exact:true}).waitFor();
    await page.getByText('本次是辅助补练；首轮仍需复习，原结果保持不变。',{exact:true}).waitFor();
    rows=await waitForReadback(read,values=>values.filter(row=>row.mode==='quiz'&&row.purpose==='remediation'&&row.evaluation.status==='resolved').length===1,
      {label:'Quiz remediation durable'});
    child=rows.find(row=>row.mode==='quiz'&&row.purpose==='remediation');
    assert.equal(child.parent,original.id);assert.equal(child.submitted.answer,'["A","B"]');
    assert.equal(child.submitted.assistance,'observed');assert.equal(child.evaluation.outcome,'correct');assert.equal(child.formal,null);
    assert.deepEqual(immutable(firstOnly(rows)[0]),immutable(original));
    assert.equal(firstOnly(rows)[0].formal,null);assert.equal((await account.status()).counts.records,0);
  }
  await page.screenshot({path:resolve(out,`quiz-${variant}-feedback-${theme}-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:variant==='correct'?'继续':'跳过补练或结束补练，继续',exact:true}).dblclick();
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  rows=await waitForReadback(read,values=>firstOnly(values)[0]?.formal?.status==='linked'&&firstOnly(values)[0].traversed,
    {label:'Quiz formal and traversal durable'});
  const first=firstOnly(rows)[0];assert.equal(firstOnly(rows).length,1);assert.deepEqual(immutable(first),immutable(original));
  assert.equal(first.formal.rating,variant==='correct'?'good':variant==='partial'?'hard':'again');
  if(child)assert.deepEqual(rows.find(row=>row.id===child.id),child);
  const loaded=await account.client.load(),records=loaded.records;
  assert.equal(records.length,1);assert.equal(records[0].record.event.eventId,first.formal.eventId);
  assert.equal(records[0].record.event.attempt.correct,variant==='correct');
  assert.equal(records[0].record.event.attempt.rating,first.formal.rating);
  const plan=(await account.client.getPlanState(account.day)).approvedPlan;
  const catalog=loaded.catalogs.find(row=>row.catalogHash===plan.catalogHash);
  const activity=await accountTaskActivity(plan,catalog,loaded.bundles,records);
  assert.deepEqual(activity.completedTaskIds,variant==='correct'?plan.tasks.map(task=>task.taskId):[]);
  const client=createAccountAttemptClient({ownerId:account.userId,libraryId:'library-a',
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init.headers,Origin:origin}}))});
  const remote=await client.read(first.id);assert.deepEqual(remote.submitted,original.submitted);
  assert.deepEqual(remote.evaluation,original.evaluation);assert.equal(remote.formal.eventId,first.formal.eventId);
  if(child){const stored=await client.read(child.id);assert.equal(stored.parentAttemptId,first.id);
    assert.equal(stored.submitted.answer,'["A","B"]');assert.equal(stored.evaluation.outcome,'correct');assert.equal(stored.formal,null);}
  await page.getByRole('button',{name:'返回今日',exact:true}).click();
  await page.reload();await page.waitForLoadState('networkidle');
  assert.deepEqual(immutable(firstOnly(await read())[0]),immutable(original));
  assert.deepEqual((await account.client.load()).records,records);
  const status=await account.status();assert.equal(status.counts.records,1);assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
  assert.equal(await page.locator('.dark').count()>0,theme==='dark','Actual theme survives explicit reload');
  await page.screenshot({path:resolve(out,`quiz-${variant}-refreshed-${theme}-${width}.png`),fullPage:true});
  return {width,variant,theme,passed:true,firstOutcome:outcome,firstRaw:original.submitted.answer,firstFormal:first.formal,
    remediation:child?{id:child.id,parent:child.parent,outcome:child.evaluation.outcome,formal:null}:null,
    remoteFirstAndChildVerified:true,officialRecords:1,completedTaskIds:activity.completedTaskIds,body:await page.locator('body').innerText(),errors,status};
}
