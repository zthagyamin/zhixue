import assert from 'node:assert/strict';
import test from 'node:test';
import {generateAccountRuleDraft} from '../src/features/planning/account-rule-draft.ts';

test('account rule draft reports real stages and saves the merged plan without approval or AI',async()=>{
  const trace=[];
  const plan=await generateAccountRuleDraft({
    onPhase:phase=>trace.push(phase),
    compose:async()=>({source:'verified'}),
    generate:async source=>{assert.equal(source.source,'verified');return 'rules';},
    merge:async(source,fresh)=>{assert.equal(fresh,'rules');return 'merged';},
    check:async()=>trace.push('checked'),
    save:async(source,value)=>{assert.equal(value,'merged');trace.push('saved');},
  });
  assert.equal(plan,'merged');
  assert.deepEqual(trace,['checking','generating','checked','saving','saved',null]);
});

test('failed evidence and generation stop before saving and clear the progress state',async()=>{
  for(const failed of ['compose','generate','check']){
    const trace=[];
    const step=async name=>{trace.push(name);if(name===failed)throw Error(name);return name;};
    await assert.rejects(generateAccountRuleDraft({onPhase:p=>trace.push(p),compose:()=>step('compose'),generate:()=>step('generate'),merge:()=>step('merge'),check:()=>step('check'),save:()=>assert.fail('must not save')}),new RegExp(failed));
    assert.equal(trace.at(-1),null);
    assert.equal(trace.includes('saving'),false);
  }
});
