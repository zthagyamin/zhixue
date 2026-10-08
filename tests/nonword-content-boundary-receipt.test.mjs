import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,deferred} from './helpers/causal-harness.mjs';

const boundary=loader(createHooks().api)('app/plugin-content-boundary.tsx').PluginContentBoundary;
const View=()=>null;
const data={prompt:'为什么对照实验要保持其他条件一致？',answer:'只改变目标因素，才能把观测差异与该因素联系起来。',explanation:'保持其他条件一致，再比较目标因素变化。'};

test('non-word content protection forwards the complete formal-save promise before continuation',async()=>{
    const receipt=deferred();let writes=0;
    const slot=boundary({mode:'recall',View,data,context:{nonWordLearning:{purpose:'first'}},onGrade:()=>{writes++;return receipt.promise;}});
    const submitted=slot.props.onGrade('good',{deferAdvance:true});
    assert.equal(submitted,receipt.promise);assert.equal(writes,1);
    let done=false;submitted.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
    receipt.resolve({status:'saved'});assert.deepEqual(await submitted,{status:'saved'});
});

test('a non-word save rejection reaches the learner interaction instead of appearing saved',async()=>{
    const receipt=deferred();
    const slot=boundary({mode:'recall',View,data,context:{nonWordLearning:{purpose:'first'}},onGrade:()=>receipt.promise});
    const submitted=slot.props.onGrade('hard',{deferAdvance:true});assert.equal(submitted,receipt.promise);
    const failed=assert.rejects(submitted,/storage unavailable/);receipt.reject(Error('storage unavailable'));await failed;
});

test('word rendering keeps the previous synchronous submission return and calls its host once',async()=>{
    const receipt=deferred();let calls=0;
    const slot=boundary({mode:'three-stage',View,data:{word:'retain',meaning:'保持',example:'We retain records.'},onGrade:()=>{calls++;return receipt.promise;}});
    assert.equal(slot.props.onGrade('good'),undefined);assert.equal(calls,1);
    receipt.resolve({status:'saved'});await receipt.promise;
});
