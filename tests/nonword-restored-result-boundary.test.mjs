import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks, loader, nodes, text, button, tick, deferred, waitForObservation} from './helpers/causal-harness.mjs';
import {createNonWordRuntime, restoredFields} from '../src/infrastructure/nonword-study/index.ts';
import {attachPracticeDriver} from '../src/infrastructure/practice-evidence/index.ts';

globalThis.indexedDB = new IDBFactory();
let sequence = 0;
async function original(mode, fields, {submitted = true, outcome, answer} = {}) {
  const ownerId = `restored-result-${sequence++}`;
  const runtime = await createNonWordRuntime({workspaceId: `local:${ownerId}`, ownerId, libraryId: 'library',
    snapshotId: 'snapshot', itemKey: `practice:${mode}`, contentHash: 'a'.repeat(64),
    groupId: 'group', roundId: 'round', cloud: false}, mode);
  const raw = answer ?? (mode === 'quiz' ? JSON.stringify(['option-1']) : 'raw original code');
  await runtime.session.save(raw, fields);
  if (submitted) await runtime.session.submit(raw, 'unknown');
  if (outcome) await runtime.session.assess({status: outcome, source: 'deterministic',
    rating: outcome === 'correct' ? 'good' : 'again', explanation: 'Actual saved evaluation.'});
  return {runtime, attempt: runtime.session.snapshot()};
}
const fakeQuiz = {selection: ['option-0'], first: {selection: ['option-0'],
  result: {status: 'correct', matched: ['option-0'], missing: [], wrong: []}},
  phase: 'retry-feedback', retry: {status: 'correct', matched: ['option-0'], missing: [], wrong: []}};
function quizView(attempt) {
  const hooks = createHooks(), grades = [], load = loader(hooks.api, {'app/math-text.tsx': {MathText: () => null}});
  const fields = restoredFields(attempt, 'quiz');
  const initial = fields.nonwordQuizState ?? {selection: [], first: null, phase: 'answer', retry: null};
  const component = load('src/features/nonword-study/quiz.tsx').NonWordQuiz;
  hooks.mount(() => {
    const [state, setState] = hooks.api.useState(initial);
    const child = component({data: {prompt: 'Pick the correct option.', options: ['right', 'wrong'], answer: 'right'},
      state, setState, onGrade: async rating => {grades.push(rating);},
      lifecycle: {ready: true, purpose: 'first', submitted: Boolean(attempt.submitted)}});
    return child.type(child.props);
  }, {});
  return {hooks, grades, fields};
}
async function settle(hooks, observed) {
  const pump = async () => {hooks.flush();await tick();hooks.render();};
  if (observed) {
    await waitForObservation(pump, observed, {label: 'saved code sidecar recovery'});
    return;
  }
  for (let i = 0; i < 5; i++) await pump();
}
function codeView(attempt, practice) {
  const hooks = createHooks(), grades = [], continuations = [];
  const load = loader(hooks.api, {
    'app/hooks/use-pyodide.ts': {usePyodide: () => ({isReady: true, error: null, retry() {}, cancel() {},
      async runPython() {throw Error('Restore must not execute code.');}})},
    'app/ai/use-report-study-ai-item.ts': {useReportStudyAIItem() {}},
    'app/assistance-display.tsx': {useAssistance: () => ({submit() {}}), useAssistanceDisplay() {}},
    'app/components/code-editor.tsx': {CodeEditor: () => null},
    'app/study-guidance.tsx': {StudyGuidance: () => null},
    'src/features/remediation/index.ts': {CodeRewriteLauncher: () => null},
    'app/math-text.tsx': {MathText: () => null},
  });
  const store = load('app/learning-draft-store.ts').createLearningDraftStore(attempt.attemptId);
  const draft = store.adapter(attempt.attemptId, 'code');
  for (const [key, value] of Object.entries(restoredFields(attempt, 'code'))) draft.write(key, value);
  hooks.mount(load('app/plugins/plugin-code.tsx').CodePlugin.renderUI, {
    data: {prompt: 'Write add.', initialCode: '', testCode: 'assert add(1, 2) == 3', solutionCode: '', explanation: ''},
    context: {draft, nonWordLearning: {ready: true, purpose: 'first', submitted: Boolean(attempt.submitted), practice,
      async continuePending() {continuations.push('pending');}}},
    onGrade: async rating => {grades.push(rating);},
  });
  return {hooks, draft, grades, continuations};
}

