import test from 'node:test';
import assert from 'node:assert/strict';
import {recallFixture, settle, nodes, text, deferred} from './helpers/recall-flow-fixture.mjs';
import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {applyAttemptMutation, parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {attemptFingerprint, evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {waitForObservation} from './helpers/causal-harness.mjs';

async function fixture({gradeRecall, submitGate, assessmentGate, remediationGate, restored = false, failGrade = false, data = {}} = {}) {
  const f = recallFixture({gradeRecall, data}), calls = [], attempts = new Map();
  let operation = 0, child = false;
  const binding = {ownerId: 'synthetic-recall-owner', libraryId: 'library', snapshotId: 'snapshot',
    itemKey: 'question', contentHash: 'a'.repeat(64), groupId: 'group', roundId: 'round'};
  const repository = {read: async id => attempts.get(id) ?? null, mutate: async raw => {
    const mutation = parseAttemptMutation(raw);
    if (mutation.kind === 'evaluate' && mutation.evaluation.status === 'resolved' && assessmentGate) await assessmentGate.promise;
    const receipt = applyAttemptMutation(attempts.get(mutation.attemptId) ?? null, mutation, await attemptFingerprint(mutation));
    if (receipt.attempt && receipt.status === 'accepted') attempts.set(mutation.attemptId, receipt.attempt);
    return {...receipt, durable: receipt.status !== 'conflict'};
  }};
  const make = purpose => createNonWordSession({repository, binding, attemptId: purpose, formalEventId: 'formal-first',
    mode: 'recall', purpose, ...(purpose === 'remediation' ? {parentAttemptId: 'first'} : {}),
    now: () => '2026-10-05T00:00:00.000Z', newId: () => `operation-${++operation}`,
    fingerprint: attemptFingerprint, evaluationFingerprint});
  const first = make('first'); await first.open(); let session = first;
  function awaitFinishReceipt() {
    const click = f.click;
    f.click = async function(name) {
      const result = await click.call(this, name);
      if (['结束本轮', '结束补练并继续', '看完了，结束本轮'].includes(name)) {
        await session.flush();
        await settle(f);
      }
      return result;
    };
  }
  if (restored) {
    await first.submit('RESTORED ORIGINAL');
    await f.type('RESTORED ORIGINAL'); f.draft.write('nonwordPending', '原答案已保存，可恢复核对。');
  }
  const lifecycle = {ready: true, get purpose() {return child ? 'remediation' : 'first';}, intent: 'review',
    get submitted() {return Boolean(session.snapshot()?.submitted);},
    async submit(answer) {calls.push(['submit', answer]); if (submitGate) await submitGate.promise; await session.submit(answer);},
    async assess(outcome) {calls.push(['assess', outcome]); await session.assess(outcome);},
    async waitForReview(reason) {calls.push(['pending', reason]); await session.pending('offline');},
    async continuePending() {calls.push(['continue-pending']); await session.traversePending(); f.moves.push('pending');},
    async startRemediation() {
      calls.push(['start-remediation']);
      if (remediationGate) await remediationGate.promise;
      child = true; session = make('remediation'); await session.open();
      f.hooks.unmount();
      const parentDraft = f.draft;
      const next = recallFixture({gradeRecall, data});
      const childDraft = {...next.draft, hasSavedFeedback: parentDraft.hasSavedFeedback, continueAfterFeedback: parentDraft.continueAfterFeedback};
      next.props = {...next.props, context: {...next.props.context, draft: childDraft, nonWordLearning: lifecycle}, onGrade: f.props.onGrade};
      next.hooks.render(next.props);
      Object.assign(f, {hooks: next.hooks, props: next.props, draft: childDraft, view: next.view, button: next.button,
        type: next.type, click: next.click});
      awaitFinishReceipt();
      await settle(f);
    },
    async finishRemediation() {calls.push(['finish-remediation']); f.moves.push('finished-remediation');},
  };
  const legacyGrade = f.props.onGrade;
  f.props = {...f.props, context: {...f.props.context, nonWordLearning: lifecycle},
    onGrade: async (rating, options) => {calls.push(['formal', rating]); if (failGrade) throw Error('Actual formal save rejected'); legacyGrade(rating, options);}};
  f.hooks.render(f.props); await settle(f);
  awaitFinishReceipt();
  return Object.assign(f, {calls, first, lifecycle, child: () => child, session: () => session});
}
function radio(f, value) {return [...nodes(f.view())].find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === value);}

test('original answer is durable before AI starts; trusted model feedback is assessed without an implicit formal grade', {timeout: 10000}, async () => {
  const gate = deferred(); let ai = 0;
  const f = await fixture({submitGate: gate, gradeRecall: async () => {ai++; return {source: 'ai', verdict: 'partial', rating: 'hard', feedback: '遗漏边界。'};}});
  await f.type('  ORIGINAL WITH SPACES  '); f.button('提交并核对').props.onClick(); await settle(f);
  assert.equal(ai, 0);
  const assessed = new Promise(resolve => {
    const unsubscribe = f.first.subscribe(() => {
      if (f.first.snapshot().evaluation.status === 'resolved') { unsubscribe(); resolve(); }
    });
  });
  gate.resolve(); await assessed; await settle(f);
  assert.equal(f.first.snapshot().submitted.answer, '  ORIGINAL WITH SPACES  ');
  assert.equal(f.first.snapshot().evaluation.source, 'model');
  assert.equal(f.calls.filter(row => row[0] === 'assess').length, 1);
  assert.equal(f.records.length, 0); f.hooks.unmount();
});

test('AI unavailable preserves readonly submitted answer; explicit pending continuation never self-grades', async () => {
  const f = await fixture({gradeRecall: async () => {throw Error('cloud-ai-disabled');}});
  await f.type('MY ORIGINAL'); await f.click('提交并核对');
  assert.equal([...nodes(f.view())].find(node => node.type === 'textarea').props.readOnly, true);
  assert.equal(radio(f, 'good'), undefined); assert.equal(f.first.snapshot().evaluation.status, 'pending');
  await f.type('FORCED EDIT'); assert.equal(f.draft.read('answer', ''), 'MY ORIGINAL');
  await f.click('保存的答案稍后核对，继续');
  assert.deepEqual(f.moves, ['pending']); assert.deepEqual(f.records, []);
  assert.equal(f.first.snapshot().submitted.answer, 'MY ORIGINAL'); f.hooks.unmount();
});

test('restored pending answer retries the same first attempt and rejects contradictory AI without a self-assessment fallback', async () => {
  let calls = 0;
  const f = await fixture({restored: true, gradeRecall: async () => {calls++; return calls === 1
    ? {source: 'ai', verdict: 'incorrect', rating: 'good'}
    : {source: 'ai', verdict: 'correct', rating: 'good', feedback: '参考一致。'};}});
  const id = f.first.snapshot().attemptId;
  await f.click('提交并核对'); assert.equal(f.first.snapshot().evaluation.status, 'pending'); assert.equal(radio(f, 'good'), undefined);
  await f.click('提交并核对'); assert.equal(f.first.snapshot().attemptId, id);
  assert.equal(f.first.snapshot().submitted.answer, 'RESTORED ORIGINAL');
  assert.equal(f.first.snapshot().evaluation.status, 'resolved'); assert.equal(calls, 2);
  assert.deepEqual(f.records, []); f.hooks.unmount();
});

test('formal save rejection is awaited and leaves feedback retryable', async () => {
  const f = await fixture({failGrade: true, gradeRecall: async () => ({source: 'ai', verdict: 'correct', rating: 'good', feedback: '正确。'})});
  await f.type('FIRST'); await f.click('提交并核对'); await f.click('结束本轮');
  assert.match(text(f.view()), /Actual formal save rejected/); assert.deepEqual(f.moves, []); assert.deepEqual(f.records, []);
  assert.equal(f.first.snapshot().submitted.answer, 'FIRST'); f.hooks.unmount();
});

test('explicit oral self-check records an empty oral answer honestly and requires the learner selection', async () => {
  let ai = 0; const f = await fixture({gradeRecall: async () => {ai++; throw Error('unused');}});
  await f.click('想好了，核对要点'); assert.equal(f.first.snapshot().submitted.answer, '');
  assert.equal(f.button('结束本轮').props.disabled, true);
  radio(f, 'hard').props.onChange(); f.hooks.render(); await settle(f); await f.click('结束本轮');
  assert.equal(f.first.snapshot().evaluation.source, 'self-assess'); assert.equal(f.first.snapshot().evaluation.rating, 'hard');
  assert.equal(ai, 0); assert.deepEqual(f.records, ['hard']); f.hooks.unmount();
});

test('oral self-check fixture waits for the actual durable reply rather than a fixed turn count', async t => {
  const gate = deferred(), f = await fixture({submitGate: gate});
  t.after(() => {gate.resolve(); f.hooks.unmount();});
  let finished = false;
  const action = f.click('想好了，核对要点').then(() => {finished = true;});
  for (let i = 0; i < 6; i++) await settle(f);
  assert.equal(f.first.snapshot().submitted, null);
  assert.equal(radio(f, 'hard'), undefined);
  assert.equal(finished, false, 'Click helper must still await the durable submission');
  gate.resolve(); await action;
  assert.equal(f.first.snapshot().submitted.answer, '');
  assert.ok(radio(f, 'hard')); assert.deepEqual(f.records, []);
});

test('oral finish fixture waits for durable assessment before asserting its source and formal result', async t => {
  const gate = deferred(), f = await fixture({assessmentGate: gate});
  t.after(() => {gate.resolve(); f.hooks.unmount();});
  await f.click('想好了，核对要点');
  radio(f, 'hard').props.onChange(); f.hooks.render(); await settle(f);
  let finished = false;
  const finishing = f.click('结束本轮').then(() => {finished = true;});
  for (let i = 0; i < 6; i++) await settle(f);
  assert.equal(finished, false, 'Finish must still await the assessment receipt');
  assert.equal(f.first.snapshot().evaluation.source, undefined);
  assert.deepEqual(f.records, []);
  gate.resolve(); await finishing;
  assert.equal(f.first.snapshot().evaluation.source, 'self-assess');
  assert.deepEqual(f.records, ['hard']);
});

test('inline retry starts an isolated child, assesses its actual answer, and finishes without a second formal grade', async () => {
  let ai = 0; const f = await fixture({data: {sourceLabel: '论文 §2'}, gradeRecall: async () => {
    ai++; return ai === 1 ? {source: 'ai', verdict: 'partial', rating: 'hard', feedback: '遗漏条件。'}
      : {source: 'ai', verdict: 'correct', rating: 'good', feedback: '补练回答正确。'};
  }});
  await f.type('FIRST INCOMPLETE'); await f.click('提交并核对');
  await f.click('收起讲解，再试一次'); await settle(f);
  assert.equal(f.child(), true); assert.equal([...nodes(f.view())].find(node => node.type === 'textarea').props.value, '');
  assert.equal([...nodes(f.view())].some(node => node.props?.worksheet), false);
  await f.type('CHILD ACTUAL ANSWER'); await f.click('提交并核对'); await f.click('结束补练并继续');
  assert.equal(f.first.snapshot().submitted.answer, 'FIRST INCOMPLETE');
  assert.equal(f.session().snapshot().submitted.answer, 'CHILD ACTUAL ANSWER');
  assert.equal(f.session().snapshot().parentAttemptId, 'first');
  assert.equal(f.session().snapshot().evaluation.source, 'model');
  assert.deepEqual(f.calls.filter(row => row[0] === 'formal').map(row => row[1]), ['hard']);
  assert.deepEqual(f.moves, ['finished-remediation']); f.hooks.unmount();
});

test('remediation entry fixture waits for the child recovery receipt before returning an editable input', async t => {
  const gate = deferred(), f = await fixture({remediationGate: gate,
    gradeRecall: async () => ({source: 'ai', verdict: 'partial', rating: 'hard'})});
  let entry;
  t.after(async () => {gate.resolve(); await entry; f.hooks.unmount();});
  await f.type('IMMUTABLE FIRST'); await f.click('提交并核对');
  let finished = false;
  entry = f.click('收起讲解，再试一次').then(() => {finished = true;});
  await waitForObservation(() => settle(f), () => f.calls.some(row => row[0] === 'start-remediation'),
    {label: 'remediation entry waits behind child recovery'});
  for (let i = 0; i < 6; i++) await settle(f);
  assert.equal(finished, false, 'Entry must await the child recovery receipt');
  assert.equal(f.child(), false);
  assert.equal([...nodes(f.view())].some(node => node.type === 'textarea'), false);
  assert.equal(f.draft.hasSavedFeedback(), true);
  assert.deepEqual(f.records, ['hard']); assert.deepEqual(f.moves, []);
  gate.resolve(); await entry;
  assert.equal(f.child(), true);
  const input = [...nodes(f.view())].find(node => node.type === 'textarea');
  assert.ok(input); assert.equal(input.props.value, '');
  await f.type('CHILD ACTUAL INPUT');
  assert.equal(f.draft.read('answer', ''), 'CHILD ACTUAL INPUT');
  assert.equal(f.first.snapshot().submitted.answer, 'IMMUTABLE FIRST');
  assert.deepEqual(f.records, ['hard']); assert.deepEqual(f.moves, []);
});

test('same-tick double submit starts one AI request after the original durability gate', async () => {
  const gate = deferred(); let ai = 0;
  const f = await fixture({submitGate: gate, gradeRecall: async () => {ai++; return {source: 'ai', verdict: 'correct', rating: 'good'};}});
  try {
    await f.type('FIRST'); const click = f.button('提交并核对').props.onClick; click(); click(); await settle(f);
    assert.equal(f.calls.filter(row => row[0] === 'submit').length, 1); assert.equal(ai, 0);
    gate.resolve(); await waitForObservation(()=>settle(f),()=>ai>0,{label:'AI begins after durable original'});
    await waitForObservation(()=>settle(f),()=>f.first.snapshot().evaluation.status==='resolved',{label:'original model assessment saved'});
    assert.equal(ai, 1);
    assert.equal(f.calls.filter(row => row[0] === 'submit').length, 1);
  } finally {gate.resolve();f.hooks.unmount();}
});

test('cancelled and late AI result remains pending without model assessment or a grade', async () => {
  const wait = deferred(); const f = await fixture({gradeRecall: () => wait.promise});
  await f.type('FIRST'); f.button('提交并核对').props.onClick(); await settle(f);
  await f.click('停止核对，保留待核对答案'); wait.resolve({source: 'ai', verdict: 'correct', rating: 'good'}); await settle(f);
  assert.equal(f.first.snapshot().evaluation.status, 'pending'); assert.equal(radio(f, 'good'), undefined);
  assert.equal(f.calls.filter(row => row[0] === 'assess').length, 0); assert.deepEqual(f.records, []); f.hooks.unmount();
});

test('same-tick pending continuation consumes one traversal operation', async () => {
  const f = await fixture({gradeRecall: async () => {throw Error('cloud-ai-disabled');}});
  await f.type('FIRST'); await f.click('提交并核对');
  const gate = deferred(), pending = f.lifecycle.continuePending;
  f.lifecycle.continuePending = async () => {await gate.promise; await pending();};
  const click = f.button('保存的答案稍后核对，继续').props.onClick;
  click(); click(); await settle(f); gate.resolve(); await settle(f);
  assert.equal(f.calls.filter(row => row[0] === 'continue-pending').length, 1);
  assert.deepEqual(f.moves, ['pending']); f.hooks.unmount();
});

test('remediation can explicitly self-assess after unavailable AI without consuming the parent receipt early', async () => {
  let ai = 0; const f = await fixture({gradeRecall: async () => {if (++ai === 1)return {source: 'ai', verdict: 'partial', rating: 'hard'};throw Error('cloud-ai-disabled');}});
  await f.type('FIRST'); await f.click('提交并核对'); await f.click('收起讲解，再试一次');
  assert.equal(f.draft.hasSavedFeedback(), true);
  await f.type('CHILD'); await f.click('提交并核对'); assert.equal(radio(f, 'good'), undefined);
  await f.click('想好了，核对要点'); radio(f, 'hard').props.onChange(); f.hooks.render(); await settle(f);
  await f.click('结束补练并继续'); assert.equal(f.session().snapshot().evaluation.source, 'self-assess');
  assert.equal(f.first.snapshot().submitted.answer, 'FIRST'); assert.deepEqual(f.records, ['hard']);
  assert.deepEqual(f.moves, ['finished-remediation']); f.hooks.unmount();
});

test('long feedback is collapsed and question/reference formulas are passed to the actual math renderer', async () => {
  const f = await fixture({data: {prompt: '解释 $x^2$ 的条件。', explanation: '参考 $x^2 = x*x$。'},
    gradeRecall: async () => ({source: 'ai', verdict: 'partial', rating: 'hard', feedback: '详细反馈。'.repeat(80) + '$x^2$'})});
  await f.type('FIRST'); await f.click('提交并核对');
  const collapse = [...nodes(f.view())].find(node => node.type === 'details' && text(node).startsWith('完整 AI 反馈'));
  assert.ok(collapse); assert.notEqual(collapse.props.open, true);
  const math = [...nodes(f.view())].filter(node => typeof node.props.text === 'string').map(node => node.props.text);
  assert.ok(math.includes('解释 $x^2$ 的条件。')); assert.ok(math.includes('参考 $x^2 = x*x$。')); f.hooks.unmount();
});

test('the production MathText renderer used by Recall emits actual KaTeX formula markup', () => {
  const {MathText} = loadTsx(new URL('../app/math-text.tsx', import.meta.url));
  const markup = renderToStaticMarkup(createElement(MathText, {text: '参考 $x^2 = x*x$。'}));
  assert.match(markup, /class="katex"/);
  assert.match(markup, /参考/);
});

test('a restored trusted complete assessment without persisted alignment does not invent a mandatory omission', () => {
  const {RecallPlugin} = loadTsx(new URL('../app/plugin-recall.tsx', import.meta.url));
  const values = {answer: 'RESTORED FIRST', revealed: true,
    result: {source: 'ai', verdict: 'correct', rating: 'good', correct: true, feedback: '已核对原参考。'}, recallSelectedRating: 'good'};
  const draft = {read: (field, initial) => Object.hasOwn(values, field) ? values[field] : initial,
    subscribe: () => () => {}, getSnapshot: () => 0, write: () => true};
  const markup = renderToStaticMarkup(createElement(RecallPlugin.renderUI, {
    data: {itemId: 'restored', fingerprint: 'v1', prompt: '解释定义和条件。', explanation: '参考定义及其条件。',
      learningSupport: {schemaVersion: 1, type: 'recall', criteria: [{id: 'condition', text: '给定适用条件', mandatory: true}]}},
    context: {draft, guidanceInOptions: true, nonWordLearning: {ready: true, purpose: 'first', intent: 'review', submitted: true}},
    onGrade() {},
  }));
  assert.match(markup, /回答正确/);
  assert.doesNotMatch(markup, /关键遗漏：/);
});

test('manual disagreement keeps original model evidence and explicitly lowers the formal choice', async () => {
  const f = await fixture({gradeRecall: async () => ({source: 'ai', verdict: 'correct', rating: 'good', feedback: 'Original model feedback'})});
  await f.type('FIRST'); await f.click('提交并核对'); await f.click('改用我的自评');
  assert.equal(f.draft.read('result', null).feedback, 'Original model feedback');
  radio(f, 'again').props.onChange(); f.hooks.render(); await settle(f); await f.click('结束本轮');
  assert.equal(f.first.snapshot().evaluation.source, 'model');
  assert.deepEqual(f.records, ['again']); f.hooks.unmount();
});
