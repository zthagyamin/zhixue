import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { IDBFactory } from 'fake-indexeddb';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {createNativeMathSourceCache,createPendingMathStepRuntime} from '../src/infrastructure/math-study/index.ts';
import { createNativeCourseSourceCache } from '../src/infrastructure/course-study/native-source-cache.ts';
import { nativeCourseTask, attachNativeCourseDriver } from '../src/infrastructure/course-study/native-host-runtime.ts';
import { createNonWordRuntime } from '../src/infrastructure/nonword-study/index.ts';
import { createNonWordPendingRuntime } from '../src/infrastructure/nonword-study/pending-runtime.ts';
import { createLocalAttemptRepository } from '../src/infrastructure/learning-attempt/index.ts';
import { courseTaskHash, resolveCourseTask } from '../src/domain/course-study/index.ts';
import { studyHash } from '../src/domain/sync/index.ts';
import { parseStudyItem, parseStudySnapshot, sealStudyItem } from '../app/account-study-content.ts';
import { wordBody } from './fixtures/account-study-fixtures.mjs';
import { createLearningDraftStore } from '../app/learning-draft-store.ts';
import { routableStudyItem } from '../app/account-study-content.ts';
import { adaptStudyItemForPlugin } from '../app/plugin-routing.ts';

globalThis.indexedDB = new IDBFactory();
const fixtureRows = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
let serial = 0;
async function fixture(mode = 'recall', submitted = true) {
  const support = structuredClone(fixtureRows.cases.find(row => row.valid && row.mode === mode).support);
  const item = { schemaVersion: 2, kind: 'practice', eventKind: 'due', itemKey: 'practice:original-question', contentHash: 'b'.repeat(64),
    learningSupport: support, practice: { questionType: mode, prompt: support.task.prompt, domain: 'course' } };
  const identity = { schemaVersion: 1, libraryId: `local-vault:${'a'.repeat(64)}`, itemKey: item.itemKey,
    contentHash: item.contentHash, localBindingHash: 'c'.repeat(64) };
  const body = { schemaVersion: 1, identity, item, taskHash: await courseTaskHash(resolveCourseTask(item)) };
  const capture = { ...body, captureId: await studyHash(body) };
  const scope = { workspaceId: 'native-pending', ownerId: `pending-native-${serial++}`, libraryId: identity.libraryId,
    snapshotId: 'local', itemKey: item.itemKey, contentHash: item.contentHash, groupId: 'group', roundId: 'round', cloud: false };
  const runtime = await createNonWordRuntime(scope, mode);
  if(submitted)await runtime.session.submit(mode === 'recall' ? 'RAW FIRST ANSWER' : '["option-1"]', 'unknown');
  else{
    await runtime.session.save('RAW PAUSED DRAFT',{answer:'RAW PAUSED DRAFT'});
    await runtime.session.updateView({intent:'practice',view:{purpose:'first',lessonStep:'independent',paused:true,referenceSeen:false}});
  }
  const attempt = runtime.session.snapshot(), cache = createNativeCourseSourceCache({ userId: scope.ownerId, libraryId: scope.libraryId });
  const options = { ownerId: scope.ownerId, libraryId: scope.libraryId, repository: runtime.repository,
    parseItem: parseStudyItem, parseSnapshot: parseStudySnapshot, nativeReference: row => cache.read(row.binding, row.attemptId) };
  async function associate() { await cache.save(capture); await cache.bindAttempt(attempt.attemptId, attempt.binding, capture.captureId); }
  return { support, item, identity, capture, scope, runtime, attempt, cache, options, associate };
}

