import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createAccountAttemptClient} from '../src/infrastructure/learning-attempt/index.ts';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';
import {waitForReadback} from './readback-observation.mjs';

/** Oral self-assessment stores the chosen rating, never a fabricated written answer. */
export async function runDashboardFlashcardFlow({page,account,width,variant,theme,out,errors,origin}) {
  const read=()=>page.evaluate(()=>window.__dashboardProbe.readAll());
  const firstRows=rows=>rows.filter(row=>row.mode==='flashcard'&&row.purpose==='first');
  const frozen=row=>({id:row.id,parent:row.parent,submitted:row.submitted,evaluation:row.evaluation,formal:row.formal});
  const loadedBefore=await account.client.load(),item=loadedBefore.bundle.items[0];
  const labels={again:'忘记',hard:'困难',good:'良好',easy:'极易'};
  const expectedOutcome=variant==='again'?'incorrect':variant==='hard'?'partial':'correct';
  await page.getByRole('button',{name:/^显示答案/}).click();
  await page.getByRole('button',{name:'忘记',exact:true}).waitFor();
  assert.match(await page.locator('.study-flashcard-body').innerText(),/信息泄漏让评估样本影响了待评估系统/);
  let rows=await read();const opened=firstRows(rows)[0];assert.ok(opened);assert.equal(opened.submitted,null);
  assert.equal(opened.formal,null);assert.equal((await account.status()).counts.records,0);
  await page.getByRole('button',{name:'暂停并保存',exact:true}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  await page.reload();await page.waitForLoadState('networkidle');
  await page.getByRole('region',{name:'今日自测入口'}).getByRole('button',{name:/^(开始下一项|继续今日任务)$/}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).click();
  await page.getByRole('button',{name:'忘记',exact:true}).waitFor();
  assert.match(await page.locator('.study-flashcard-body').innerText(),/信息泄漏让评估样本影响了待评估系统/);
  rows=await read();assert.equal(firstRows(rows).length,1);assert.equal(firstRows(rows)[0].id,opened.id);
  assert.equal(firstRows(rows)[0].submitted,null);assert.equal((await account.status()).counts.records,0);
  await page.screenshot({path:resolve(out,`flashcard-recovered-${variant}-${theme}-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:labels[variant],exact:true}).dblclick();
  rows=await waitForReadback(read,values=>firstRows(values)[0]?.formal?.status==='linked',
    {label:'Flashcard first formal durable'});
  const original=firstRows(rows)[0];
  assert.equal(original.submitted.answer,'');assert.equal(original.evaluation.source,'self-assess');
  assert.equal(original.evaluation.outcome,expectedOutcome);assert.equal(original.evaluation.rating,variant);
  assert.equal(original.formal.rating,variant);
  const recorded=await waitForReadback(()=>account.client.load(),value=>value.records.length===1,
    {label:'Flashcard account record durable'});
  const records=recorded.records;
  assert.equal(records.length,1);assert.equal(records[0].record.event.eventId,original.formal.eventId);
  assert.equal(records[0].record.event.attempt.rating,variant);
  assert.equal(records[0].record.event.attempt.correct,['good','easy'].includes(variant));
  let child=null;
  if(variant==='again'){
    await page.getByRole('button',{name:'收起解释，再回忆一次',exact:true}).click();
    await page.getByRole('button',{name:/^显示答案/}).waitFor();
    assert.doesNotMatch(await page.locator('.study-flashcard-body').innerText(),/信息泄漏让评估样本影响了待评估系统/);
    assert.equal(await page.getByRole('region',{name:'闪卡自评反馈',exact:true}).count(),0);
    await page.getByRole('button',{name:/^显示答案/}).click();
    await page.getByRole('button',{name:'良好',exact:true}).dblclick();
    await page.getByText('这是辅助补练，首轮自评保持不变。',{exact:true}).waitFor();
    rows=await waitForReadback(read,values=>values.some(row=>row.mode==='flashcard'&&row.purpose==='remediation'&&row.evaluation.status==='resolved'),
      {label:'Flashcard remediation durable'});
    child=rows.find(row=>row.mode==='flashcard'&&row.purpose==='remediation');
    assert.equal(child.parent,original.id);assert.equal(child.submitted.answer,'');
    assert.equal(child.evaluation.source,'self-assess');assert.equal(child.evaluation.rating,'good');assert.equal(child.formal,null);
    assert.deepEqual(frozen(firstRows(rows)[0]),frozen(original));assert.deepEqual((await account.client.load()).records,records);
  }
  await page.screenshot({path:resolve(out,`flashcard-rated-${variant}-${theme}-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:child?'结束补练，继续':'继续',exact:true}).dblclick();
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  rows=await waitForReadback(read,values=>firstRows(values)[0]?.traversed,{label:'Flashcard traversal durable'});
  assert.equal(firstRows(rows).length,1);assert.deepEqual(frozen(firstRows(rows)[0]),frozen(original));
  if(child)assert.deepEqual(frozen(rows.find(row=>row.id===child.id)),frozen(child));
  const current=await account.client.load(),plan=(await account.client.getPlanState(account.day)).approvedPlan;
  assert.deepEqual(current.records,records);
  const catalog=current.catalogs.find(row=>row.catalogHash===plan.catalogHash);
  const activity=await accountTaskActivity(plan,catalog,current.bundles,records);
  assert.deepEqual(activity.completedTaskIds,['good','easy'].includes(variant)?plan.tasks.map(task=>task.taskId):[]);
  const client=createAccountAttemptClient({ownerId:account.userId,libraryId:'library-a',
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init.headers,Origin:origin}}))});
  const remote=await client.read(original.id);assert.deepEqual(remote.submitted,original.submitted);
  assert.deepEqual(remote.evaluation,original.evaluation);assert.equal(remote.formal.eventId,original.formal.eventId);
  if(child){const saved=await client.read(child.id);assert.equal(saved.parentAttemptId,original.id);
    assert.equal(saved.evaluation.rating,'good');assert.equal(saved.formal,null);}
  await page.getByRole('button',{name:'返回今日',exact:true}).click();
  await page.reload();await page.waitForLoadState('networkidle');
  rows=await read();assert.equal(firstRows(rows).length,1);assert.deepEqual(frozen(firstRows(rows)[0]),frozen(original));
  if(child)assert.deepEqual(frozen(rows.find(row=>row.id===child.id)),frozen(child));
  assert.deepEqual((await account.client.load()).records,records);
  const status=await account.status();assert.equal(status.counts.records,1);assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
  assert.equal(await page.locator('html.dark').count()>0,theme==='dark');
  await page.screenshot({path:resolve(out,`flashcard-refreshed-${variant}-${theme}-${width}.png`),fullPage:true});
  return {width,variant,theme,passed:true,firstAnswer:'',answerMeaning:'No collected typed oral recall; not copied from the reference',
    contentHash:item.contentHash,sourceHash:item.sourceHash,firstOutcome:expectedOutcome,firstFormal:original.formal,pauseRefreshRevealedPreserved:true,
    skippedRemediation:variant==='hard',remediation:child?{id:child.id,parent:child.parent,rating:'good',formal:null}:null,
    firstAndChildRefreshPreserved:true,remoteReadback:true,officialRecords:1,completedTaskIds:activity.completedTaskIds,
    body:await page.locator('body').innerText(),errors,status};
}
