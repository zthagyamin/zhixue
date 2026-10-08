import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

let contract;
try { contract = await import('../app/task-plan-types.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-plan-v2.json',import.meta.url),'utf8'));
const parse = value => {
  assert.equal(typeof contract?.parseTaskPlan,'function','V2 plan parser must exist');
  return contract.parseTaskPlan(value);
};
test('the V2 plan preserves the complete manual and review payload',()=>assert.deepEqual(parse(fixture),fixture));
const mutations = [
  ['duplicate-task-id',p=>p.tasks.push(structuredClone(p.tasks[0]))],
  ['invalid-task-quantity',p=>p.tasks[0].quantity=0],
  ['invalid-task-quantity',p=>p.tasks[0].quantity=1.5],
  ['invalid-task-quantity',p=>p.tasks[0].quantity=true],
  ['invalid-plan-day',p=>p.day='2026-02-30'],
  ['invalid-plan-day',p=>p.day='0000-01-01'],
  ['unsupported-task-plan-version',p=>p.schemaVersion=3],
  ['unknown-locked-task',p=>p.manual.lockedTaskIds=['missing']],
  ['invalid-task-action',p=>p.tasks[0].action={kind:'practice',itemKeys:[]}],
  ['invalid-plan-hash',p=>p.planHash='not-a-hash'],
  ['unknown-plan-field',p=>p.mastery='mastered'],
  ['unknown-task-field',p=>p.tasks[0].done=true],
  ['required-review',p=>p.tasks[0].required=false],
  ['duplicate-plan-value',p=>p.vocabulary.assignedLexemeKeys=['en:a','en:a']],
  ['invalid-task-category',p=>p.tasks[0].category=['review']],
  ['invalid-task-origin',p=>p.tasks[0].origin=['fixed']],
  ['invalid-taskId',p=>p.tasks[0].taskId='bad\u0000id'],
];
for (const [index,[code,mutate]] of mutations.entries()) test(`V2 refuses ${code} (${index})`,()=>{
  assert.ok(contract,'V2 contract must be implemented');
  const plan=structuredClone(fixture);mutate(plan);
  assert.throws(()=>parse(plan),new RegExp(code));
});
test('optional time is absent by default and zero is a valid reference',()=>{
  assert.equal(parse(fixture).optionalMinutes,undefined);
  assert.equal(parse({...fixture,optionalMinutes:0}).optionalMinutes,0);
});
test('V2 capability is explicit, not inferred from gateway version',()=>{
  assert.ok(contract);
  assert.equal(contract.supportsTaskPlanning(['quiz','three-stage']),false);
  assert.equal(contract.supportsTaskPlanning(['task-planning-v1']),true);
  assert.equal(contract.supportsTaskPlanning({schemaVersion:2}),false);
});
test('the shared lower year bound is valid',()=>assert.equal(parse({...fixture,day:'0001-01-01'}).day,'0001-01-01'));
test('bounded word identities and explicit task order survive wire validation',()=>{
  const plan=structuredClone(fixture);
  plan.vocabulary.manualSelection=true;
  plan.vocabulary.snapshot=[{itemKey:'word:tree',subjectId:'vocab',word:'Tree',language:'en',sourceHash:'a'.repeat(64),completionRule:'three-stage'}];
  plan.manual.order=['manual-one','review-one'];
  assert.deepEqual(parse(plan),plan);
});
test('word snapshots cannot smuggle source meanings or unknown task-order ids',()=>{
  const plan=structuredClone(fixture);
  plan.vocabulary.snapshot=[{itemKey:'word:tree',subjectId:'vocab',word:'Tree',language:'en',sourceHash:'a'.repeat(64),completionRule:'three-stage',meaning:'not an identity'}];
  assert.throws(()=>parse(plan),/unknown-word-snapshot-field/);
  delete plan.vocabulary.snapshot[0].meaning;
  plan.vocabulary.snapshot[0].completionRule=['three-stage'];
  assert.throws(()=>parse(plan),/invalid-word-completion-rule/);
  delete plan.vocabulary.snapshot;plan.manual.order=['missing'];
  assert.throws(()=>parse(plan),/unknown-ordered-task/);
});
