import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createNonwordAccount} from '../tests/fixtures/nonword-baseline-preview.mjs';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';
import {waitForReadback} from './readback-observation.mjs';

export async function createDashboardCodeAccount(options,variant){
  const seed=await createNonwordAccount({...options,scenario:'code-basic',stage3:true});
  if(variant==='retry')return seed;
  try{
    const body=structuredClone((await seed.client.load()).bundle.items[0]);delete body.contentHash;
    body.practice.initialCode=body.practice.solutionCode;
    if(variant==='test-error'){
      body.schemaVersion=1;delete body.learningSupport;
      body.practice.testCode='assert add(1, 2) == 3\nraise RuntimeError("Synthetic test script unavailable")';
      body.title='基线 · 编程：题目测试异常';
    }
    return await createNonwordAccount({...options,scenario:'code-basic',stage3:true,materialBody:body});
  }finally{seed.close();}
}

/** Normal local Python only. Real editor, opaque runtime, public checks, save and navigation. */
export async function runDashboardCodeFlow({page,account,width,variant,theme,out,errors}){
  const read=()=>page.evaluate(()=>window.__dashboardProbe.readAll());
  const firstRows=rows=>rows.filter(row=>row.mode==='code'&&row.purpose==='first');
  const stable=row=>({id:row.id,parent:row.parent,submitted:row.submitted,evaluation:row.evaluation,formal:row.formal});
  const item=(await account.client.load()).bundle.items[0];
  const run=page.getByRole('button',{name:/运行测试$/});
  const ready=()=>waitForReadback(async()=>await run.count()===1&&await run.isEnabled(),Boolean,{label:'Actual Python environment ready',timeoutMs:60000});
  await ready();await run.click();
  let rows=await waitForReadback(read,values=>Boolean(firstRows(values)[0]?.submitted)
    &&(firstRows(values)[0].evaluation.status==='resolved'||variant==='test-error'
      &&firstRows(values)[0].evaluation.status==='pending'&&firstRows(values)[0].evaluation.reason!=='not-requested'),
    {label:'Actual code first evaluation',timeoutMs:30000});
  let original=firstRows(rows)[0];assert.equal(original.submitted.answer,item.practice.initialCode);
  let child=null,records=[];
  if(variant==='test-error'){
    assert.equal(original.evaluation.status,'pending');assert.equal(original.formal,null);
    assert.match(original.evaluation.feedback,/Synthetic test script unavailable/);
    assert.match(original.evaluation.feedback,/<题目测试>/);
    assert.equal((await account.status()).counts.records,0);
    await page.getByRole('button',{name:'保留待核对结果，继续',exact:true}).click();
  }else{
    assert.equal(original.evaluation.status,'resolved');assert.equal(original.evaluation.source,'deterministic');
    assert.equal(original.evaluation.outcome,variant==='correct'?'correct':'incorrect');
    if(variant==='retry'){
      rows=await waitForReadback(read,values=>firstRows(values)[0]?.formal?.status==='linked',{label:'Code first failure formal durable'});
      original=firstRows(rows)[0];assert.equal(original.formal.rating,'again');
      const saved=await waitForReadback(()=>account.client.load(),value=>value.records.length===1,{label:'Code first failure account record'});
      records=saved.records;
      const failure=page.locator('[data-code-case="positive"]');await failure.waitFor();
      assert.match(await failure.innerText(),/输入/);assert.match(await failure.innerText(),/预期/);assert.match(await failure.innerText(),/实际/);
      assert.match(await failure.innerText(),/-1/);assert.match(await failure.innerText(),/3/);
      await failure.getByRole('button',{name:'小提示',exact:true}).click();
      await page.getByText('检查是否把第二个参数也加进了返回值。',{exact:true}).waitFor();
      await page.screenshot({path:resolve(out,`code-first-failure-${theme}-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'收起解释，再写一次',exact:true}).click();
      await page.getByRole('button',{name:'跳过本次补练，继续',exact:true}).waitFor();
      await waitForReadback(read,values=>values.some(row=>row.mode==='code'&&row.purpose==='remediation'&&row.parent===original.id&&!row.submitted),
        {label:'Actual active remediation copy opened'});
      const editor=page.locator('.cm-content[contenteditable="true"][aria-label="Python 代码编辑器"]');await editor.waitFor();
      await editor.click();await editor.press('Control+A');await page.keyboard.insertText(item.practice.solutionCode);
      await waitForReadback(read,values=>values.some(row=>row.mode==='code'&&row.purpose==='remediation'&&!row.submitted&&row.answer===item.practice.solutionCode),
        {label:'Actual correction saved in active remediation copy'});
      await ready();await run.click();
      rows=await waitForReadback(read,values=>values.some(row=>row.mode==='code'&&row.purpose==='remediation'&&row.evaluation.status==='resolved'),
        {label:'Code corrected child durable'});
      child=rows.find(row=>row.mode==='code'&&row.purpose==='remediation'&&row.evaluation.status==='resolved');
      assert.equal(child.parent,original.id);assert.equal(child.submitted.answer,item.practice.solutionCode);
      assert.equal(child.evaluation.outcome,'correct');assert.equal(child.formal,null);
      assert.deepEqual(stable(firstRows(rows)[0]),stable(original));assert.deepEqual((await account.client.load()).records,records);
      await page.getByText(/^公开测试通过/).first().waitFor();
      assert.match(await page.getByText(/^公开测试通过/).first().innerText(),/首轮仍需复习/);
      await page.screenshot({path:resolve(out,`code-corrected-${theme}-${width}.png`),fullPage:true});
    }else{
      assert.equal(original.formal,null);assert.equal((await account.status()).counts.records,0);
      await page.getByText(/^公开测试通过/).first().waitFor();
      await page.screenshot({path:resolve(out,`code-first-pass-${theme}-${width}.png`),fullPage:true});
    }
    await page.getByRole('button',{name:child?'结束补练，继续':'继续',exact:true}).dblclick();
  }
  await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
  rows=await waitForReadback(read,values=>firstRows(values)[0]?.traversed,{label:'Code explicit traversal durable'});
  assert.equal(firstRows(rows).length,1);const first=firstRows(rows)[0];
  assert.deepEqual(first.submitted,original.submitted);assert.deepEqual(first.evaluation,original.evaluation);
  if(variant==='correct')assert.equal(first.formal.rating,'good');else assert.deepEqual(first.formal,original.formal);
  const current=await waitForReadback(()=>account.client.load(),value=>value.records.length===(variant==='test-error'?0:1),{label:'Code final account records'});
  if(records.length)assert.deepEqual(current.records,records);records=current.records;
  if(records.length){assert.equal(records[0].record.event.eventId,first.formal.eventId);assert.equal(records[0].record.event.attempt.rating,variant==='correct'?'good':'again');}
  const plan=(await account.client.getPlanState(account.day)).approvedPlan,catalog=current.catalogs.find(row=>row.catalogHash===plan.catalogHash);
  const activity=await accountTaskActivity(plan,catalog,current.bundles,records);
  assert.deepEqual(activity.completedTaskIds,variant==='correct'?plan.tasks.map(task=>task.taskId):[]);
  await page.getByRole('button',{name:'返回今日',exact:true}).click();await page.reload();await page.waitForLoadState('networkidle');
  rows=await read();assert.deepEqual(stable(firstRows(rows)[0]),stable(first));
  if(child)assert.deepEqual(stable(rows.find(row=>row.id===child.id)),stable(child));
  assert.deepEqual((await account.client.load()).records,records);
  const status=await account.status();assert.equal(status.counts.aiRequests,0);assert.deepEqual(errors,[]);
  assert.equal(await page.locator('html.dark').count()>0,theme==='dark');
  await page.screenshot({path:resolve(out,`code-refreshed-${variant}-${theme}-${width}.png`),fullPage:true});
  return {width,variant,theme,passed:true,firstCode:first.submitted.answer,firstEvaluation:first.evaluation,firstFormal:first.formal,
    remediation:child?{id:child.id,parent:child.parent,code:child.submitted.answer,formal:null}:null,
    officialRecords:records.length,completedTaskIds:activity.completedTaskIds,body:await page.locator('body').innerText(),errors,status};
}