test('production pending reader recovers old associated native capture after current source changed without mutation', async () => {
  const f = await fixture(); await f.associate();
  const changed = structuredClone(f.capture);
  changed.identity.contentHash = changed.item.contentHash = 'd'.repeat(64);
  changed.item.learningSupport.task.sources[0].excerpt += ' CURRENT VERSION';
  changed.taskHash = await courseTaskHash(resolveCourseTask(changed.item));
  const { captureId, ...body } = changed; assert.ok(captureId); changed.captureId = await studyHash(body);
  await f.cache.save(changed);
  const before = await f.runtime.repository.read(f.attempt.attemptId), outbox = await f.runtime.repository.pending();
  const pending = createNonWordPendingRuntime({ ...f.options, parseItem: async () => { throw Error('native must not parse portable'); } });
  assert.deepEqual((await pending.list()).map(row => row.attemptId), [f.attempt.attemptId]);
  const original = await pending.loadOriginal(f.attempt.attemptId);
  assert.equal(original.item, null); assert.equal(original.snapshot, undefined);
  assert.deepEqual(original.nativeCapture, f.capture); assert.equal(original.capability, 'complete');
  assert.equal(original.referenceVerified, true); assert.equal(original.resumable, true);
  assert.notEqual(await studyHash(f.item), original.attempt.binding.contentHash);
  await pending.listDetailed(); await pending.loadOriginal(f.attempt.attemptId);
  assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
  assert.deepEqual(await f.runtime.repository.pending(), outbox);
});

test('missing old association cannot borrow an available current identity capture', async () => {
  const f = await fixture(); await f.cache.save(f.capture);
  const pending = createNonWordPendingRuntime(f.options), original = await pending.loadOriginal(f.attempt.attemptId);
  assert.equal(original.capability, 'reference-unavailable'); assert.equal(original.resumable, false);
  assert.equal(original.nativeCapture, undefined); assert.match(original.notice, /未使用当前新版本参考/);
  assert.equal(original.attempt.submitted.answer, 'RAW FIRST ANSWER');
});

test('native recovery rejects source/task mismatch and complete V1 association changes', async () => {
  const f = await fixture(); await f.associate();
  for (const change of [value => { value.identity.contentHash = 'd'.repeat(64); }, value => { value.taskHash = 'd'.repeat(64); }]) {
    const capture = structuredClone(f.capture); change(capture);
    const original = await createNonWordPendingRuntime({ ...f.options, nativeReference: async () => capture }).loadOriginal(f.attempt.attemptId);
    assert.equal(original.resumable, false); assert.equal(original.referenceVerified, false);
  }
  const mismatch = { ...f.attempt, checkpoint: { ...f.attempt.checkpoint, mode: 'quiz' } };
  const pending = createNonWordPendingRuntime({ ...f.options, repository: { list: async () => [mismatch], read: async () => mismatch } });
  assert.equal((await pending.loadOriginal(mismatch.attemptId)).resumable, false);
  for (const field of ['groupId', 'roundId']) {
    const altered = { ...f.attempt, binding: { ...f.attempt.binding, [field]: 'different' } };
    const runtime = createNonWordPendingRuntime({ ...f.options, repository: { list: async () => [altered], read: async () => altered } });
    assert.equal((await runtime.loadOriginal(altered.attemptId)).resumable, false);
  }
});

test('owner/library and account paths cannot borrow a native proof; vocabulary exclusion remains intact', async () => {
  const f = await fixture(); await f.associate();
  for (const extra of [{ ownerId: 'other' }, { libraryId: `local-vault:${'e'.repeat(64)}` }]) {
    const pending = createNonWordPendingRuntime({ ...f.options, ...extra });
    assert.deepEqual(await pending.list(), []); await assert.rejects(pending.loadOriginal(f.attempt.attemptId), /scope/);
  }
  let reads = 0;
  const cloud = { list: async () => [f.attempt], read: async () => f.attempt, reference: async () => null };
  const account = createNonWordPendingRuntime({ ...f.options, cloud, nativeReference: async () => { reads++; return f.capture; } });
  assert.equal((await account.loadOriginal(f.attempt.attemptId)).resumable, false); assert.equal(reads, 0);
  const word = await sealStudyItem(wordBody()), row = { ...f.attempt,
    binding: { ...f.attempt.binding, itemKey: word.itemKey, contentHash: word.contentHash }, checkpoint: { ...f.attempt.checkpoint, mode: 'flashcard' } };
  const vocabulary = createNonWordPendingRuntime({ ...f.options, nativeReference: async () => null,
    repository: { list: async () => [row], read: async () => row, reference: async () => word } });
  assert.deepEqual(await vocabulary.list(), []);
});