test('pending quiz converter cannot feed embedded correct/retry feedback to the actual finish handler', async () => {
  const f = await original('quiz', {selection: JSON.stringify(fakeQuiz), phase: 'retry-feedback'});
  const before = structuredClone(f.attempt), view = quizView(f.attempt);
  try {
    const finish = [...nodes(view.hooks.view())].find(node => node.type === 'button' && text(node).includes('继续'));
    if (finish) await finish.props.onClick();
    assert.deepEqual(view.grades, [], 'Restoring a pending checkpoint cannot request a formal correct grade.');
    assert.deepEqual(view.fields.nonwordQuizState, {selection: ['option-1'], first: null, phase: 'answer', retry: null});
    assert.doesNotMatch(text(view.hooks.view()), /回答正确|本次是辅助补练/);
    assert.deepEqual(f.attempt, before);assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
  } finally {view.hooks.unmount();}
});

test('quiz draft retains raw choices but discards all unconfirmed feedback and malformed choices', async () => {
  const f = await original('quiz', {selection: JSON.stringify(fakeQuiz)}, {submitted: false});
  const restored = restoredFields(f.attempt, 'quiz').nonwordQuizState;
  assert.deepEqual(restored, {selection: ['option-0'], first: null, phase: 'answer', retry: null});
  const malformed = {...f.attempt, checkpoint: {...f.attempt.checkpoint, pluginFields: {selection: JSON.stringify({selection: [1, {}], phase: 'feedback'})}}};
  assert.deepEqual(restoredFields(malformed, 'quiz').nonwordQuizState, {selection: [], first: null, phase: 'answer', retry: null});
});

test('resolved quiz actual finish uses saved original evaluation rather than a correct retry checkpoint', async () => {
  const f = await original('quiz', {selection: JSON.stringify(fakeQuiz)}, {outcome: 'incorrect'});
  const view = quizView(f.attempt);
  try {
    assert.equal(view.fields.nonwordQuizState.first.result.status, 'incorrect');
    assert.deepEqual(view.fields.nonwordQuizState.first.selection, ['option-1']);
    assert.equal(view.fields.nonwordQuizState.retry, null);
    assert.equal(view.fields.nonwordQuizState.phase, 'feedback');
    assert.doesNotMatch(text(view.hooks.view()),/错选：无/);
    await button(view.hooks.view(), '跳过补练或结束补练，继续').props.onClick();
    assert.deepEqual(view.grades, ['again']);
  } finally {view.hooks.unmount();}
});

test('resolved correct quiz remains correct without trusting stored result arrays', async () => {
  const f = await original('quiz', {selection: JSON.stringify({...fakeQuiz, first: null, phase: 'answer'})},
    {outcome: 'correct', answer: JSON.stringify(['option-0'])});
  const view = quizView(f.attempt);
  try {await button(view.hooks.view(), '继续').props.onClick();assert.deepEqual(view.grades, ['good']);}
  finally {view.hooks.unmount();}
});

test('pending code ignores checkpoint execution verdicts before actual plugin continuation', async () => {
  for (const submitted of [false, true]) for (const firstRunKind of ['correct', 'incorrect', 'forgotten']) {
    const f = await original('code', {code: 'visible edited source', stdin: 'input', phase: 'passed',
      firstRunKind, firstNeedsReview: 'false'}, {submitted});
    const before = structuredClone(f.attempt), view = codeView(f.attempt);
    try {
      await settle(view.hooks);
      const editor = [...nodes(view.hooks.view())].find(node => node.props.onChange && Object.hasOwn(node.props, 'readOnly'));
      assert.equal(editor.props.readOnly, false, 'An unconfirmed stored pass must not lock the editor.');
      const finish = button(view.hooks.view(), submitted ? '保留待核对结果，继续' : '继续');
      if (finish) await finish.props.onClick();
      assert.deepEqual(view.grades, []);
      assert.deepEqual(view.continuations, submitted ? ['pending'] : []);
      assert.equal(view.draft.read('firstRunKind', ''), submitted ? 'pending' : 'not-run');
      assert.equal(view.draft.read('codeState', ''), 'coding');
      assert.equal(view.draft.read('code', ''), 'visible edited source');assert.equal(view.draft.read('stdin', ''), 'input');
      assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
    } finally {view.hooks.unmount();}
  }
});

