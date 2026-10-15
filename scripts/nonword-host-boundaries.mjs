import assert from 'node:assert/strict';
import {resolve} from 'node:path';

/** Synthetic bindings consumed only by the owned browser fixture. */
export const boundarySetup = `
const alternate={questionType:'calculation',prompt:'计算 $1/4$ 的数值。',answer:'0.25',explanation:'分子除以分母。'};
const revised={questionType:'calculation',prompt:'计算 $3/4$ 的数值。',answer:'0.75',explanation:'新版来源条件。'};
bindings.push(
 {scope:{...scope,itemKey:scope.itemKey+'-other',contentHash:await attemptFingerprint(alternate)},original:alternate},
 {scope:{...scope,contentHash:await attemptFingerprint(revised)},original:revised}
);
for(const entry of bindings.slice(1)){
 entry.data={...entry.original,id:entry.scope.itemKey,itemId:entry.scope.itemKey,contentHash:entry.scope.contentHash};
 entry.draft=store.adapter(learningDraftItemId('synthetic-subject',entry.scope.itemKey,entry.data),'calculation:1','合成计算题');
}
window.__host.readBound=async(index)=>{const b=bindings[index].scope;
 const all=await repository.list();const row=all.find(row=>row.binding.itemKey===b.itemKey&&row.binding.contentHash===b.contentHash
  &&row.checkpoint.purpose==='first'&&row.checkpoint.mode==='calculation');
 return row?{answer:row.answer,submitted:row.submitted?.answer??null,evaluation:row.evaluation.status,formal:row.formal,
  paused:row.checkpoint.view?.paused??false,traversed:row.checkpoint.traversed??false}:null;
};
`;

/** Real IndexedDB failure and mounted host switches; no production or model writes. */
export async function runBoundaryScenario({page,origin,width,evidence,errors}){
  await page.goto(origin);const input=page.getByRole('textbox',{name:'你的答案'});await input.waitFor();
  await page.evaluate(()=>{
   const original=IDBDatabase.prototype.transaction;
   window.__host.failWrites=true;
   IDBDatabase.prototype.transaction=function(...args){
    const tx=original.apply(this,args);
    if(this.name==='zhixue-learning-attempts-v1'&&args[1]==='readwrite'&&window.__host.failWrites)
     queueMicrotask(()=>{try{tx.abort();}catch{/* A transaction already completed or aborted cannot be aborted twice. */}});
    return tx;
   };
  });
  await input.fill(' 1/2 ');await page.getByRole('button',{name:'提交',exact:true}).click();
  await page.getByText('保存失败，当前输入保留。',{exact:false}).waitFor();
  assert.equal(await input.inputValue(),' 1/2 ');
  assert.equal(await page.getByText('作答保存尚未完成，输入和核对结果已保留。',{exact:true}).count(),0);
  await page.getByText('作答未完成，当前输入保留。',{exact:true}).waitFor();
  const failed=await page.evaluate(()=>window.__host.readBound(0));
  assert.equal(failed.submitted,null);assert.equal(failed.formal,null);
  assert.deepEqual(await page.evaluate(()=>window.__host.requests),[]);
  assert.deepEqual(await page.evaluate(()=>window.__host.grades),[]);
  await page.screenshot({path:resolve(evidence,'save-failure-'+width+'.png'),fullPage:true});
  await page.evaluate(()=>{window.__host.failWrites=false;});
  await page.getByRole('button',{name:'提交',exact:true}).click();
  await page.getByText('首轮答案已保留 · 待核对',{exact:true}).waitFor();
  const before=await page.evaluate(()=>window.__host.readBound(0));assert.equal(before.submitted,' 1/2 ');
  await page.evaluate(()=>window.__host.select(1));await page.waitForFunction(value=>document.querySelector('h2')?.textContent?.includes(value),'1/4');
  await input.waitFor();assert.equal(await input.inputValue(),'');
  assert.equal(await page.getByText('首轮答案已保留 · 待核对',{exact:true}).count(),0);
  await input.fill('0.125');await page.getByRole('button',{name:'暂停并保存',exact:true}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.__host.readBound(1))).answer,'0.125');
  await page.evaluate(()=>window.__host.select(0));await page.waitForFunction(()=>document.querySelector('h2')?.textContent?.includes('1/2'));await input.waitFor();assert.equal(await input.inputValue(),' 1/2 ');
  assert.deepEqual(await page.evaluate(()=>window.__host.readBound(0)),before);
  await page.evaluate(()=>window.__host.select(2));await page.waitForFunction(value=>document.querySelector('h2')?.textContent?.includes(value),'3/4');
  await input.waitFor();assert.equal(await input.inputValue(),'');
  assert.equal(await page.getByText('首轮答案已保留 · 待核对',{exact:true}).count(),0);
  await input.fill('new-source-draft');await page.getByRole('button',{name:'暂停并保存',exact:true}).click();
  await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.__host.readBound(2))).answer,'new-source-draft');
  assert.equal((await page.evaluate(()=>window.__host.readBound(0))).submitted,' 1/2 ');
  assert.equal(await page.evaluate(()=>window.__host.moves),0);assert.deepEqual(await page.evaluate(()=>window.__host.grades),[]);
  assert.deepEqual(errors,[]);
  return {width,passed:true,failedWriteNoGrading:true,retryPreservesRawAnswer:true,differentItemIsolated:true,changedContentHashIsolated:true,oldAnswerRetained:true};
}
