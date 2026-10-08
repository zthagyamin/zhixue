import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,tick} from './helpers/causal-harness.mjs';
import {createTemporaryDraft} from '../src/application/temporary-practice/index.ts';
import {recallFixture,settle} from './helpers/recall-flow-fixture.mjs';
const paperCard=f=>[...nodes(f.view())].find(n=>n.type?.name==='PaperRecallPractice');

function paperFixture(){
  const hooks=createHooks(),load=loader(hooks.api,{}, {addEventListener(){},removeEventListener(){}}),finished=[];
  const {PaperRecallPractice}=load('src/features/remediation/paper-recall.tsx');
  const draft=createTemporaryDraft({initial:{answer:''},binding:'paper-A'});
  hooks.mount(PaperRecallPractice,{prompt:'为什么单项贡献需要对照？',reference:'固定其他条件后，比较目标因素变化带来的结果。',draft,onContinue:()=>{finished.push(true);return true;},onExit:()=>{}});
  const render=()=>{hooks.render();hooks.flush();};
  const click=name=>{const b=button(hooks.view(),name);assert.ok(b,name);assert.ok(!b.props.disabled,name);b.props.onClick();render();};
  const type=value=>{const input=[...nodes(hooks.view())].find(n=>n.type==='textarea');assert.ok(input);input.props.onChange({target:{value}});render();};
  return{hooks,draft,render,click,type,finished,view:()=>hooks.view()};
}
test('simple paper card has one brief answer and no dialog, checklist or reference leakage',()=>{
  const f=paperFixture();
  assert.equal([...nodes(f.view())].filter(n=>n.type==='textarea').length,1);
  assert.equal([...nodes(f.view())].some(n=>n.type==='input'||n.type==='dialog'||n.type?.name==='TemporaryDialog'),false);
  assert.doesNotMatch(text(f.view()),/固定其他条件后|已对照|首轮结果|辅助练习/);
  assert.equal(button(f.view(),'看答案').props.disabled,true);
  f.type('控制其他因素后比较差异');f.click('看答案');
  assert.match(text(f.view()),/固定其他条件后/);
  assert.equal([...nodes(f.view())].filter(n=>n.type==='button').length,2);
  f.click('记住了');assert.equal(f.finished.length,1);f.hooks.unmount();
});
test('repeat shows the key point then clears the previous brief answer',()=>{
  const f=paperFixture();f.type('旧回答');f.click('看答案');f.click('再来一遍');
  assert.match(text(f.view()),/固定其他条件后/);
  assert.equal([...nodes(f.view())].filter(n=>n.type==='textarea').length,0);
  f.click('再试一次');assert.equal(f.draft.read('answer'),'');
  assert.doesNotMatch(text(f.view()),/固定其他条件后|旧回答/);f.hooks.unmount();
});
test('invalidated paper input cannot continue or expose the previous question',()=>{
  const f=paperFixture();f.type('unfinished');f.draft.dispose();f.render();
  assert.doesNotMatch(text(f.view()),/为什么单项|固定其他/);
  assert.equal(button(f.view(),'记住了'),undefined);assert.equal(button(f.view(),'先下一题'),undefined);
  assert.equal(f.finished.length,0);f.hooks.unmount();
});
for(const rating of ['again','hard','good'])test('paper '+rating+' offers the adaptive path only for unmastered first attempts',async()=>{
  const f=recallFixture({data:{sourceLabel:'论文核心观点'},gradeRecall:async()=>({source:'ai',rating,verdict:rating==='good'?'correct':rating==='hard'?'partial':'incorrect'})});
  await settle(f);await f.type('首次回答');await f.click('提交并核对');
  const launcher=f.button('再试一次');
  assert.equal(Boolean(launcher),rating!=='good');
  if(launcher){
    await f.click('再试一次');
    assert.deepEqual(f.records,[rating]);assert.deepEqual(f.moves,[]);
    const card=paperCard(f);assert.ok(card);assert.equal(card.props.onContinue(),true);assert.equal(card.props.onContinue(),false);await settle(f);
    assert.deepEqual(f.records,[rating]);assert.deepEqual(f.moves,['continue']);
  }
  f.hooks.unmount();
});
test('paper domain survives via authoritative source context without changing normal recall',async()=>{
  const f=recallFixture();
  f.hooks.render({...f.props,context:{...f.props.context,contentSource:{mode:'recall',data:{domain:'paper'}}}});await settle(f);
  await f.click('忘记了，查看要点');assert.ok(f.button('再试一次'));f.hooks.unmount();
  const normal=recallFixture();await settle(normal);await normal.click('忘记了，查看要点');
  assert.equal(normal.button('再试一次'),undefined);normal.hooks.unmount();
});