test('resolved code uses canonical first failure while legitimate execution sidecar still restores latest run', async () => {
  const f = await original('code', {code: 'visible source', stdin: 'input', phase: 'passed', firstRunKind: 'correct', firstNeedsReview: 'true'},
    {outcome: 'incorrect'});
  const recovered = restoredFields(f.attempt, 'code');
  assert.equal(recovered.firstRunKind, 'incorrect');assert.equal(recovered.firstNeedsReview, false);
  assert.equal(recovered.codeState, 'coding');assert.equal(recovered.firstTestOutput, f.attempt.evaluation.feedback);
  const attached = await attachPracticeDriver({}, f.runtime), practice = attached.runtime.practice;
  const identity = {attemptId: f.attempt.attemptId, revision: f.attempt.submitted.answerRevision,
    sourceVersion: f.attempt.binding.contentHash, testVersion: f.attempt.binding.contentHash};
  const first = {schemaVersion: 1, runId: 1, identity, status: 'failed', phase: 'program', outcome: 'student-error',
    assertionsPassed: 0, assertionsExecuted: 0, mapping: {prefixLineCount: 0, originalLineCount: 1},
    exception: {kind: 'NameError', message: 'missing', isAssertion: false,
      location: {origin: 'learner', file: '<learner>', line: 1, originalLine: 1}}};
  await practice.recordCodeReport(first, 'Saved first failure.');
  const latest = structuredClone(first);delete latest.exception;
  await practice.recordCodeReport({...latest, runId: 2, status: 'passed', phase: 'tests', outcome: 'success',
    assertionsPassed: 1, assertionsExecuted: 1}, 'Latest saved run passed.');
  const before = structuredClone(await f.runtime.repository.read(f.attempt.attemptId));
  const view = codeView(f.attempt, practice);
  try {
    await settle(view.hooks, () => view.draft.read('codeState', '') === 'passed'
      && view.draft.read('testOutput', '') === 'Latest saved run passed.');
    assert.equal(view.draft.read('firstRunKind', ''), 'incorrect');
    assert.equal(view.draft.read('firstNeedsReview', true), false);
    assert.equal(view.draft.read('firstTestCode', ''), f.attempt.submitted.answer);
    assert.equal(view.draft.read('firstTestOutput', ''), f.attempt.evaluation.feedback);
    assert.equal(view.draft.read('codeState', ''), 'passed');
    assert.equal(view.draft.read('testOutput', ''), 'Latest saved run passed.');
    assert.deepEqual((await practice.codeFeedback()).first, first);
    await button(view.hooks.view(), '继续').props.onClick();assert.deepEqual(view.grades, ['again']);
    assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
  } finally {view.hooks.unmount();}
});

test('recall raw answer and frozen assistance survive recovery without resolving a pending evaluation', async () => {
  const f = await original('recall', {answer: 'raw recall', hintLevel: '2', policyAttemptId: 'actual-policy', phase: 'answer'}, {answer: 'raw recall'});
  const fields = restoredFields(f.attempt, 'recall');
  assert.equal(fields.answer, 'raw recall');assert.equal(fields.result, null);
  assert.deepEqual(fields.recallAttempt, {schemaVersion: 1, attemptId: 'actual-policy', maxPreHintLevel: 2});
  assert.equal(f.attempt.formal, null);assert.equal(f.attempt.evaluation.status, 'pending');
});

test('code recovery observation waits for a held sidecar without executing or grading', async () => {
  const f = await original('code', {code: 'preserved code'}, {outcome: 'incorrect'});
  const attached = await attachPracticeDriver({}, f.runtime), practice = attached.runtime.practice;
  await practice.recordCodeReport({schemaVersion: 1, runId: 1,
    identity: {attemptId: f.attempt.attemptId, revision: f.attempt.submitted.answerRevision,
      sourceVersion: f.attempt.binding.contentHash, testVersion: f.attempt.binding.contentHash},
    status: 'passed', phase: 'tests', outcome: 'success', assertionsPassed: 1, assertionsExecuted: 1,
    mapping: {prefixLineCount: 0, originalLineCount: 1}}, 'Delayed saved run passed.');
  const gate = deferred(), before = structuredClone(await f.runtime.repository.read(f.attempt.attemptId));
  const held = {...practice, codeFeedback: async () => {await gate.promise;return practice.codeFeedback();}};
  const view = codeView(f.attempt, held);
  let observed = false;
  const observation = settle(view.hooks, () => view.draft.read('testOutput', '') === 'Delayed saved run passed.')
    .then(() => {observed = true;});
  try {
    for (let i = 0; i < 8; i++) await tick();
    assert.equal(observed, false, 'A few event-loop ticks are not proof that sidecar recovery completed.');
    assert.equal(view.draft.read('codeState', ''), 'coding');
    assert.deepEqual(view.grades, []);
    gate.resolve();await observation;
    assert.equal(view.draft.read('codeState', ''), 'passed');
    assert.equal(view.draft.read('firstRunKind', ''), 'incorrect');
    assert.deepEqual(view.grades, []);
    assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
  } finally {
    gate.resolve();
    try {await observation;} finally {view.hooks.unmount();}
  }
});
