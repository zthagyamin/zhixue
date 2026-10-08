import test from 'node:test';
import assert from 'node:assert/strict';
import {recallFixture,settle,nodes,text} from './helpers/recall-flow-fixture.mjs';

const radios=f=>[...nodes(f.view())].filter(n=>n.type==='input'&&n.props.type==='radio');
for(const rating of ['again','hard','good'])test('AI '+rating+' is displayed as a result; explicit self-review makes every choice actionable',async()=>{
  const f=recallFixture({gradeRecall:async()=>({source:'ai',rating,verdict:rating==='good'?'correct':rating==='hard'?'partial':'incorrect',feedback:'原AI反馈'})});
  await settle(f);await f.type('我第一次回忆的回答');await f.click('提交并核对');
  assert.equal(radios(f).length,0,'A fixed AI judgment must not look like editable radio buttons');
  assert.match(text(f.view()),/AI 判定/);assert.deepEqual(f.records,[]);
  await f.click('改用我的自评');
  assert.equal(radios(f).length,3);
  assert.equal(f.button('结束本轮').props.disabled,true);
  for(const value of ['good','hard','again']){
    const input=radios(f).find(n=>n.props.value===value);
    assert.ok(!input.props.disabled);input.props.onChange();f.hooks.render();await settle(f);
    assert.deepEqual(radios(f).filter(n=>n.props.checked).map(n=>n.props.value),[value]);
    assert.deepEqual(f.records,[]);
  }
  assert.equal(f.draft.read('result',null).feedback,'原AI反馈');
  const practice=[...nodes(f.view())].find(n=>n.props?.beforeOpen);
  assert.equal(await practice.props.beforeOpen(new AbortController().signal),true);await settle(f);
  assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);
  assert.equal(radios(f).length,0,'Saved results must not expose frozen edit controls');
  await f.click('结束本轮');assert.deepEqual(f.records,['again']);
  f.hooks.unmount();
});

test('explicitly forgotten recall has no manual upgrade controls',async()=>{
  const f=recallFixture();await settle(f);await f.click('忘记了，查看要点');
  assert.equal(radios(f).length,0);assert.equal(f.button('改用我的自评'),undefined);
  await f.click('看完了，结束本轮');assert.deepEqual(f.records,['again']);f.hooks.unmount();
});

test('manual self-review still respects prior full-reference use',async()=>{
  const f=recallFixture({support:true});await settle(f);
  await f.click('给我一个方向');
  await f.click('结构提示（最高记为困难）');
  await f.click('完整参考（按再学记录）');
  await f.click('想好了，核对要点');
  const good=radios(f).find(n=>n.props.value==='good');good.props.onChange();f.hooks.render();await settle(f);
  await f.click('结束本轮');assert.deepEqual(f.records,['again']);f.hooks.unmount();
});


