import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { indexedDB, IDBDatabase } from 'fake-indexeddb';
import { createNativeCourseSourceCache } from '../src/infrastructure/course-study/native-source-cache.ts';
import { createLocalCourseEvidenceRepository } from '../src/infrastructure/course-study/evidence-local.ts';
import { studyHash } from '../src/domain/sync/index.ts';
import { applyAttemptMutation } from '../src/domain/learning-attempt/index.ts';
import { courseTaskHash, resolveCourseTask, courseDiagnosticHash, attemptEvaluationForDiagnostic } from '../src/domain/course-study/index.ts';
import { evaluationFingerprint } from '../src/infrastructure/course-study/fingerprint.ts';

globalThis.indexedDB = indexedDB;
const at = '2026-10-06T00:00:00.000Z';
const dbName = 'zhixue-native-course-sources-v1';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
let serial = 0;
async function fixture() {
  const scope = { userId: `native-owner-${serial++}`, libraryId: `local-vault:${'a'.repeat(64)}` };
  const support = structuredClone(fixtures.cases.find(row => row.valid && row.mode === 'recall').support);
  const item = { schemaVersion: 2, kind: 'practice', eventKind: 'due', itemKey: 'practice:question-one', contentHash: 'b'.repeat(64), learningSupport: support,
    practice: { domain: 'course', questionType: 'recall', prompt: support.task.prompt } };
  const identity = { schemaVersion: 1, libraryId: scope.libraryId, itemKey: item.itemKey, contentHash: item.contentHash, localBindingHash: 'c'.repeat(64) };
  const body = { schemaVersion: 1, identity, item, taskHash: await courseTaskHash(resolveCourseTask(item)) };
  const capture = { ...body, captureId: await studyHash(body) };
  const binding = { ownerId: scope.userId, libraryId: scope.libraryId, snapshotId: 'local', itemKey: item.itemKey, contentHash: item.contentHash, groupId: 'group', roundId: 'round' };
  const cache = createNativeCourseSourceCache(scope);
  return { scope, support, item, capture, binding, cache };
}
async function altered(f, changeIdentity = true) {
  const next = structuredClone(f.capture);
  next.item.learningSupport.task.sources[0].excerpt += ' New original version.';
  if (changeIdentity) next.identity.contentHash = next.item.contentHash = 'd'.repeat(64);
  next.taskHash = await courseTaskHash(resolveCourseTask(next.item));
  const { captureId, ...body } = next; assert.ok(captureId);
  next.captureId = await studyHash(body);
  return next;
}
async function tamper(storeName, key, mutate) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName), get = store.get(key);
      get.onsuccess = () => store.put(mutate(get.result));
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
test('native cache survives reload, retains old captures and acknowledges exact repeated saves/links', async () => {
  const f = await fixture();
  assert.notEqual(await studyHash(f.item), f.item.contentHash);
  assert.deepEqual(await f.cache.save(f.capture), { durable: true, captureId: f.capture.captureId });
  assert.deepEqual(await f.cache.save(structuredClone(f.capture)), { durable: true, captureId: f.capture.captureId });
  const receipt = await f.cache.bindAttempt('first', f.binding, f.capture.captureId);
  assert.deepEqual(receipt, { durable: true, captureId: f.capture.captureId });
  assert.deepEqual(await f.cache.bindAttempt('first', f.binding, f.capture.captureId), receipt);
  const next = await altered(f); await f.cache.save(next);
  const reload = createNativeCourseSourceCache(f.scope);
  assert.deepEqual(await reload.read(f.binding, 'first'), f.capture);
  assert.deepEqual(await reload.byIdentity(f.capture.identity), f.capture);
  assert.deepEqual(await reload.byIdentity(next.identity), next);
  const escaped = await reload.read(f.binding, 'first'); escaped.item.title = 'mutated caller object';
  assert.deepEqual(await reload.read(f.binding, 'first'), f.capture);
});
test('native identity and complete attempt links are immutable under sequential and concurrent writes', async () => {
  const f = await fixture(), conflicting = await altered(f, false);
  const saves = await Promise.allSettled([f.cache.save(f.capture), f.cache.save(conflicting)]);
  assert.equal(saves.filter(row => row.status === 'fulfilled').length, 1);
  const saved = await f.cache.byIdentity(f.capture.identity);
  const rejected = saved.captureId === f.capture.captureId ? conflicting : f.capture;
  await assert.rejects(f.cache.save(rejected), /conflict/);
  await f.cache.bindAttempt('first', f.binding, saved.captureId);
  for (const field of ['groupId', 'roundId', 'snapshotId', 'itemKey', 'contentHash', 'ownerId', 'libraryId']) {
    const binding = { ...f.binding, [field]: field === 'contentHash' ? 'e'.repeat(64) : 'other' };
    await assert.rejects(f.cache.bindAttempt('first', binding, saved.captureId));
    await assert.rejects(f.cache.read(binding, 'first'));
  }
  const next = await altered(f); await f.cache.save(next);
  await assert.rejects(f.cache.bindAttempt('first', { ...f.binding, contentHash: next.item.contentHash }, next.captureId), /conflict/);
  const newerBinding = { ...f.binding, contentHash: next.item.contentHash };
  const links = await Promise.allSettled([f.cache.bindAttempt('raced', f.binding, saved.captureId), f.cache.bindAttempt('raced', newerBinding, next.captureId)]);
  assert.equal(links.filter(row => row.status === 'fulfilled').length, 1);
  const originalWon = links[0].status === 'fulfilled';
  assert.equal((await f.cache.read(originalWon ? f.binding : newerBinding, 'raced')).captureId, originalWon ? saved.captureId : next.captureId);
  await assert.rejects(f.cache.read(originalWon ? newerBinding : f.binding, 'raced'), /binding/);
  assert.equal(await f.cache.read(f.binding, 'missing'), null);
});
test('cache isolates browser owners/libraries and cannot link an unsaved capture', async () => {
  const f = await fixture(); await f.cache.save(f.capture);
  await assert.rejects(f.cache.bindAttempt('first', f.binding, 'e'.repeat(64)), /missing/);
  const owner = createNativeCourseSourceCache({ ...f.scope, userId: 'other-owner' });
  assert.equal(await owner.byIdentity(f.capture.identity), null);
  await assert.rejects(owner.bindAttempt('first', f.binding, f.capture.captureId), /scope/);
  const libraryId = `local-vault:${'e'.repeat(64)}`, library = createNativeCourseSourceCache({ ...f.scope, libraryId });
  await assert.rejects(library.save(f.capture), /scope/);
  await assert.rejects(library.byIdentity(f.capture.identity), /scope/);
  assert.equal(await library.byIdentity({ ...f.capture.identity, libraryId }), null);
});
test('aborted cache transactions never return durable receipts and retries recover after a lost caller receipt', async () => {
  const f = await fixture(), transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
    return tx;
  };
  try { await assert.rejects(f.cache.save(f.capture)); } finally { IDBDatabase.prototype.transaction = transaction; }
  assert.equal(await f.cache.byIdentity(f.capture.identity), null);
  async function loseReadback(action) {
    let committed = false;
    IDBDatabase.prototype.transaction = function (...args) {
      if (committed && args[1] !== 'readwrite') { committed = false; throw Error('receipt readback lost'); }
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => { committed = true; });
      return tx;
    };
    try { await assert.rejects(action(), /receipt readback lost/); }
    finally { IDBDatabase.prototype.transaction = transaction; }
  }
  await loseReadback(() => f.cache.save(f.capture));
  assert.deepEqual(await f.cache.byIdentity(f.capture.identity), f.capture);
  await loseReadback(() => f.cache.bindAttempt('first', f.binding, f.capture.captureId));
  assert.deepEqual(await f.cache.read(f.binding, 'first'), f.capture);
  assert.equal((await f.cache.save(f.capture)).durable, true);
  assert.equal((await f.cache.bindAttempt('first', f.binding, f.capture.captureId)).durable, true);
  const saved = globalThis.indexedDB; delete globalThis.indexedDB;
  try { await assert.rejects(f.cache.save(f.capture), /unavailable/); } finally { globalThis.indexedDB = saved; }
});
test('aborted attempt link is absent and corrupt captures or link metadata fail closed', async () => {
  const f = await fixture(); await f.cache.save(f.capture);
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
    return tx;
  };
  try { await assert.rejects(f.cache.bindAttempt('first', f.binding, f.capture.captureId)); }
  finally { IDBDatabase.prototype.transaction = transaction; }
  assert.equal(await f.cache.read(f.binding, 'first'), null);
  await f.cache.bindAttempt('first', f.binding, f.capture.captureId);
  const key = [f.scope.userId, f.scope.libraryId, f.capture.captureId];
  await tamper('captures', key, row => ({ ...row, capture: { ...row.capture, taskHash: 'e'.repeat(64) } }));
  await assert.rejects(f.cache.read(f.binding, 'first'));
  await assert.rejects(f.cache.byIdentity(f.capture.identity));
  const second = await fixture(); await second.cache.save(second.capture); await second.cache.bindAttempt('first', second.binding, second.capture.captureId);
  await tamper('attempts', [second.scope.userId, second.scope.libraryId, 'first'], row => ({ ...row, binding: { ...row.binding, roundId: 'changed' } }));
  await assert.rejects(second.cache.read(second.binding, 'first'), /binding/);
});
test('cache integrity binds attempt identity and rejects a pointer to another valid source capture', async () => {
  const f = await fixture(); await f.cache.save(f.capture); await f.cache.bindAttempt('first', f.binding, f.capture.captureId);
  await tamper('attempts', [f.scope.userId, f.scope.libraryId, 'first'], row => ({ ...row, key: [f.scope.userId, f.scope.libraryId, 'copied-attempt'] }));
  await assert.rejects(f.cache.read(f.binding, 'copied-attempt'), /integrity/);
  const changed = structuredClone(f.capture); changed.identity.localBindingHash = 'e'.repeat(64);
  const { captureId, ...body } = changed; assert.ok(captureId); changed.captureId = await studyHash(body);
  await f.cache.save(changed);
  await tamper('attempts', [f.scope.userId, f.scope.libraryId, 'first'], row => ({ ...row, captureId: changed.captureId }));
  await assert.rejects(f.cache.read(f.binding, 'first'), /integrity/);
});
async function evidenceFixture() {
  const f = await fixture(); await f.cache.save(f.capture); await f.cache.bindAttempt('first', f.binding, f.capture.captureId);
  const attempts = new Map();
  function makeAttempt(id, parentAttemptId, answer) {
    let attempt = applyAttemptMutation(null, { schemaVersion: 1, kind: 'checkpoint', attemptId: id, binding: f.binding, operationId: `${id}-draft`, expectedRevision: 0, updatedAt: at, parentAttemptId, answer, checkpoint: { phase: 'answering', position: 0, traversed: false, mode: 'recall' } }).attempt;
    attempt = applyAttemptMutation(attempt, { schemaVersion: 1, kind: 'submit', attemptId: id, binding: f.binding, operationId: `${id}-submit`, expectedRevision: attempt.revision, updatedAt: at, answerRevision: attempt.answerRevision, assistance: 'independent' }).attempt;
    attempts.set(id, attempt); return attempt;
  }
  const original = makeAttempt('first', null, f.support.criteria[0].text);
  const options = { cloud: false, readAttempt: async id => attempts.get(id) ?? null, readItem: async () => f.item, readNativeCapture: (binding, id) => f.cache.read(binding, id) };
  const bind = { schemaVersion: 1, kind: 'bind', attemptId: 'first', binding: f.binding, operationId: 'bind', expectedRevision: 0, updatedAt: at, taskId: f.support.task.taskId, taskHash: f.capture.taskHash, parentAttemptId: null, parentEvidenceHash: null };
  return { ...f, original, options, bind, makeAttempt, repository: createLocalCourseEvidenceRepository(f.scope, options) };
}
async function modelMutation(f, status = 'correct') {
  const points = f.support.criteria, matched = status === 'correct' ? points : [], errors = status === 'correct' ? [] : points;
  const diagnostic = { schemaVersion: 1, status, source: 'model', feedback: 'Synthetic evidence.', matchedPointIds: matched.map(p => p.id), missedPointIds: [], errorPointIds: errors.map(p => p.id), wrongOptionIds: [], missingOptionIds: [], pointEvidence: points.map(p => ({ pointId: p.id, sourceId: p.sourceIds[0], sourceQuote: f.support.task.sources[0].excerpt, answerQuote: f.original.submitted.answer, reason: 'Synthetic comparison.' })) };
  const trace = { provider: 'synthetic', modelId: 'fixture', promptVersion: 'v1', ruleVersion: 'v1', requestId: 'request' };
  return { schemaVersion: 1, kind: 'diagnose', attemptId: 'first', binding: f.binding, operationId: 'diagnose', expectedRevision: 1, updatedAt: at, answerRevision: f.original.submitted.answerRevision, diagnostic, trace, diagnosticHash: await courseDiagnosticHash(diagnostic, trace), attemptEvaluationHash: await evaluationFingerprint(attemptEvaluationForDiagnostic(diagnostic, f.item.contentHash)) };
}
test('native evidence requires an original capture and accepts native signature without portable resigning', async () => {
  const f = await evidenceFixture();
  const { readNativeCapture, ...missing } = f.options; assert.ok(readNativeCapture);
  await assert.rejects(createLocalCourseEvidenceRepository(f.scope, missing).mutate(f.bind), /native/);
  assert.equal((await f.repository.mutate(f.bind)).durable, true);
  assert.equal((await f.repository.mutate(await modelMutation(f))).durable, true);
  assert.equal((await f.repository.pending()).length, 0);
  assert.equal((await f.repository.read('first')).binding.contentHash, f.item.contentHash);
  const replacement = structuredClone(f.item); replacement.learningSupport.criteria[0].text += ' Tampered reference.';
  await assert.rejects(createLocalCourseEvidenceRepository(f.scope, { ...f.options, readItem: async () => replacement }).mutate(f.bind), /source-integrity/);
});
test('native proofs cannot bypass account/portable integrity or produce account outbox', async () => {
  const f = await evidenceFixture();
  await assert.rejects(createLocalCourseEvidenceRepository(f.scope, { ...f.options, cloud: true }).mutate(f.bind), /native-account/);
  const portableBinding = { ...f.binding, snapshotId: 'account-snapshot' };
  const options = { ...f.options, readAttempt: async () => ({ ...f.original, binding: portableBinding }) };
  await assert.rejects(createLocalCourseEvidenceRepository(f.scope, options).mutate({ ...f.bind, binding: portableBinding }), /source-integrity/);
});
test('native remediation child remains fixed to the trusted parent diagnosis and original capture', async () => {
  const f = await evidenceFixture(); f.original = f.makeAttempt('first', null, '先放入的元素最先取出。'); await f.repository.mutate(f.bind);
  const mutation = await modelMutation(f, 'incorrect'); await f.repository.mutate(mutation);
  const childId = f.support.task.remediations[0].taskId;
  f.makeAttempt('child', 'first', 'Synthetic remediation answer.');
  await f.cache.bindAttempt('child', f.binding, f.capture.captureId);
  const bind = { ...f.bind, attemptId: 'child', operationId: 'child-bind', taskId: childId, taskHash: await courseTaskHash(resolveCourseTask(f.item, childId)), parentAttemptId: 'first', parentEvidenceHash: mutation.diagnosticHash };
  assert.equal((await f.repository.mutate(bind)).durable, true);
  await assert.rejects(f.repository.mutate({ ...bind, operationId: 'changed-parent', parentEvidenceHash: 'e'.repeat(64) }), /parent/);
});
