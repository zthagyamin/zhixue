import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { indexedDB, IDBDatabase } from 'fake-indexeddb';
import { openD1 } from './helpers/sqlite-d1.mjs';
import { AccountStudyStore } from '../db/account-study-store.ts';
import { sealStudyItem, sealStudySnapshot } from '../app/account-study-content.ts';
import { quizBody, snapshotBody } from './fixtures/account-study-fixtures.mjs';
import { D1LearningAttemptStore } from '../src/infrastructure/learning-attempt/index.ts';
import { applyAttemptMutation } from '../src/domain/learning-attempt/index.ts';
import { courseTaskHash, resolveCourseTask, courseDiagnosticHash, attemptEvaluationForDiagnostic, deterministicCourseDiagnostic, applyCourseEvidenceMutation } from '../src/domain/course-study/index.ts';
import { D1CourseEvidenceStore, createLocalCourseEvidenceRepository, createAccountCourseEvidenceClient, courseEvidenceFingerprint, evaluationFingerprint } from '../src/infrastructure/course-study/index.ts';

globalThis.indexedDB = indexedDB;
const at = '2026-10-06T00:00:00.000Z';
const sourceFixtures = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
let serial = 0;
async function fixture(mode = 'recall', scope = { userId: `course-owner-${serial++}`, libraryId: 'library-a' }) {
  const support = structuredClone(sourceFixtures.cases.find(row => row.valid && row.mode === mode).support);
  const body = quizBody({ schemaVersion: 2, learningSupport: support });
  body.practice = { itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: mode, prompt: support.task.prompt, sourceLabel: 'Synthetic course' };
  const item = await sealStudyItem(body), task = resolveCourseTask(item), binding = { ownerId: scope.userId, libraryId: scope.libraryId, snapshotId: 'snapshot-a', itemKey: item.itemKey, contentHash: item.contentHash, groupId: 'group', roundId: 'round' };
  const checkpoint = { schemaVersion: 1, attemptId: 'original', operationId: 'draft', binding, expectedRevision: 0, updatedAt: at, kind: 'checkpoint', parentAttemptId: null, answer: mode === 'quiz' ? JSON.stringify(support.correctOptionIds) : support.criteria[0].text, checkpoint: { phase: 'answering', position: 0, traversed: false, mode } };
  let original = applyAttemptMutation(null, checkpoint).attempt;
  original = applyAttemptMutation(original, { schemaVersion: 1, attemptId: 'original', operationId: 'submit', binding, expectedRevision: original.revision, updatedAt: at, kind: 'submit', answerRevision: original.answerRevision, assistance: 'independent' }).attempt;
  const attempts = new Map([[original.attemptId, original]]), options = { cloud: true, readAttempt: async id => attempts.get(id) ?? null, readItem: async () => item };
  const bind = { schemaVersion: 1, attemptId: original.attemptId, binding, operationId: 'bind', expectedRevision: 0, updatedAt: at, kind: 'bind', taskId: support.task.taskId, taskHash: await courseTaskHash(task), parentAttemptId: null, parentEvidenceHash: null };
  return { scope, item, support, task, original, attempts, options, bind, local: createLocalCourseEvidenceRepository(scope, options) };
}
async function diagnostic(f, source = 'model') {
  const diagnostic = source === 'deterministic' ? deterministicCourseDiagnostic(f.task, f.original.submitted.answer) : { schemaVersion: 1, status: 'correct', source, feedback: '原答案符合来源。', matchedPointIds: f.support.criteria.map(point => point.id), missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: source === 'model' ? f.support.criteria.map(point => ({ pointId: point.id, sourceId: point.sourceIds[0], sourceQuote: f.support.task.sources[0].excerpt, answerQuote: f.original.submitted.answer, reason: '原答覆盖要点。' })) : [] };
  const trace = source === 'model' ? { provider: 'synthetic', modelId: 'fixture', promptVersion: 'v1', ruleVersion: 'v1', requestId: 'request' } : null;
  const evaluation = attemptEvaluationForDiagnostic(diagnostic, f.item.contentHash);
  return { schemaVersion: 1, attemptId: f.bind.attemptId, binding: f.bind.binding, kind: 'diagnose', operationId: 'diagnose', expectedRevision: 1, updatedAt: at, answerRevision: f.original.submitted.answerRevision, diagnostic, trace, diagnosticHash: await courseDiagnosticHash(diagnostic, trace), attemptEvaluationHash: evaluation.status === 'resolved' ? await evaluationFingerprint(evaluation) : null };
}
async function d1Fixture(t, mode = 'recall') {
  const scope = { userId: 'user-a', libraryId: 'library-a' }, f = await fixture(mode, scope), db = await openD1();
  t.after(() => db.sqlite.close()); db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a'),('user-b')");
  const source = new AccountStudyStore(db.binding), snapshot = await sealStudySnapshot(snapshotBody([f.item]));
  await source.putSnapshot(scope, { snapshot, items: [f.item] }, 0);
  const attempts = new D1LearningAttemptStore(db.binding);
  db.sqlite.prepare('INSERT INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId, scope.libraryId, f.original.attemptId, f.original.binding.groupId, f.original.revision, JSON.stringify(f.original), at);
  const originalPort = { readAttempt: (scope, id) => attempts.read(scope, id), readItem: async () => f.item };
  return { ...f, ...db, source, store: new D1CourseEvidenceStore(db.binding, originalPort) };
}
test('D1 evidence CAS and durable idempotency preserve original attempts and scope', async t => {
  const f = await d1Fixture(t), before = JSON.stringify(f.original), second = { ...f.bind, operationId: 'second' };
  assert.equal(await f.store.supported(), true);
  const receipts = await Promise.all([f.store.mutate(f.scope, f.bind), f.store.mutate(f.scope, second)]);
  assert.deepEqual(receipts.map(row => row.status).sort(), ['accepted', 'conflict']);
  const winning = receipts[0].status === 'accepted' ? f.bind : second;
  assert.equal((await f.store.mutate(f.scope, winning)).status, 'duplicate');
  assert.equal((await f.store.mutate(f.scope, winning)).durable, true);
  assert.equal(await f.store.read({ ...f.scope, userId: 'user-b' }, 'original'), null);
  assert.equal(await f.store.read({ ...f.scope, libraryId: 'another' }, 'original'), null);
  assert.equal(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json, before);
  await assert.rejects(f.store.mutate(f.scope, { ...f.bind, binding: { ...f.bind.binding, ownerId: 'user-b' } }), /scope/);
});
test('D1 validates published original versions, exact binding/task, submitted revision and model boundary', async t => {
  const f = await d1Fixture(t);
  for (const binding of [{ ...f.bind.binding, snapshotId: 'foreign' }, { ...f.bind.binding, groupId: 'foreign' }, { ...f.bind.binding, contentHash: 'b'.repeat(64) }])
    await assert.rejects(f.store.mutate(f.scope, { ...f.bind, binding }));
  await assert.rejects(f.store.mutate(f.scope, { ...f.bind, taskHash: 'b'.repeat(64) }));
  await f.store.mutate(f.scope, f.bind); const model = await diagnostic(f);
  await assert.rejects(f.store.mutate(f.scope, model), /model/);
  await assert.rejects(f.store.writeModel(f.scope, { ...model, answerRevision: 100 }));
  await assert.rejects(f.store.writeModel(f.scope, { ...model, diagnosticHash: 'b'.repeat(64) }));
  assert.equal((await f.store.writeModel(f.scope, model)).durable, true);
  assert.equal((await f.store.read(f.scope, 'original')).taskHash, f.bind.taskHash);
  f.sqlite.prepare('UPDATE account_study_snapshots SET published=0').run();
  await assert.rejects(f.store.writeModel(f.scope, model), /source/);
});
test('deterministic diagnosis is recomputed from original selection and none never invents evaluation', async t => {
  const f = await d1Fixture(t, 'quiz'); await f.store.mutate(f.scope, f.bind);
  const mutation = await diagnostic(f, 'deterministic');
  const forged = { ...mutation, diagnostic: { ...mutation.diagnostic, feedback: 'Invented explanation.' } };
  forged.diagnosticHash = await courseDiagnosticHash(forged.diagnostic, null);
  await assert.rejects(f.store.mutate(f.scope, forged));
  assert.equal((await f.store.mutate(f.scope, mutation)).durable, true);
});
test('IndexedDB writes survive reload and concurrent revisions; mutation and outbox abort together', async () => {
  const f = await fixture(), results = await Promise.all([f.local.mutate(f.bind), f.local.mutate({ ...f.bind, operationId: 'other-tab' })]);
  assert.deepEqual(results.map(row => row.status).sort(), ['accepted', 'conflict']);
  const reload = createLocalCourseEvidenceRepository(f.scope, f.options);
  assert.equal((await reload.read('original')).revision, 1); assert.equal((await reload.pending()).length, 1);
  assert.equal(await reload.status('original'), 'device-only');
  assert.equal(await createLocalCourseEvidenceRepository({ ...f.scope, libraryId: 'foreign' }, f.options).read('original'), null);
  const abort = await fixture(), transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) { const tx = transaction.apply(this, args); if (args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
  try { await assert.rejects(abort.local.mutate(abort.bind)); } finally { IDBDatabase.prototype.transaction = transaction; }
  assert.equal(await abort.local.read('original'), null); assert.equal((await abort.local.pending()).length, 0);
});
test('lost and forged receipts preserve outbox; hydrate cannot overwrite pending or sticky conflicts', async () => {
  const f = await fixture(); await f.local.mutate(f.bind); const local = await f.local.read('original');
  const remoteBind = { ...f.bind, operationId: 'remote-bind', expectedRevision: 1 };
  const newer = applyCourseEvidenceMutation(local, remoteBind, await courseEvidenceFingerprint(remoteBind)).evidence;
  await f.local.hydrate(newer); assert.equal((await f.local.read('original')).revision, 1);
  await f.local.synchronize({ read: async () => null, mutate: async () => { throw Error('receipt lost'); } });
  assert.equal((await f.local.pending()).length, 1);
  const receipt = { schemaVersion: 1, status: 'duplicate', durable: true, operationId: f.bind.operationId, revision: 1, evidence: local };
  await f.local.synchronize({ read: async () => local, mutate: async () => ({ ...receipt, evidence: { ...local, operations: [{ operationId: f.bind.operationId, fingerprint: 'b'.repeat(64) }] } }) });
  assert.equal((await f.local.pending()).length, 1); assert.equal(await f.local.status('original'), 'cloud-conflict');
  const unknown = { schemaVersion: 1, status: 'undetermined', source: 'none', reason: 'offline', feedback: '待核对', matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: [] };
  await f.local.mutate({ ...await diagnostic(f), diagnostic: unknown, trace: null, diagnosticHash: await courseDiagnosticHash(unknown, null), attemptEvaluationHash: null }); assert.equal(await f.local.status('original'), 'cloud-conflict');
  const old = await fixture(); await old.local.mutate(old.bind);
  await old.local.synchronize({ read: async () => null, mutate: async () => { throw Object.assign(Error('course-evidence-unsupported'), { status: 409 }); } });
  assert.equal((await old.local.pending()).length, 1); assert.equal(await old.local.status('original'), 'device-only');
});
test('client binds cookies/owner/library, rejects malformed receipts and maps old unsupported response', async () => {
  const f = await fixture(); let request;
  const client = createAccountCourseEvidenceClient({ ownerId: f.scope.userId, libraryId: f.scope.libraryId, fetcher: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ error: 'unsupported-action' }), { status: 409 }); } });
  await assert.rejects(client.read('original'), /course-evidence-unsupported/);
  assert.equal(request.options.credentials, 'same-origin'); const body = JSON.parse(request.options.body);
  assert.equal(body.action, 'course-evidence-read'); assert.equal(body.expectedUserId, f.scope.userId); assert.equal(body.libraryId, f.scope.libraryId);
  const invalid = createAccountCourseEvidenceClient({ ownerId: f.scope.userId, libraryId: f.scope.libraryId, fetcher: async () => new Response(JSON.stringify({ status: 'accepted', durable: true, operationId: 'bind', revision: 5, evidence: null })) });
  await assert.rejects(invalid.mutate(f.bind), /receipt/);
});
test('native model evidence persists without outbox; account model claims require trusted server hydration', async () => {
  const f = await fixture(), native = createLocalCourseEvidenceRepository(f.scope, { ...f.options, cloud: false });
  await native.mutate(f.bind); const model = await diagnostic(f); await native.mutate(model);
  assert.equal((await native.pending()).length, 0); assert.equal(await native.status('original'), 'device-only');
  const reload = createLocalCourseEvidenceRepository(f.scope, { ...f.options, cloud: false });
  assert.equal((await reload.read('original')).diagnostic.source, 'model');
  await reload.synchronize({ read: async () => { throw Error('unexpected upload'); }, mutate: async () => { throw Error('unexpected upload'); } });
  await assert.rejects(reload.hydrate(await reload.read('original')), /native/);
  const account = await fixture(); await account.local.mutate(account.bind);
  await assert.rejects(account.local.mutate(await diagnostic(account)), /server-evidence-required/);
  const bound = await account.local.read('original'), receipt = { schemaVersion: 1, status: 'duplicate', durable: true, operationId: 'bind', revision: 1, evidence: bound };
  await account.local.synchronize({ read: async () => bound, mutate: async () => receipt });
  const remoteMutation = await diagnostic(account), remote = applyCourseEvidenceMutation(bound, remoteMutation, await courseEvidenceFingerprint(remoteMutation)).evidence;
  await account.local.hydrate(remote); assert.equal((await account.local.read('original')).diagnostic.source, 'model');
  const badOriginal = { ...account.original, submitted: { ...account.original.submitted, answer: 'Changed answer' } };
  account.attempts.set('original', badOriginal); await assert.rejects(account.local.hydrate(remote), /quote-binding/);
  assert.equal((await account.local.read('original')).diagnosticHash, remote.diagnosticHash);
});
test('actual durable D1 acknowledgment survives a lost response and atomically removes the exact operation', async t => {
  const f = await d1Fixture(t); await f.local.mutate(f.bind); let lost = true;
  const cloud = { read: id => f.store.read(f.scope, id), mutate: async mutation => { const receipt = await f.store.mutate(f.scope, mutation); if (lost) { lost = false; throw Error('lost response'); } return receipt; } };
  await f.local.synchronize(cloud); assert.equal((await f.local.pending()).length, 1); assert.equal((await f.store.read(f.scope, 'original')).revision, 1);
  await f.local.synchronize(cloud); assert.equal((await f.local.pending()).length, 0); assert.equal(await f.local.status('original'), 'cloud-acked');
});
test('CAS rebases only locked identical task and diagnosis bodies, divergent remote results remain conflicts', async () => {
  const f = await fixture('quiz'); await f.local.mutate(f.bind);
  const remoteBind = { ...f.bind, operationId: 'another-device' };
  let remote = applyCourseEvidenceMutation(null, remoteBind, await courseEvidenceFingerprint(remoteBind)).evidence;
  const cloud = { read: async () => remote, mutate: async mutation => { const receipt = applyCourseEvidenceMutation(remote, mutation, await courseEvidenceFingerprint(mutation)); remote = receipt.evidence; return { ...receipt, durable: receipt.status !== 'conflict' }; } };
  await f.local.synchronize(cloud); assert.equal((await f.local.pending()).length, 0); assert.equal(remote.revision, 2);
  const localDiagnosis = { ...await diagnostic(f, 'deterministic'), expectedRevision: 2 };
  await f.local.mutate(localDiagnosis);
  const gap = { ...localDiagnosis, operationId: 'remote-gap', expectedRevision: 2, diagnostic: { schemaVersion: 1, status: 'undetermined', source: 'none', reason: 'offline', feedback: '待核对', matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: [] }, trace: null, attemptEvaluationHash: null };
  gap.diagnosticHash = await courseDiagnosticHash(gap.diagnostic, null);
  remote = applyCourseEvidenceMutation(remote, gap, await courseEvidenceFingerprint(gap)).evidence;
  await f.local.synchronize(cloud); assert.equal((await f.local.pending()).length, 0); assert.equal((await f.local.read('original')).diagnostic.status, 'correct');
  const other = await fixture('quiz'); await other.local.mutate(other.bind);
  const bound = await other.local.read('original'), correct = await diagnostic(other, 'deterministic');
  await other.local.mutate(correct);
  const changed = { ...bound, taskHash: 'b'.repeat(64) };
  await other.local.synchronize({ read: async () => changed, mutate: async mutation => ({ schemaVersion: 1, status: 'conflict', durable: false, operationId: mutation.operationId, revision: 1, evidence: changed }) });
  assert.equal((await other.local.pending()).length, 2); assert.equal((await other.local.read('original')).taskHash, other.bind.taskHash);
});
test('parent identity and trusted diagnostic select the authored child, prohibiting wrong task or parent hash', async () => {
  const f = await fixture(), native = createLocalCourseEvidenceRepository(f.scope, { ...f.options, cloud: false });
  await native.mutate(f.bind);
  const parent = await diagnostic(f), failed = { ...parent.diagnostic, status: 'incorrect', matchedPointIds: [], missedPointIds: f.support.criteria.map(point => point.id), pointEvidence: [] };
  const evaluation = attemptEvaluationForDiagnostic(failed, f.item.contentHash);
  parent.diagnostic = failed; parent.diagnosticHash = await courseDiagnosticHash(failed, parent.trace); parent.attemptEvaluationHash = await evaluationFingerprint(evaluation);
  await native.mutate(parent);
  const child = { ...f.original, attemptId: 'child', parentAttemptId: 'original' }; f.attempts.set('child', child);
  const taskId = f.support.task.remediations[0].taskId, childTask = resolveCourseTask(f.item, taskId);
  const bind = { ...f.bind, attemptId: 'child', taskId, taskHash: await courseTaskHash(childTask), parentAttemptId: 'original', parentEvidenceHash: parent.diagnosticHash };
  await assert.rejects(native.mutate({ ...bind, taskId: f.bind.taskId, taskHash: f.bind.taskHash }), /task-selection/);
  await assert.rejects(native.mutate({ ...bind, parentAttemptId: null, parentEvidenceHash: null }), /parent-attempt/);
  await assert.rejects(native.mutate({ ...bind, parentEvidenceHash: 'b'.repeat(64) }), /parent-evidence/);
  assert.equal((await native.mutate(bind)).durable, true); assert.equal((await native.read('child')).taskId, taskId);
});
test('source head changes cannot replace the original snapshot and local integrity checks reject same-hash substitution', async t => {
  const f = await d1Fixture(t); await f.store.mutate(f.scope, f.bind);
  const support = structuredClone(f.support); support.task.sources[0].version = 'b'.repeat(64); support.task.sources[0].excerpt += ' 新版本。';
  const { contentHash, ...body } = f.item; assert.ok(contentHash);
  const replacement = await sealStudyItem({ ...body, learningSupport: support });
  await f.source.putSnapshot(f.scope, { snapshot: await sealStudySnapshot(snapshotBody([replacement], { snapshotId: 'new-snapshot', revision: 2 })), items: [replacement] }, 1);
  assert.equal((await f.store.mutate(f.scope, f.bind)).status, 'duplicate');
  const substituted = createLocalCourseEvidenceRepository(f.scope, { ...f.options, cloud: false, readItem: async () => ({ ...replacement, contentHash: f.item.contentHash }) });
  await assert.rejects(substituted.mutate(f.bind), /source-integrity/);
});
test('an asynchronous older receipt keeps newly queued diagnostic descendants and their exact fingerprints', async () => {
  const f = await fixture('quiz'); await f.local.mutate(f.bind);
  let release, started;
  const arrived = new Promise(resolve => { started = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  let remote = null, calls = 0, descendantPreserved = false;
  const syncing = f.local.synchronize({ read: async () => remote, mutate: async mutation => {
    calls++;
    if (calls === 1) { started(); await delayed; }
    else { descendantPreserved = (await f.local.read('original')).diagnostic?.status === 'correct'; throw Error('offline after bind acknowledgment'); }
    const receipt = applyCourseEvidenceMutation(remote, mutation, await courseEvidenceFingerprint(mutation)); remote = receipt.evidence;
    return { ...receipt, durable: receipt.status !== 'conflict' };
  } });
  await arrived; const mutation = await diagnostic(f, 'deterministic'); await f.local.mutate(mutation); release(); await syncing;
  assert.equal(descendantPreserved, true); assert.equal((await f.local.read('original')).diagnosticHash, mutation.diagnosticHash);
  const pending = await f.local.pending(); assert.equal(pending.length, 1); assert.equal(pending[0].fingerprint, await courseEvidenceFingerprint(mutation));
  assert.equal(await f.local.status('original'), 'device-only');
});
test('pending evidence has no score, can recover; explicit self assessment carries no alignment or model trace', async t => {
  const f = await d1Fixture(t); await f.store.mutate(f.scope, f.bind);
  const base = await diagnostic(f), unknown = { schemaVersion: 1, status: 'undetermined', source: 'none', reason: 'unavailable', feedback: '待核对', matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: [] };
  const pending = { ...base, diagnostic: unknown, trace: null, diagnosticHash: await courseDiagnosticHash(unknown, null), attemptEvaluationHash: null };
  const saved = await f.store.mutate(f.scope, pending); assert.equal(saved.evidence.attemptEvaluationHash, null);
  assert.equal(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json, JSON.stringify(f.original));
  const self = { ...unknown, status: 'incorrect', source: 'self-assess', feedback: '本人自评：没有记住。' }; delete self.reason;
  const selfEvaluation = attemptEvaluationForDiagnostic(self, f.item.contentHash);
  const mutation = { ...base, operationId: 'self', expectedRevision: 2, diagnostic: self, trace: null, diagnosticHash: await courseDiagnosticHash(self, null), attemptEvaluationHash: await evaluationFingerprint(selfEvaluation) };
  await assert.rejects(f.store.mutate(f.scope, { ...mutation, trace: base.trace }));
  const resolved = await f.store.mutate(f.scope, mutation); assert.equal(resolved.evidence.diagnostic.source, 'self-assess');
  assert.equal(resolved.evidence.trace, null); assert.equal(resolved.evidence.diagnostic.matchedPointIds.length, 0);
  const conflicting = { ...base, operationId: 'later-model', expectedRevision: 3 };
  assert.equal((await f.store.writeModel(f.scope, conflicting)).status, 'conflict');
});
test('IndexedDB unavailable never reports a durable write and changed ready status blocks every new bind', async () => {
  const f = await fixture(), saved = globalThis.indexedDB; delete globalThis.indexedDB;
  try { await assert.rejects(f.local.mutate(f.bind), /local-unavailable/); } finally { globalThis.indexedDB = saved; }
  const { contentHash, ...body } = f.item; assert.ok(contentHash);
  const support = structuredClone(f.support); support.task.reviewStatus = 'candidate';
  const item = await sealStudyItem({ ...body, learningSupport: support }), binding = { ...f.bind.binding, contentHash: item.contentHash };
  const original = { ...f.original, binding }, options = { ...f.options, readAttempt: async () => original, readItem: async () => item };
  await assert.rejects(createLocalCourseEvidenceRepository(f.scope, options).mutate({ ...f.bind, binding }), /unreviewed/);
});