test('resolved but unlinked original recovers existing identity and read/open does not grade or claim', async () => {
  const f = await fixture(); await f.associate();
  await f.runtime.session.assess({ status: 'correct', source: 'self-assess', rating: 'good', explanation: 'Explicit fixture assessment.' });
  const pending = createNonWordPendingRuntime(f.options), original = await pending.loadOriginal(f.attempt.attemptId);
  assert.equal(original.attempt.evaluation.status, 'resolved'); assert.equal(original.resumable, true);
  const transport = { supported: () => true, capture: async () => { throw Error('must not capture'); }, read: async () => { throw Error('must not read network'); },
    grade: async () => { throw Error('must not grade'); }, claim: async () => { throw Error('must not claim'); } };
  const scope = { ...f.scope, ...original.attempt.binding, nativeCourseIdentity: original.nativeCapture.identity,
    nativeCourseCapture: original.nativeCapture };
  const prepared = await nativeCourseTask(scope, 'first', undefined, undefined, transport);
  const runtime = await createNonWordRuntime(scope, 'recall', { binding: original.attempt.binding, existing: original.attempt });
  const driver = await attachNativeCourseDriver({ runtime, answer: () => '', fields: () => ({}), restore: () => ({}), phase: () => 'answering' }, runtime, prepared, transport);
  assert.equal(driver.course.originalAnswer(), original.attempt.submitted.answer);
  assert.deepEqual(runtime.session.snapshot(), original.attempt);
  assert.equal(runtime.session.snapshot().formal, null);
});

// Run the production component with its real display adapters and draft store;
// intercept only the host boundary so its exact recovered context can be examined.
function loadReview(host) {
  const file = new URL('../app/study-dashboard/pending-review.tsx', import.meta.url), require = createRequire(import.meta.url);
  const pass = ({ children }) => children;
  const modules = {
    '../learning-draft-store': { createLearningDraftStore }, '../learning-draft': { LearningDraftBoundary: pass, LearningDraftLeaveGuard: () => null },
    '../account-study-content': { routableStudyItem }, '../plugin-routing': { adaptStudyItemForPlugin },
    '../components/ai-sidebar/study-ai-workspace': { StudyAIOfflineContext: pass }, './nonword-plugin-host': { NonWordPluginHost: host },
    '../../src/infrastructure/learning-attempt': { createLocalAttemptRepository },
    '../plugins': { registry: { get: () => ({ id: '@zhixue/plugin-recall', renderUI: () => null }) } },
    './original-question-service': { originalQuestionService: () => { throw Error('native cannot use account question service'); } },
  };
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', output)(specifier => modules[specifier] ?? (specifier.startsWith('.') ? {} : require(specifier)), exports);
  return exports.PendingAttemptReview;
}
function loadWorkspace(queue) {
  const file = new URL('../app/study-dashboard/pending-workspace.tsx', import.meta.url), require = createRequire(import.meta.url);
  const modules = {
    '../../src/infrastructure/nonword-study': { createNonWordPendingRuntime },
    '../../src/infrastructure/course-study': { createNativeCourseSourceCache },
    '../../src/infrastructure/math-study': {createNativeMathSourceCache,createPendingMathStepRuntime},
    '../../src/features/calculation-study': {PendingMathStepQueue:()=>null},
    '../account-study-content': { parseStudyItem, parseStudySnapshot },
    '../../src/features/nonword-study': { PendingAnswerQueue: queue },
    '../math-text': { MathText: ({ text }) => text },
  };
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', output)(specifier => modules[specifier] ?? (specifier.startsWith('.') ? {} : require(specifier)), exports);
  return exports.PendingAnswerWorkspace;
}
test('actual workspace queue reads the associated capture locally and opens only on explicit resume', async () => {
  const f = await fixture(); await f.associate(); let port, calls = 0;
  const Workspace = loadWorkspace(props => { port = props.port; return null; });
  const transport = { supported: () => { calls++; return true; }, capture: () => { calls++; }, read: () => { calls++; }, grade: () => { calls++; }, claim: () => { calls++; } };
  const before = await f.runtime.repository.read(f.attempt.attemptId), outbox = await f.runtime.repository.pending();
  renderToStaticMarkup(React.createElement(Workspace, { ...f.scope, ready: true, records: [], nativeCourse: transport }));
  assert.ok(port); const row = (await port.list()).find(row => row.attemptId === f.attempt.attemptId);
  const source = await port.reference(row);
  assert.equal(source.title, 'original-question'); assert.equal(source.prompt, f.item.practice.prompt);
  assert.equal(source.reference, f.support.criteria.map(point => point.text).join('\n'));
  assert.deepEqual(source.binding, f.attempt.binding); assert.equal(calls, 0);
  await port.onResume(row); assert.equal(calls, 0);
  assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId), before);
  assert.deepEqual(await f.runtime.repository.pending(), outbox);
});

