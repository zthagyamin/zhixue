import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks, loader, nodes, text, tick} from './helpers/causal-harness.mjs';
import {codeRunFailure} from '../src/domain/remediation/index.ts';
import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {applyAttemptMutation, parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {attemptFingerprint, evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {restoredFields} from '../src/infrastructure/nonword-study/index.ts';

let formatCodeFailureFeedback;
try {({formatCodeFailureFeedback} = await import('../src/domain/remediation/code-feedback.ts'));}
catch (error) {if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;}
const missing = () => assert.equal(typeof formatCodeFailureFeedback, 'function');
const trace = (exception, file = '<exec>', line = 3) => `PythonError: Traceback (most recent call last):\n  File "/lib/python/pyodide/_base.py", line 597, in eval_code\n  File "${file}", line ${line}, in add\n${exception}\n`;
const failure = (message, extra = {}) => Object.assign(new Error(message), {name: 'PythonError', executionPhase: 'program', ...extra});

test('formatter exposes the actual terminal exception and last traceback frame', () => {
  missing(); const feedback = formatCodeFailureFeedback(failure(trace("NameError: name 'total' is not defined")));
  assert.equal(feedback.exception, "NameError: name 'total' is not defined");
  assert.deepEqual(feedback.location, {file: '<exec>', line: 3, functionName: 'add'});
  assert.match(feedback.summary, /NameError: name 'total' is not defined/);
  assert.match(feedback.summary, /<exec>.*3/);
  assert.equal(feedback.assertionSource, undefined);
});

test('failed assertion maps only an explicitly named public-test frame to the supplied test source', () => {
  missing(); const testCode = '# original tests\nassert add(1, 2) == 3';
  const feedback = formatCodeFailureFeedback(failure(trace('AssertionError', '<题目测试>', 2), {executionPhase: 'tests', assertionFailure: true}), {testCode});
  assert.equal(feedback.assertionSource, 'assert add(1, 2) == 3');
  assert.match(feedback.summary, /assert add\(1, 2\) == 3/);
  assert.doesNotMatch(feedback.summary, /实际(?:返回|输出|值).*\d|输入值|期望值/);
  assert.equal(formatCodeFailureFeedback(failure(trace('AssertionError', '<exec>', 2)), {testCode}).assertionSource, undefined);
});

test('a deeper learner assertion cannot be mislabeled as the outer public assertion', () => {
  missing(); const diagnostic = 'Traceback (most recent call last):\n  File "<题目测试>", line 1, in <module>\n  File "<exec>", line 7, in add\n    assert b != 0\nAssertionError';
  const feedback = formatCodeFailureFeedback(failure(diagnostic, {executionPhase: 'tests', assertionFailure: true}),
    {testCode: 'assert add(1, 2) == 3'});
  assert.equal(feedback.assertionSource, '    assert b != 0'); assert.equal(feedback.location.file, '<exec>');
  assert.doesNotMatch(feedback.summary, /assert add/);
});

test('unknown execution and technical failures retain the original classification despite concrete diagnostics', () => {
  missing(); for (const [extra, kind] of [
    [{executionPhase: 'tests', assertionFailure: false}, 'unknown'], [{name: 'RuntimeError'}, 'environment-error'],
    [{testDefinitionError: true}, 'test-error'], [{name: 'AbortError'}, 'cancelled'], [{name: 'TimeoutError'}, 'timeout'],
  ]) {
    const error = failure(trace('NameError: missing_fixture'), extra), before = structuredClone(codeRunFailure(error));
    const feedback = formatCodeFailureFeedback(error);
    assert.match(feedback.summary, /NameError: missing_fixture/);
    assert.deepEqual(codeRunFailure(error), before); assert.equal(before.kind, kind);
  }
});

test('chained tracebacks keep the final observed fault; absent evidence does not invent locations or values', () => {
  missing(); const feedback = formatCodeFailureFeedback(failure(trace('ValueError: first') + '\nDuring handling of the above exception, another exception occurred:\n\n' + trace('TypeError: final', '<exec>', 8)));
  assert.equal(feedback.exception, 'TypeError: final'); assert.equal(feedback.location.line, 8);
  const absent = formatCodeFailureFeedback(failure('only stdout, no exception line'));
  assert.equal(absent.exception, undefined); assert.equal(absent.location, undefined); assert.equal(absent.assertionSource, undefined);
  assert.doesNotMatch(absent.summary, /实际返回|期望值|输入值/);
});

test('long diagnostics stay concise while an explicit assertion source is never shortened', () => {
  missing(); const assertion = 'assert len("' + 'x'.repeat(3000) + '") == 0';
  const feedback = formatCodeFailureFeedback(failure('stdout '.repeat(1800) + '\n' + trace('AssertionError', '<题目测试>', 1), {executionPhase: 'tests', assertionFailure: true}), {testCode: assertion});
  assert.equal(feedback.assertionSource, assertion); assert.ok(feedback.summary.length < 1600);
});

async function fixture({outcomes, legacy = false} = {}) {
  const hooks = createHooks(), rows = new Map(), assessments = [], grades = [], children = [];
  let operation = 0;
  const binding = {ownerId: 'feedback-owner', libraryId: 'library', snapshotId: 'snapshot', itemKey: 'code',
    contentHash: 'a'.repeat(64), groupId: 'group', roundId: 'round'};
  const repository = {read: async id => rows.get(id) ?? null, mutate: async raw => {
    const mutation = parseAttemptMutation(raw), receipt = applyAttemptMutation(rows.get(mutation.attemptId) ?? null, mutation, await attemptFingerprint(mutation));
    if (receipt.status === 'accepted') rows.set(mutation.attemptId, receipt.attempt);
    return {...receipt, durable: receipt.status !== 'conflict'};
  }};
  const session = createNonWordSession({repository, binding, attemptId: 'first', formalEventId: 'formal', mode: 'code', purpose: 'first',
    now: () => '2026-10-06T00:00:00.000Z', newId: () => `operation-${++operation}`, fingerprint: attemptFingerprint, evaluationFingerprint});
  await session.open();
  const lifecycle = {ready: true, purpose: 'first', intent: 'review', get submitted() {return Boolean(session.snapshot().submitted);},
    submit: answer => session.submit(answer), assess: async outcome => {assessments.push(outcome); await session.assess(outcome);},
    waitForReview: () => session.pending('invalid'), continuePending: async () => {}, recordRemediation: async (answer, outcome) => children.push({answer, outcome})};
  const runner = {isReady: true, error: null, retry() {}, cancel() {}, async runPython() {const result = outcomes.shift(); if (result instanceof Error) throw result; return result;}};
  const load = loader(hooks.api, {'app/hooks/use-pyodide.ts': {usePyodide: () => runner},
    'app/ai/use-report-study-ai-item.ts': {useReportStudyAIItem() {}},
    'app/assistance-display.tsx': {useAssistance: () => ({submit() {}}), useAssistanceDisplay() {}},
    'app/components/code-editor.tsx': {CodeEditor: () => null}, 'app/study-guidance.tsx': {StudyGuidance: () => null},
    'src/features/remediation/index.ts': {CodeRewriteLauncher: () => null}, 'app/math-text.tsx': {MathText: () => null}});
  const store = load('app/learning-draft-store.ts').createLearningDraftStore('code-feedback'), draft = store.adapter('code', 'code');
  const props = {data: {prompt: 'Implement add.', initialCode: 'original source', testCode: 'assert add(1, 2) == 3', solutionCode: '', explanation: ''},
    context: {draft, ...(!legacy ? {nonWordLearning: lifecycle} : {})},
    onGrade: async rating => {grades.push(rating); const ticket = draft.begin(); if (ticket) store.commit(ticket, () => {});}};
  hooks.mount(load('app/plugins/plugin-code.tsx').CodePlugin.renderUI, props); hooks.flush();
  const settle = async () => {for (let i = 0; i < 4; i++) {hooks.flush(); await tick(); hooks.render();}};
  return {hooks, draft, props, session, assessments, grades, children, async run() {
    const run = [...nodes(hooks.view())].find(node => node.type === 'button' && text(node).includes('运行测试'));
    await run.props.onClick(); await settle();
  }, async edit(value) {const editor = [...nodes(hooks.view())].find(node => node.props.onChange && Object.hasOwn(node.props, 'value') && Object.hasOwn(node.props, 'readOnly')); editor.props.onChange(value); await settle();}};
}

test('actual nonword hook saves concrete first fault, displays it before details and restores canonical feedback', async () => {
  const diagnostic = 'stdout '.repeat(1800) + '\n' + trace("NameError: name 'total' is not defined");
  const f = await fixture({outcomes: [failure(diagnostic)]}); await f.run();
  assert.match(f.assessments[0].explanation, /NameError: name 'total' is not defined/);
  assert.match(f.draft.read('firstTestOutput', ''), /<exec>.*3/);
  assert.equal(f.session.snapshot().submitted.answer, 'original source');
  const restored = restoredFields(f.session.snapshot(), 'code'); assert.match(restored.firstTestOutput, /NameError/);
  const disclosure = [...nodes(f.hooks.view())].find(node => node.type === 'details' && text(node).includes('查看运行详情'));
  assert.ok(disclosure); assert.equal(disclosure.props.open, undefined); assert.equal(text([...nodes(disclosure)].find(node => node.type === 'pre')), diagnostic);
  const visible = [...nodes(f.hooks.view())].filter(node => node.type === 'p' && ![...nodes(disclosure)].includes(node));
  assert.ok(visible.some(node => /NameError/.test(text(node)))); assert.deepEqual(f.grades, ['again']); f.hooks.unmount();
});

test('a changed failing child keeps original code and diagnosis immutable; the legacy handler keeps full feedback', async () => {
  const f = await fixture({outcomes: [failure(trace('NameError: original')), failure(trace('ZeroDivisionError: child', '<exec>', 7))]});
  await f.run(); const original = f.draft.read('firstTestOutput', '');
  await f.edit('edited child source'); await f.run();
  assert.equal(f.session.snapshot().submitted.answer, 'original source'); assert.equal(f.draft.read('firstTestOutput', ''), original);
  assert.equal(f.assessments.length, 1); assert.match(f.children[0].outcome.explanation, /ZeroDivisionError: child/);
  assert.deepEqual(f.grades, ['again']); f.hooks.unmount();
  const diagnostic = trace('NameError: legacy'); const old = await fixture({outcomes: [failure(diagnostic)], legacy: true}); await old.run();
  assert.equal(old.draft.read('firstTestOutput', ''), diagnostic); assert.equal(old.assessments.length, 0); old.hooks.unmount();
});

test('structured feedback uses captured case values and mapped original learner positions; report overrides legacy flags',()=>{
 const report={schemaVersion:1,runId:7,status:'failed',phase:'tests',outcome:'student-error',assertionsPassed:0,assertionsExecuted:1,mapping:{prefixLineCount:3,originalLineCount:4},firstFailure:{caseId:'sum',functionName:'add',args:[1,2],kwargs:{},expected:3,actual:4,hint:'Check addition.'}};
 const error=failure('full details',{report,assertionFailure:false,testDefinitionError:true});
 const feedback=formatCodeFailureFeedback(error);assert.equal(feedback.firstFailure.actual,4);assert.match(feedback.summary,/输入.*1.*2/);assert.match(feedback.summary,/期望.*3/);assert.match(feedback.summary,/实际.*4/);assert.equal(codeRunFailure(error).kind,'student-error');
 const unknown={...report,outcome:'unknown',firstFailure:undefined,exception:{kind:'TypeError',message:'AssertionError text',isAssertion:false,location:{origin:'tests',file:'<题目测试>',line:1}}};delete unknown.firstFailure;
 assert.equal(codeRunFailure(failure('AssertionError text',{report:unknown,assertionFailure:true})).kind,'unknown');
 const learner={...unknown,phase:'program',outcome:'student-error',exception:{kind:'NameError',message:'missing',isAssertion:false,location:{origin:'learner',file:'<learner>',line:5,originalLine:2}}};
 assert.equal(formatCodeFailureFeedback(failure('details',{report:learner})).location.line,2);
 const prefix={...learner,phase:'preparation',outcome:'environment-error',exception:{...learner.exception,location:{origin:'preparation',file:'<learner>',line:1}}};assert.match(formatCodeFailureFeedback(failure('details',{report:prefix})).summary,/依赖准备位置/);
});
