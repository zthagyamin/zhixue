import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {prepareAccountStudyRecord} from '../app/account-study-record-client.ts';

let fixture;
try { fixture = await import('./fixtures/nonword-baseline-preview.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const repo = fileURLToPath(new URL('../', import.meta.url));

test('nonword fixture seeds four real versioned tasks in separate empty accounts', async t => {
  assert.equal(typeof fixture?.createNonwordAccount, 'function');
  assert.deepEqual(fixture.SCENARIOS.map(row => row.id), ['quiz-multiple', 'paper-recall', 'guided-maths', 'nonvocab-flashcard']);
  const owners = new Set();
  for (const [index, row] of fixture.SCENARIOS.entries()) {
    const origin = `http://127.0.0.1:${3050 + index}`;
    const preview = await fixture.createNonwordAccount({repo, origin, scenario: row.id});
    t.after(() => preview.close());
    owners.add(preview.userId);
    const loaded = await preview.client.load(), state = await preview.client.getPlanState(preview.day);
    assert.equal(loaded.bundle.items.length, 1);
    assert.equal(loaded.bundle.items[0].schemaVersion, 2);
    assert.equal(loaded.bundle.items[0].practice.questionType, row.questionType);
    assert.equal(loaded.bundle.items[0].kind, 'practice');
    assert.equal(Object.hasOwn(loaded.bundle.items[0], 'recommendedPlugin'), false);
    assert.equal(state.decision, 'approved');
    assert.equal(state.approvedPlan.tasks.length, 1);
    assert.deepEqual(state.approvedPlan.tasks[0].action.itemKeys, [loaded.bundle.items[0].itemKey]);
    assert.deepEqual(await preview.status(), {
      scope: 'synthetic-in-memory-only', scenario: row.id, baselineSha: fixture.BASELINE_SHA,
      userId: preview.userId, libraryId: 'library-a', day: preview.day,
      counts: {items: 1, tasks: 1, records: 0, assistance: 0, assistanceReceipts: 0, aiRequests: 0},
      recordCounts: {}, externalModels: 'blocked', realNotes: 'blocked', browserAcceptance: 'unrun',
    });
  }
  assert.equal(owners.size, 4);
});

test('fixture rejects non-loopback targets and exposes no device credential', async t => {
  assert.equal(typeof fixture?.createNonwordAccount, 'function');
  for (const origin of ['https://127.0.0.1:3050', 'http://example.invalid:3050'])
    await assert.rejects(fixture.createNonwordAccount({repo, origin, scenario: 'quiz-multiple'}), /loopback/);
  await assert.rejects(fixture.createNonwordAccount({repo, origin: 'http://127.0.0.1:3050', scenario: 'unknown'}), /scenario/);
  const preview = await fixture.createNonwordAccount({repo, origin: 'http://127.0.0.1:3050', scenario: 'quiz-multiple'});
  t.after(() => preview.close());
  assert.equal(preview.token, undefined);
  assert.equal((await preview.handle(new Request('https://example.invalid/api/account-study'))).status, 403);
  const response = await preview.handle(new Request('http://127.0.0.1:3050/api/account-study', {
    method: 'POST', headers: {'content-type': 'application/json', Origin: 'http://127.0.0.1:3050'},
    body: JSON.stringify({action: 'begin-snapshot'}),
  }));
  assert.equal(response.status, 403);
});

test('scenario links use independent deterministic ports and validated loopback CSP', () => {
  assert.equal(typeof fixture?.scenarioLinks, 'function');
  const links = fixture.scenarioLinks(3050);
  assert.equal(new Set(links.map(row => new URL(row.href).origin)).size, 4);
  assert.deepEqual(links.map(row => new URL(row.href).port), ['3050', '3051', '3052', '3053']);
  assert.match(fixture.loopbackCsp(3050, 3012), /connect-src 'self' http:\/\/127\.0\.0\.1:3012/);
  assert.doesNotMatch(fixture.loopbackCsp(3050, 3012), /https:|\*/);
  assert.throws(() => fixture.scenarioLinks(65534), /port/);
  assert.throws(() => fixture.loopbackCsp(3050, '3012; https:'), /port/);
});

test('source attestation reports actual SHA/tree and refuses a changed tree in baseline role', async () => {
  const source = await fixture.inspectSource(repo, 'candidate');
  assert.match(source.sha, /^[a-f0-9]{40}$/);
  assert.match(source.tree, /^[a-f0-9]{40}$/);
  assert.match(source.baselineSourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(source.role, 'candidate');
  if (source.dirty.length || !source.baselineSourceUnchanged || source.version !== '1.41.1')
    await assert.rejects(fixture.inspectSource(repo, 'baseline'), /Immutable baseline/);
  else {
    const accepted = await fixture.inspectSource(repo, 'baseline');
    assert.equal(accepted.baselineSourceUnchanged, true);
    assert.equal(accepted.sha, source.sha);
  }
  await assert.rejects(fixture.inspectSource(repo, 'unknown'), /Source role/);
});

test('status counts real HTTP stored record envelopes by practice mode and actual rating', async t => {
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const origin = 'http://127.0.0.1:3054';
  const preview = await fixture.createNonwordAccount({repo, origin, scenario: 'quiz-multiple'});
  t.after(() => preview.close());
  const loaded = await preview.client.load(), bundle = loaded.bundle, item = bundle.items[0];
  for (const [index, rating] of ['again', 'good'].entries()) {
    const reviewedAt = `2026-10-05T00:0${index + 1}:00.000Z`;
    const {event} = await recordStudyAttempt({
      identity: {eventId: `synthetic-count-${rating}`, reviewedAt}, workspaceId: `account:${preview.userId}`,
      domain: 'differential-review', item: {kind: item.eventKind, key: item.itemKey},
      rating, correct: rating === 'good', stageBefore: 0, stageAfter: rating === 'good' ? 3 : 0,
      reviewedAt, isThreeStage: false, delivery: {cloud: 'not-required', companion: 'not-required'},
    }, {persistEvent: async () => {}, persistProgress: async () => {}, sendCloud: async () => {},
      sendCompanion: async () => {}, updateDelivery: async () => {}});
    const record = await prepareAccountStudyRecord({workspaceId: `account:${preview.userId}`, bundle,
      event, originDeviceId: 'synthetic-count-device', practiceMode: 'quiz'});
    assert.notEqual(record.attemptId, event.eventId);
    const response = await preview.handle(new Request(origin + '/api/account-study', {
      method: 'POST', headers: {'content-type': 'application/json', Origin: origin},
      body: JSON.stringify({action: 'append-records', expectedUserId: preview.userId, libraryId: 'library-a', records: [record]}),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].durable, true);
  }
  const status = await preview.status();
  assert.equal(status.counts.records, 2);
  assert.deepEqual(status.recordCounts, {'quiz:again': 1, 'quiz:good': 1});
  assert.equal(status.counts.aiRequests, 0);
});
