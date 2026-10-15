import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {saveTrialMaterial,loadTrialMaterials,removeTrialMaterial} from '../app/saved-note-trials.ts';
import {exportTrialMaterialBackup,restoreTrialMaterialBackup} from '../app/trial-material-backup.ts';
import {readTrialMaterialBackup} from '../app/trial-material-backup-model.ts';
import {createHooks,loader,nodes,text,button} from './helpers/causal-harness.mjs';

const question=(id,prompt)=>({id,prompt,answer:'Original reference '+prompt,filename:'Synthetic.md',section:null,kind:'qa'});
async function restored(t,questions){
  const owner='trial-slot-'+t.name,library='synthetic-library';
  const original=await saveTrialMaterial(owner,library,'Synthetic','Restored material',questions);
  const backup=await exportTrialMaterialBackup(owner,library);
  await removeTrialMaterial(owner,library,original.id);
  assert.deepEqual(await readTrialMaterialBackup(backup,owner,library),[original]);
  assert.equal(await restoreTrialMaterialBackup(owner,library,backup),1);
  assert.deepEqual(await loadTrialMaterials(owner,library),[original]);
  const hooks=createHooks(),listeners=new Map(),window={confirm:()=>true,location:{hash:''},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
  const load=loader(hooks.api,{'app/saved-trial-materials.tsx':{SavedTrialMaterials:()=>null}},window);
  const Trial=load('app/note-trial.tsx').NoteTrial;
  const oldAnimation=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();
  t.after(()=>{hooks.unmount();if(oldAnimation)globalThis.requestAnimationFrame=oldAnimation;else delete globalThis.requestAnimationFrame;});
  const render=()=>{hooks.render();hooks.flush();hooks.render();};
  hooks.mount(Trial,{owner,library,onConnect(){}});render();
  const open=next=>{listeners.get('zhixue:trial-material-open')({detail:{owner,library,questions:next}});render();};
  const click=label=>{const node=button(hooks.view(),label);assert.ok(node,'button '+label);node.props.onClick();render();};
  open(original.questions);
  return {hooks,render,open,click,view:hooks.view,original,async preserved(){assert.deepEqual(await loadTrialMaterials(owner,library),[original]);assert.deepEqual(await exportTrialMaterialBackup(owner,library),backup);}};
}

for(const id of ['duplicate',''])test('restored '+JSON.stringify(id)+' question IDs remain playable and unchanged',async t=>{
  const f=await restored(t,[question(id,'First'),question(id,'Second')]);
  f.click('查看原文并自评');f.click('已能回忆，继续下一题');
  assert.match(text(f.view()),/Second/);
  f.click('查看原文并自评');f.click('已能回忆，完成本轮');
  assert.match(text(f.view()),/已完成 2 道笔记试学/);await f.preserved();
});

for(const retrySlot of [0,1])test('only explicitly marked duplicate-ID slot '+retrySlot+' enters retry',async t=>{
  const f=await restored(t,[question('same','First'),question('same','Second')]);
  for(let index=0;index<2;index++){
    f.click('查看原文并自评');f.click(index===retrySlot?'仍不熟悉，标记再练':index===1?'已能回忆，完成本轮':'已能回忆，继续下一题');
  }
  assert.match(text(f.view()),/还有 1 道题标记为需要再练/);
  f.click('只练标记的 1 道题');
  const heading=[...nodes(f.view())].find(n=>n.type==='h3');assert.equal(text(heading),retrySlot===0?'First':'Second');
  f.click('查看原文并自评');f.click('已能回忆，完成本轮');
  assert.match(text(f.view()),/已完成 1 道困难题再练/);
  assert.match(text(f.view()),/本轮没有标记待练题/);await f.preserved();
});

test('same-tick duplicate and earlier completion callbacks cannot skip a later slot',async t=>{
  const f=await restored(t,[question('a','First'),question('b','Second'),question('c','Third')]);
  f.click('查看原文并自评');const first=button(f.view(),'已能回忆，继续下一题').props.onClick;
  first();first();f.render();assert.equal(text([...nodes(f.view())].find(n=>n.type==='h3')),'Second');
  f.click('查看原文并自评');f.click('已能回忆，继续下一题');
  first();f.render();assert.equal(text([...nodes(f.view())].find(n=>n.type==='h3')),'Third');
  assert.ok(button(f.view(),'查看原文并自评'));await f.preserved();
});

test('retained callback from replaced materials cannot advance the replacement',async t=>{
  const f=await restored(t,[question('a','First'),question('b','Second')]);
  f.click('查看原文并自评');const old=button(f.view(),'已能回忆，继续下一题').props.onClick;
  f.open([question('a','Replacement'),question('b','Replacement second')]);
  old();f.render();assert.equal(text([...nodes(f.view())].find(n=>n.type==='h3')),'Replacement');
  await f.preserved();
});

test('retained retry-start callback cannot clear the new retry answer',async t=>{
  const f=await restored(t,[question('same','First'),question('same','Second')]);
  f.click('查看原文并自评');f.click('仍不熟悉，标记再练');
  f.click('查看原文并自评');f.click('已能回忆，完成本轮');
  const startRetry=button(f.view(),'只练标记的 1 道题').props.onClick;
  startRetry();f.render();
  [...nodes(f.view())].find(n=>n.type==='textarea').props.onChange({target:{value:'Keep retry input'}});f.render();
  startRetry();f.render();
  assert.equal([...nodes(f.view())].find(n=>n.type==='textarea').props.value,'Keep retry input');
  await f.preserved();
});