test('failed first save cannot enter paper practice and retry preserves one original result',async()=>{
  const f=recallFixture({data:{sourceLabel:'论文核心观点'},failSaves:1});await settle(f);await f.click('忘记了，查看要点');
  await f.click('再试一次');assert.equal(paperCard(f),undefined);
  assert.deepEqual(f.records,[]);assert.deepEqual(f.moves,[]);
  await f.click('再试一次');assert.ok(paperCard(f));
  assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);f.hooks.unmount();
});

test('paper without a usable reference offers an ungraded skip, not an invented practice',async()=>{
  const f=recallFixture({data:{sourceLabel:'论文核心观点',explanation:undefined,answer:undefined}});await settle(f);await f.click('忘记了，查看要点');
  assert.equal(f.button('再试一次'),undefined);
  await f.click('暂时跳过，不计成绩');assert.deepEqual(f.records,[]);assert.deepEqual(f.moves,['skip']);f.hooks.unmount();
});

for(const level of [2,3])for(const grading of ['self','ai'])test(`paper hint level ${level} keeps remediation available after ${grading} good`,async()=>{
  const f=recallFixture({support:true,data:{sourceLabel:'论文核心观点'},gradeRecall:async()=>({source:'ai',verdict:'correct',rating:'good',matchedPointIds:['definition'],missedPointIds:[]})});
  await settle(f);await f.click('给我一个方向');await f.click('结构提示（最高记为困难）');
  if(level===3)await f.click('完整参考（按再学记录）');
  if(grading==='ai'){await f.type('提示后给出的回答');await f.click('提交并核对');}
  else{await f.click('想好了，核对要点');[...nodes(f.view())].find(n=>n.type==='input'&&n.props.type==='radio'&&n.props.value==='good').props.onChange();f.hooks.render();await settle(f);}
  const launcher=f.button('再试一次');assert.ok(launcher,'Applied hard/again must still offer same-day practice');
  assert.equal(f.button('结束本轮').props.className,'study-secondary-action');
  await f.click('再试一次');assert.ok(paperCard(f));
  assert.deepEqual(f.records,[level===2?'hard':'again']);assert.deepEqual(f.moves,[]);f.hooks.unmount();
});


test('inline retry replaces original feedback and retains only one original result',async()=>{
  const f=recallFixture({data:{sourceLabel:'论文核心观点'}});await settle(f);await f.click('忘记了，查看要点');
  await f.click('再试一次');const card=paperCard(f);assert.ok(card);
  assert.equal([...nodes(f.view())].some(n=>n.props?.text==='参考要点：定义与适用条件。'),false);
  assert.equal(f.button('改用我的自评'),undefined);assert.equal(f.button('看完了，结束本轮'),undefined);
  assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);
  assert.equal(card.props.onContinue(),true);assert.equal(card.props.onContinue(),false);await settle(f);
  assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
});

test('discarding the parent scope invalidates an inline retry without advancing another item',async()=>{
  const f=recallFixture({data:{sourceLabel:'论文核心观点'}});await settle(f);await f.click('忘记了，查看要点');await f.click('再试一次');
  const card=paperCard(f);card.props.draft.write('answer','old temporary answer');f.store.clear();await settle(f);
  assert.equal(card.props.draft.isActive(),false);assert.equal(card.props.onContinue(),false);
  assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);f.hooks.unmount();await tick();
});
