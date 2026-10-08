import assert from 'node:assert/strict';
import test from 'node:test';
import {recallFixture,settle,nodes,text,deferred} from './helpers/recall-flow-fixture.mjs';
const criteria=[{id:'definition',text:'概念定义',weight:1},{id:'condition',text:'必须控制其他条件',weight:3,mandatory:true}];
function radio(f,value){return [...nodes(f.view())].find(node=>node.type==='input'&&node.props.type==='radio'&&node.props.value===value);}
async function choose(f,value){const control=radio(f,value);assert.ok(control);assert.ok(!control.props.disabled);control.props.onChange();f.hooks.render();await settle(f);}
test('CQ no-reference submission preserves answer, makes zero AI calls and skips without a grade',async()=>{
 let calls=0;const f=recallFixture({data:{prompt:'为什么？',explanation:'为什么？',answer:'为什么？'},gradeRecall:async()=>{calls++;return {source:'ai',verdict:'correct',rating:'good'};}});
 await settle(f);await f.type('我的回答');await f.click('提交并核对');
 assert.equal(calls,0);assert.equal(f.draft.read('answer',''),'我的回答');assert.deepEqual(f.records,[]);
 assert.match(text(f.view()),/没有调用 AI/);await f.click('暂时跳过，不计成绩');assert.deepEqual(f.moves,['skip']);assert.deepEqual(f.records,[]);f.hooks.unmount();
});
for(const result of [
 {source:'ai',verdict:'correct',rating:'easy'},
 {source:'ai',verdict:'incorrect',rating:'good',confidence:1},
 {source:'ai',verdict:'partial',rating:'good'},
 {source:'ai',verdict:'correct',rating:'good',matchedPointIds:['definition'],missedPointIds:['condition']},
 {source:'ai',verdict:'partial',rating:'hard',matchedPointIds:['invented'],missedPointIds:['condition']},
])test('EV contradictory or unsupported evidence returns to self-check without a silent downgrade: '+JSON.stringify(result),async()=>{
 const data=result.matchedPointIds?{learningSupport:{schemaVersion:1,type:'recall',criteria}}:{};
 const f=recallFixture({data,gradeRecall:async()=>result});await settle(f);await f.type('我的原始回答');await f.click('提交并核对');
 assert.match(text(f.view()),/评价与评分依据不一致/);assert.ok(!text(f.view()).includes('AI 判定 · 回答正确'));assert.deepEqual(f.records,[]);
 assert.equal(f.draft.read('answer',''),'我的原始回答');assert.equal(f.button('结束本轮').props.disabled,true);
 await choose(f,'hard');await f.click('结束本轮');assert.deepEqual(f.records,['hard']);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
});
test('valid partial evaluation displays weighted coverage and mandatory gap',async()=>{
 const f=recallFixture({data:{learningSupport:{schemaVersion:1,type:'recall',criteria}},gradeRecall:async()=>({source:'ai',verdict:'partial',rating:'hard',matchedPointIds:['definition'],missedPointIds:['condition'],feedback:'定义正确，还缺少条件。'})});
 await settle(f);await f.type('定义说明');await f.click('提交并核对');assert.match(text(f.view()),/关键遗漏/);assert.match(text(f.view()),/加权覆盖 25%/);
 assert.ok([...nodes(f.view())].some(node=>node.props.text==='必须控制其他条件'));
 await f.click('结束本轮');assert.deepEqual(f.records,['hard']);f.hooks.unmount();
});
test('dispute is page-local, preserves AI feedback and requires explicit manual assessment',async()=>{
 const f=recallFixture({gradeRecall:async()=>({source:'ai',verdict:'correct',rating:'good',feedback:'原始 AI 反馈'})});await settle(f);await f.type('作答');await f.click('提交并核对');
 await f.click('改用我的自评');assert.match(text(f.view()),/离开本页不保留/);assert.equal(f.draft.read('result',null).feedback,'原始 AI 反馈');assert.equal(f.button('结束本轮').props.disabled,true);assert.deepEqual(f.records,[]);
 await choose(f,'again');await f.click('结束本轮');assert.deepEqual(f.records,['again']);f.hooks.unmount();
});
test('reference-only revision invalidates an in-flight AI response without replacing the current input',async()=>{
 const wait=deferred(),f=recallFixture({gradeRecall:()=>wait.promise});await settle(f);await f.type('原答案');f.button('提交并核对').props.onClick();await settle(f);
 f.hooks.render({...f.props,data:{...f.props.data,explanation:'来源已修订的不同参考'}});await settle(f);wait.resolve({source:'ai',verdict:'correct',rating:'good',feedback:'STALE'});await settle(f);
 assert.notEqual(f.draft.read('result',null)?.feedback,'STALE');assert.match(text(f.view()),/参考内容已变化/);assert.deepEqual(f.records,[]);f.hooks.unmount();
});