test('native paused first draft retains prompt and source without exposing unseen reference before submission', async () => {
  const f=await fixture('recall',false);await f.associate();let port;
  const Workspace=loadWorkspace(props=>{port=props.port;return null;});
  const before=await f.runtime.repository.read(f.attempt.attemptId);
  renderToStaticMarkup(React.createElement(Workspace,{...f.scope,ready:true,records:[]}));
  const row=(await port.list()).find(row=>row.attemptId===f.attempt.attemptId);
  assert.ok(row);const source=await port.reference(row);
  assert.equal(source.prompt,f.item.practice.prompt);assert.ok(source.sourceLabel);
  assert.equal(source.reference,undefined,'a source read must not reveal an unsubmitted first rubric without saved assistance');
  assert.deepEqual(await f.runtime.repository.read(f.attempt.attemptId),before);
  assert.equal(before.submitted,null);assert.equal(before.checkpoint.view.referenceSeen,false);
});
test('actual resume component passes native capture and protected transport to host without invented portable/private fields', async () => {
  const f = await fixture(); await f.associate(); const original = await createNonWordPendingRuntime(f.options).loadOriginal(f.attempt.attemptId);
  let hostProps;
  const Review = loadReview(props => { hostProps = props; return React.createElement('div', null, props.data.prompt); });
  const transport = { supported: () => false }, services = { ...f.scope, current: () => true, records: () => [], nativeCourse: transport,
    questionAi: () => { throw Error('no legacy grading'); } };
  const html = renderToStaticMarkup(React.createElement(Review, { original, services, deviceId: '', onClose() {} }));
  assert.match(html, /original-question/); assert.match(html, /隔离合成课程示例/);
  assert.deepEqual(hostProps.recovered, original.attempt); assert.equal(hostProps.context.nativeCourse, transport);
  const scope = hostProps.context.nonWordScope;
  assert.deepEqual(scope.nativeCourseIdentity, f.identity); assert.deepEqual(scope.nativeCourseCapture, f.capture);
  assert.equal(scope.courseReference, undefined); assert.equal(scope.snapshotId, 'local');
  assert.equal(scope.groupId, f.attempt.binding.groupId); assert.equal(scope.roundId, f.attempt.binding.roundId);
  assert.equal(hostProps.data.id, 'original-question'); assert.equal(hostProps.data.stateRef, undefined);
  assert.equal(hostProps.context.contentSource.data.contentHash, f.identity.contentHash);
  assert.equal(hostProps.context.gradeRecall, undefined); assert.equal(hostProps.context.askTutor, undefined);
  hostProps = null;
  renderToStaticMarkup(React.createElement(Review, { original, services: { ...services, ownerId: 'other-owner' }, deviceId: '', onClose() {} }));
  assert.equal(hostProps, null);
});
