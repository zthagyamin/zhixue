import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { openD1 } from './helpers/sqlite-d1.mjs';
import { AccountStudyStore } from '../db/account-study-store.ts';
import { D1LearningAttemptStore, evaluationFingerprint } from '../src/infrastructure/learning-attempt/index.ts';
import { D1CourseEvidenceStore } from '../src/infrastructure/course-study/index.ts';
import { resolveCourseTask, courseTaskHash, deterministicCourseDiagnostic, courseDiagnosticHash, attemptEvaluationForDiagnostic } from '../src/domain/course-study/index.ts';
import { sealStudyItem, sealStudySnapshot } from '../app/account-study-content.ts';
import { sealStudyRecord } from '../app/account-study-record.ts';
import { prepareAccountStudyRecord } from '../app/account-study-record-client.ts';
import { quizBody, snapshotBody } from './fixtures/account-study-fixtures.mjs';
import { attempt } from './fixtures/task-event-fixtures.mjs';
import { createAccountStudyApplication } from '../src/application/account-study/index.ts';
import { requireCourseEvaluationProof } from '../src/infrastructure/course-proof/index.ts';
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const scope = { userId: 'user-a', libraryId: 'library-a' }, at = '2026-10-06T00:00:00.000Z';
const sourceFixtures = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url))).cases;
let serial = 0;
async function setup(t, { legacy = false, wrong = false, mode = 'quiz' } = {}) {
  const db = await openD1(); t.after(() => db.sqlite.close()); db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a'),('user-b')");
  const source = new AccountStudyStore(db.binding), attempts = new D1LearningAttemptStore(db.binding), support = structuredClone(sourceFixtures.find(row => row.valid && row.mode === mode).support);
  const body = legacy ? quizBody() : quizBody({ schemaVersion: 2, learningSupport: support, practice: { itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: mode, prompt: support.task.prompt, sourceLabel: 'Isolated fixture' } });
  const item = await sealStudyItem(body), snapshot = await sealStudySnapshot(snapshotBody([item])); await source.putSnapshot(scope, { snapshot, items: [item] }, 0);
  const binding = { ownerId: scope.userId, libraryId: scope.libraryId, snapshotId: snapshot.snapshotId, itemKey: item.itemKey, contentHash: item.contentHash, groupId: 'group', roundId: 'original-round' };
  const base = { schemaVersion: 1, attemptId: 'original-attempt', binding, operationId: 'draft', expectedRevision: 0, updatedAt: at };
  const answer = legacy ? 'First' : mode === 'recall' ? wrong ? '' : support.criteria.map(point => point.text).join('\n') : JSON.stringify(wrong ? support.options.filter(option => !support.correctOptionIds.includes(option.optionId)).slice(0, 1).map(option => option.optionId) : support.correctOptionIds);
  await attempts.mutate(scope, { ...base, kind: 'checkpoint', parentAttemptId: null, answer, checkpoint: { phase: 'answering', position: 0, traversed: false, mode, purpose: 'first', view: { purpose: 'first', lessonStep: 'independent', paused: false, referenceSeen: false } } });
  const draft = await attempts.read(scope, base.attemptId);
  await attempts.mutate(scope, { ...base, kind: 'submit', operationId: 'submit', expectedRevision: 1, answerRevision: draft.answerRevision, assistance: 'unknown' });
  const original = await attempts.read(scope, base.attemptId), evidence = new D1CourseEvidenceStore(db.binding, { readAttempt: (scope, id) => attempts.read(scope, id), readItem: (scope, binding) => source.getSnapshotItem(scope, binding.snapshotId, binding.itemKey) });
  return { ...db, source, attempts, evidence, item, snapshot, support, base, original, workspaceId: `account:formal-fixture-${serial++}` };
}
async function diagnose(f, diagnostic, trace = null) {
  const task = resolveCourseTask(f.item);
  await f.evidence.mutate(scope, { ...f.base, kind: 'bind', operationId: 'bind', taskId: task.taskId, taskHash: await courseTaskHash(task), parentAttemptId: null, parentEvidenceHash: null });
  diagnostic ??= deterministicCourseDiagnostic(task, f.original.submitted.answer);
  const evaluation = attemptEvaluationForDiagnostic(diagnostic, f.item.contentHash); if (evaluation.status === 'resolved') evaluation.evaluationHash = await evaluationFingerprint(evaluation);
  const mutation = { ...f.base, kind: 'diagnose', operationId: 'diagnose', expectedRevision: 1, answerRevision: f.original.submitted.answerRevision, diagnostic, trace, diagnosticHash: await courseDiagnosticHash(diagnostic, trace), attemptEvaluationHash: evaluation.status === 'resolved' ? evaluation.evaluationHash : null };
  if (diagnostic.source === 'model') await f.evidence.writeModel(scope, mutation); else await f.evidence.mutate(scope, mutation);
  return { evaluation, mutation };
}
async function evaluate(f, evaluation) {
  return f.attempts.mutate(scope, { ...f.base, kind: 'evaluate', operationId: 'evaluate', expectedRevision: 2, answerRevision: f.original.submitted.answerRevision, evaluation });
}
async function claim(f, evaluation, rating = evaluation.rating) {
  return f.attempts.mutate(scope, { ...f.base, kind: 'claim-formal', operationId: 'claim', expectedRevision: 3, eventId: 'official-event', occurredAt: at, evaluationHash: evaluation.evaluationHash, rating });
}
async function official(f, { correct = true, rating = correct ? 'good' : 'again', eventId = 'official-event', occurredAt = at } = {}) {
  const event = await attempt(eventId, occurredAt, 0, correct ? 3 : 0, correct, { domain: 'differential-review', item: { kind: 'due', key: f.item.itemKey }, attempt: { correct, rating, stageBefore: 0, stageAfter: correct ? 3 : 0 } });
  return prepareAccountStudyRecord({ workspaceId: f.workspaceId, bundle: { snapshot: f.snapshot, items: [f.item] }, event, originDeviceId: 'device-a', practiceMode: f.item.practice.questionType });
}
test('V2 resolved evaluation without durable matching course evidence is rejected before original changes', async t => {
  const f = await setup(t), evaluation = { status: 'resolved', rating: 'good', correct: true, outcome: 'correct', source: 'model', feedback: 'Forged raw grade.', referenceHash: f.item.contentHash };
  evaluation.evaluationHash = await evaluationFingerprint(evaluation);
  await assert.rejects(evaluate(f, evaluation), /course-evidence-required/);
  assert.equal((await f.attempts.read(scope, f.base.attemptId)).evaluation.status, 'pending');
});
test('resolved durable diagnosis, original evaluation and formal claim permit official record in distinct identity namespace', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation); await claim(f, evaluation);
  const record = await official(f); assert.notEqual(record.attemptId, f.base.attemptId); assert.notEqual(record.roundId, f.base.binding.roundId);
  assert.equal((await f.source.appendRecord(scope, record)).durable, true);
  const linked = await f.attempts.mutate(scope, { ...f.base, kind: 'link-formal', operationId: 'link', expectedRevision: 4, eventId: record.event.eventId, coreHash: record.event.coreHash });
  assert.deepEqual(linked.attempt.formal.authoritativeRecord, { attemptId: record.attemptId, roundId: record.roundId });
  f.sqlite.prepare('DELETE FROM course_evidence_v1').run();
  assert.equal((await f.source.appendRecord(scope, record)).status, 'duplicate');
  assert.equal((await claim(f, evaluation)).status, 'duplicate');
});
test('pending diagnosis cannot grade or create official records; new record requires a real formal claim', async t => {
  const f = await setup(t), pending = { schemaVersion: 1, status: 'undetermined', source: 'none', reason: 'offline', feedback: '待核对', matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: [] };
  await diagnose(f, pending);
  const task = resolveCourseTask(f.item), evaluation = attemptEvaluationForDiagnostic(deterministicCourseDiagnostic(task, f.original.submitted.answer), f.item.contentHash); evaluation.evaluationHash = await evaluationFingerprint(evaluation);
  await assert.rejects(evaluate(f, evaluation), /course-evidence-required/);
  await assert.rejects(f.source.appendRecord(scope, await official(f)), /course-formal-binding/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n, 0);
});
test('a raw self-consistent forged good grade cannot override an incorrect original diagnosis', async t => {
  const f = await setup(t, { wrong: true }), { evaluation } = await diagnose(f);
  assert.equal(evaluation.correct, false);
  const forged = { ...evaluation, rating: 'good', correct: true, outcome: 'correct' }; forged.evaluationHash = await evaluationFingerprint(forged);
  await assert.rejects(evaluate(f, forged), /course-evaluation-mismatch/);
  await evaluate(f, evaluation); await claim(f, evaluation);
  assert.equal((await f.source.appendRecord(scope, await official(f, { correct: false }))).durable, true);
});
test('source/binding/task/revision substitution cannot authorize evaluation', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f), saved = f.sqlite.prepare('SELECT evidence_json FROM course_evidence_v1').get().evidence_json;
  const original = JSON.parse(saved);
  for (const change of [row => { row.binding.ownerId = 'user-b'; }, row => { row.binding.libraryId = 'other-library'; }, row => { row.taskHash = 'b'.repeat(64); }, row => { row.answerRevision++; }, row => { row.taskId = 'missing-task'; }, row => { row.diagnosticHash = 'b'.repeat(64); }]) {
    const changed = structuredClone(original); change(changed); f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=?').run(JSON.stringify(changed));
    await assert.rejects(evaluate(f, evaluation), /course-evaluation-mismatch/);
    assert.equal((await f.attempts.read(scope, f.base.attemptId)).revision, 2);
  }
  f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=?').run(saved);
  await evaluate(f, evaluation); await claim(f, evaluation);
  const record = await official(f, { eventId: 'another-event' }); await assert.rejects(f.source.appendRecord(scope, record), /course-formal-binding/);
});
test('incorrect partial evidence cannot become event correct=true, while conservative false/capped rating remains valid', async t => {
  const f = await setup(t), partial = { schemaVersion: 1, status: 'partial', source: 'self-assess', feedback: '本人自评：只记住一部分。', matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds: [], missingOptionIds: [], pointEvidence: [] };
  const { evaluation } = await diagnose(f, partial); await evaluate(f, evaluation); await claim(f, evaluation);
  await assert.rejects(f.source.appendRecord(scope, await official(f, { correct: true, rating: 'hard' })), /course-evaluation-mismatch/);
  assert.equal((await f.source.appendRecord(scope, await official(f, { correct: false, rating: 'hard' }))).durable, true);
});
test('new V2 formal record rejects guided/remediation claims even if an old aggregate was directly imported', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation); await claim(f, evaluation);
  const row = await f.attempts.read(scope, f.base.attemptId), record = await official(f);
  for (const changed of [{ ...row, parentAttemptId: 'parent' }, { ...row, checkpoint: { ...row.checkpoint, purpose: 'guided' } }, { ...row, checkpoint: { ...row.checkpoint, purpose: 'remediation' } }]) {
    f.sqlite.prepare('UPDATE learning_attempts_v1 SET attempt_json=?').run(JSON.stringify(changed));
    await assert.rejects(f.source.appendRecord(scope, record), /course-formal-binding/);
  }
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n, 0);
});
test('new proof failures are nonretryable per-record blocked results and older V1 remains unaffected', async t => {
  const f = await setup(t), record = await official(f), application = createAccountStudyApplication({ getStudyStore: async () => f.source, getAccessStore: async () => ({ profile: async () => ({ libraryId: 'library-a', revision: 1 }) }), now: () => new Date(at) });
  const result = await application.post({ action: 'append-records', records: [record] }, { principal: { kind: 'browser', userId: scope.userId } }, new AbortController().signal);
  assert.equal(result.status, 200); assert.equal(result.value.results[0].status, 'blocked'); assert.equal(result.value.results[0].retryable, false); assert.equal(result.value.results[0].error, 'course-formal-binding');
  const legacy = await setup(t, { legacy: true }), evaluation = { status: 'resolved', rating: 'good', correct: true, outcome: 'correct', source: 'model', feedback: 'Existing V1 behavior.', referenceHash: legacy.item.contentHash }; evaluation.evaluationHash = await evaluationFingerprint(evaluation);
  assert.equal((await evaluate(legacy, evaluation)).durable, true); assert.equal((await legacy.source.appendRecord(scope, await official(legacy))).durable, true);
});
test('unsupported course evidence cannot claim durability and previously stored V2 duplicates remain valid', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); f.sqlite.exec('DROP TABLE course_evidence_v1');
  await assert.rejects(evaluate(f, evaluation), /course-evidence-unsupported/);
  const record = await official(f);
  f.sqlite.prepare('INSERT INTO account_study_records(user_id,library_id,event_id,snapshot_id,core_hash,envelope_hash,record_json) VALUES (?,?,?,?,?,?,?)').run(scope.userId, scope.libraryId, record.event.eventId, record.snapshotId, record.event.coreHash, record.envelopeHash, JSON.stringify(record));
  assert.equal((await f.source.appendRecord(scope, record)).status, 'duplicate');
  const { envelopeHash, ...body } = record; assert.ok(envelopeHash);
  const changed = await sealStudyRecord({ ...body, originDeviceId: 'different' });
  const conflict = await f.source.appendRecord(scope, changed); assert.equal(conflict.status, 'conflict'); assert.equal(conflict.durable, false);
});
function modelDiagnostic(task, answer, status = 'correct') {
  return { schemaVersion: 1, status, source: 'model', feedback: status === 'correct' ? '原答覆盖指定要点。' : '原答缺少指定要点。',
    matchedPointIds: status === 'correct' ? task.criteria.map(point => point.id) : [], missedPointIds: status === 'correct' ? [] : task.criteria.map(point => point.id), errorPointIds: [], wrongOptionIds: [], missingOptionIds: [],
    pointEvidence: status === 'correct' ? task.criteria.map(point => ({ pointId: point.id, sourceId: point.sourceIds[0], sourceQuote: task.sources[0].excerpt, answerQuote: answer, reason: '原文与作答要点一致。' })) : [] };
}
const trace = { provider: 'synthetic', modelId: 'fixture', promptVersion: 'v1', ruleVersion: 'v1', requestId: 'model-request' };
test('trusted model trace/quote proof permits a recall official record; bad quote or evaluation hash cannot authorize it', async t => {
  const f = await setup(t, { mode: 'recall' }), diagnostic = modelDiagnostic(resolveCourseTask(f.item), f.original.submitted.answer), { evaluation } = await diagnose(f, diagnostic, trace);
  const stored = JSON.parse(f.sqlite.prepare('SELECT evidence_json FROM course_evidence_v1').get().evidence_json);
  const changed = structuredClone(stored); changed.diagnostic.pointEvidence[0].answerQuote = '不存在的原答案'; changed.diagnosticHash = await courseDiagnosticHash(changed.diagnostic, changed.trace);
  f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=?').run(JSON.stringify(changed));
  await assert.rejects(evaluate(f, evaluation), /course-evaluation-mismatch/);
  f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=?').run(JSON.stringify(stored));
  await evaluate(f, evaluation); await claim(f, evaluation); assert.equal((await f.source.appendRecord(scope, await official(f))).durable, true);
});
test('claim rechecks evidence after evaluation; lower conservative claim is accepted and other event time/rating rejected', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation);
  const saved = f.sqlite.prepare('SELECT evidence_json FROM course_evidence_v1').get().evidence_json;
  f.sqlite.prepare('DELETE FROM course_evidence_v1').run(); await assert.rejects(claim(f, evaluation), /course-evidence-required/);
  assert.equal((await f.attempts.read(scope, f.base.attemptId)).formal, null);
  f.sqlite.prepare('INSERT INTO course_evidence_v1(user_id,library_id,attempt_id,revision,evidence_json,updated_at) VALUES (?,?,?,?,?,?)').run(scope.userId, scope.libraryId, f.base.attemptId, 2, saved, at);
  await claim(f, evaluation, 'hard');
  await assert.rejects(f.source.appendRecord(scope, await official(f, { rating: 'good' })), /course-formal-binding/);
  await assert.rejects(f.source.appendRecord(scope, await official(f, { correct: false, rating: 'hard', occurredAt: '2026-10-06T00:01:00.000Z' })), /course-formal-binding/);
  assert.equal((await f.source.appendRecord(scope, await official(f, { correct: false, rating: 'hard' }))).durable, true);
});
test('formal original lookup is scoped to owner and library even when another scope has the same published source', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation); await claim(f, evaluation);
  const record = await official(f);
  await f.source.putSnapshot({ userId: 'user-b', libraryId: 'library-a' }, { snapshot: f.snapshot, items: [f.item] }, 0);
  await assert.rejects(f.source.appendRecord({ userId: 'user-b', libraryId: 'library-a' }, record), /course-formal-binding/);
  const otherScope = { userId: 'user-a', libraryId: 'other-library' }, snapshot = await sealStudySnapshot(snapshotBody([f.item], { libraryId: 'other-library' }));
  await f.source.putSnapshot(otherScope, { snapshot, items: [f.item] }, 0);
  const { envelopeHash, ...body } = record; assert.ok(envelopeHash);
  const otherRecord = await sealStudyRecord({ ...body, libraryId: 'other-library' });
  await assert.rejects(f.source.appendRecord(otherScope, otherRecord), /course-formal-binding/);
});
test('child evaluation rechecks the trusted parent task hash and remediation never acquires a formal result', async t => {
  const f = await setup(t, { mode: 'recall', wrong: true }), parentTask = resolveCourseTask(f.item), parentDiagnostic = modelDiagnostic(parentTask, '', 'incorrect');
  const parent = await diagnose(f, parentDiagnostic, trace), taskId = f.support.task.remediations[0].taskId, task = resolveCourseTask(f.item, taskId);
  const base = { ...f.base, attemptId: 'child', operationId: 'child-draft' };
  await f.attempts.mutate(scope, { ...base, kind: 'checkpoint', parentAttemptId: f.base.attemptId, answer: task.answer, checkpoint: { phase: 'answering', position: 0, traversed: false, mode: 'recall', purpose: 'remediation' } });
  await f.attempts.mutate(scope, { ...base, kind: 'submit', operationId: 'child-submit', expectedRevision: 1, answerRevision: 1, assistance: 'unknown' });
  await f.evidence.mutate(scope, { ...base, kind: 'bind', operationId: 'child-bind', taskId, taskHash: await courseTaskHash(task), parentAttemptId: f.base.attemptId, parentEvidenceHash: parent.mutation.diagnosticHash });
  const diagnostic = modelDiagnostic(task, task.answer), evaluation = attemptEvaluationForDiagnostic(diagnostic, f.item.contentHash); evaluation.evaluationHash = await evaluationFingerprint(evaluation);
  await f.evidence.writeModel(scope, { ...base, kind: 'diagnose', operationId: 'child-diagnose', expectedRevision: 1, answerRevision: 1, diagnostic, trace, diagnosticHash: await courseDiagnosticHash(diagnostic, trace), attemptEvaluationHash: evaluation.evaluationHash });
  const mutation = { ...base, kind: 'evaluate', operationId: 'child-evaluate', expectedRevision: 2, answerRevision: 1, evaluation };
  const original = f.sqlite.prepare('SELECT evidence_json FROM course_evidence_v1 WHERE attempt_id=?').get(f.base.attemptId).evidence_json;
  const changed = JSON.parse(original); changed.taskHash = 'b'.repeat(64); f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=? WHERE attempt_id=?').run(JSON.stringify(changed), f.base.attemptId);
  await assert.rejects(f.attempts.mutate(scope, mutation), /course-evaluation-mismatch/);
  f.sqlite.prepare('UPDATE course_evidence_v1 SET evidence_json=? WHERE attempt_id=?').run(original, f.base.attemptId);
  assert.equal((await f.attempts.mutate(scope, mutation)).durable, true);
  await assert.rejects(f.attempts.mutate(scope, { ...base, kind: 'claim-formal', operationId: 'child-claim', expectedRevision: 3, eventId: 'child-event', occurredAt: at, evaluationHash: evaluation.evaluationHash, rating: 'good' }), /remediation-not-formal/);
});
test('V2 formal claim rejects guided nested checkpoint purpose even if outer purpose says first', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation);
  const original = await f.attempts.read(scope, f.base.attemptId), changed = { ...original, checkpoint: { ...original.checkpoint, view: { purpose: 'guided', lessonStep: 'guided', paused: false, referenceSeen: true } } };
  f.sqlite.prepare('UPDATE learning_attempts_v1 SET attempt_json=?').run(JSON.stringify(changed));
  await assert.rejects(claim(f, evaluation), /course-formal-binding/); assert.equal((await f.attempts.read(scope, f.base.attemptId)).formal, null);
  f.sqlite.prepare('UPDATE learning_attempts_v1 SET attempt_json=?').run(JSON.stringify(original)); assert.equal((await claim(f, evaluation)).durable, true);
});
test('a first formal claim still appends and replays after its navigation points to remediation', async t => {
  const f = await setup(t), { evaluation } = await diagnose(f); await evaluate(f, evaluation);
  assert.equal((await f.attempts.read(scope, f.base.attemptId)).checkpoint.view.purpose, 'first');
  await claim(f, evaluation); const record = await official(f), claimed = await f.attempts.read(scope, f.base.attemptId);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n, 0);
  await f.attempts.mutate(scope, { ...f.base, kind: 'checkpoint', operationId: 'navigate-to-child', expectedRevision: claimed.revision,
    updatedAt: '2026-10-06T00:01:00.000Z', parentAttemptId: null, answer: claimed.answer,
    checkpoint: { ...claimed.checkpoint, view: { purpose: 'remediation', instanceId: 'child-navigation', lessonStep: 'independent', paused: false, referenceSeen: false } } });
  const navigated = await f.attempts.read(scope, f.base.attemptId);
  assert.equal(navigated.checkpoint.purpose, 'first'); assert.equal(navigated.parentAttemptId, null); assert.equal(navigated.checkpoint.view.purpose, 'remediation');
  assert.equal((await evaluate(f, evaluation)).status, 'duplicate'); assert.equal((await claim(f, evaluation)).status, 'duplicate');
  const accepted = await f.source.appendRecord(scope, record); assert.equal(accepted.status, 'accepted'); assert.equal(accepted.durable, true);
  await requireCourseEvaluationProof(f.binding, scope, navigated, evaluation, evaluationFingerprint, true);
  const duplicate = await f.source.appendRecord(scope, record); assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.durable, true);
});
