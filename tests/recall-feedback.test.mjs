import assert from 'node:assert/strict';
import test from 'node:test';
import {recallFixture,settle,nodes,text} from './helpers/recall-flow-fixture.mjs';
// Existing contracts retained, now exercise the rendered actions instead of a detached AST closure.
test('accepting partial or incorrect AI feedback cannot upgrade it to a correct attempt',async()=>{
 for(const rating of ['good','hard','again']){
  const f=recallFixture({gradeRecall:async()=>({source:'ai',rating,verdict:rating==='good'?'correct':rating==='hard'?'partial':'wrong'})});
  await settle(f);await f.type('A real attempt');await f.click('提交并核对');
  const choices=[...nodes(f.view())].filter(n=>n.type==='input'&&n.props.type==='radio');
  assert.equal(choices.length,0,'AI acceptance must not expose apparently editable rating choices');
  await f.click('结束本轮');assert.deepEqual(f.records,[rating]);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
 }
});
test('recall fallback keeps a useful binding error instead of hiding it as generic AI downtime',async()=>{
 const f=recallFixture({gradeRecall:async()=>{throw new Error('本题版本已变化，请退出当前题目并刷新账号题库。');}});
 await settle(f);await f.type('My attempt');await f.click('提交并核对');assert.match(text(f.view()),/版本已变化.*刷新账号题库/);assert.equal(f.records.length,0);f.hooks.unmount();
});
