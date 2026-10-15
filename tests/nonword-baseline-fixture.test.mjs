import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {prepareAccountStudyRecord} from '../app/account-study-record-client.ts';
import {createAccountAttemptClient} from '../src/infrastructure/learning-attempt/index.ts';
import {createDashboardCodeAccount} from '../scripts/dashboard-code-flow.mjs';

let fixture;
try { fixture = await import('./fixtures/nonword-baseline-preview.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const repo = fileURLToPath(new URL('../', import.meta.url));

test('synthetic legacy test exception is published through the supported v1 code contract',async t=>{
  const preview=await createDashboardCodeAccount({repo,origin:'http://127.0.0.1:3068',day:'2026-10-11'},'test-error');
  t.after(()=>preview.close());
  const item=(await preview.client.load()).bundle.items[0];
  assert.equal(item.schemaVersion,1);assert.equal(Object.hasOwn(item,'learningSupport'),false);
  assert.equal(item.practice.initialCode,item.practice.solutionCode);
  assert.match(item.practice.testCode,/raise RuntimeError/);assert.equal((await preview.status()).counts.records,0);
});

test('opt-in code fixture publishes structured public checks without expanding the frozen four-scenario baseline',async t=>{
  assert.equal(fixture.SCENARIOS.length,4);assert.equal(fixture.scenarioLinks(3050).length,4);
  const preview=await fixture.createNonwordAccount({repo,origin:'http://127.0.0.1:3066',scenario:'code-basic',stage3:true});
  t.after(()=>preview.close());
  const loaded=await preview.client.load(),item=loaded.bundle.items[0];
  assert.equal(item.practice.questionType,'code');assert.equal(item.learningSupport.type,'code');
  assert.equal(item.practice.initialCode,'def add(a, b):\n    return a - b');
  assert.equal(item.practice.solutionCode,'def add(a, b):\n    return a + b');
  assert.deepEqual(item.learningSupport.cases.map(row=>[row.id,row.args,row.expected]),[['positive',[1,2],3],['negative',[-1,2],1]]);
  assert.deepEqual((await preview.client.getPlanState(preview.day)).approvedPlan.tasks[0].action.itemKeys,[item.itemKey]);
  assert.equal((await preview.status()).counts.records,0);assert.equal((await preview.status()).counts.aiRequests,0);
  assert.equal(fixture.scenarioLinks(3050,'code-basic').length,1);
});

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

test('requested practice evidence uses the real current adapter while providers stay blocked',async t=>{
  const origin='http://127.0.0.1:3059';
  const preview=await fixture.createNonwordAccount({repo,origin,scenario:'guided-maths',stage3:true});
  t.after(()=>preview.close());
  const response=await preview.handle(new Request(origin+'/api/account-study',{method:'POST',
    headers:{'content-type':'application/json',Origin:origin},
    body:JSON.stringify({action:'practice-evidence-list',libraryId:'library-a'})}));
  assert.equal(response.status,200);
  const status=await preview.status();assert.equal(status.counts.records,0);assert.equal(status.counts.aiRequests,0);
  assert.equal(status.externalModels,'blocked');
});

test('explicit synthetic owner and library scopes keep identical material in separate empty stores',async t=>{
  const origin='http://127.0.0.1:3063';
  const previews=[];
  t.after(()=>previews.forEach(preview=>preview.close()));
  for(const extra of [{},{ownerTag:'owner-b'},{libraryId:'library-b'}])
    previews.push(await fixture.createNonwordAccount({repo,origin,scenario:'guided-maths',stage3:true,...extra}));
  const loaded=await Promise.all(previews.map(preview=>preview.client.load()));
  assert.notEqual(previews[0].userId,previews[1].userId);
  assert.equal(previews[0].userId,previews[2].userId);
  assert.deepEqual(loaded.map(row=>row.bundle.snapshot.libraryId),['library-a','library-a','library-b']);
  assert.equal(new Set(loaded.map(row=>row.bundle.items[0].contentHash)).size,1);
  assert.equal(new Set(loaded.map(row=>row.bundle.items[0].itemKey)).size,1);
  for(const preview of previews){
    const status=await preview.status();assert.equal(status.counts.records,0);assert.equal(status.counts.aiRequests,0);
    assert.equal(status.externalModels,'blocked');assert.equal(preview.token,undefined);
  }
});

test('material revision publishes a new reference while an existing answer keeps its original bundle',async t=>{
  const origin='http://127.0.0.1:3064';
  const preview=await fixture.createNonwordAccount({repo,origin,scenario:'guided-maths',stage3:true});
  t.after(()=>preview.close());
  const old=await preview.client.load(),item=old.bundle.items[0];
  const attempts=createAccountAttemptClient({ownerId:preview.userId,libraryId:'library-a',
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const binding={ownerId:preview.userId,libraryId:'library-a',snapshotId:old.bundle.snapshot.snapshotId,
    itemKey:item.itemKey,contentHash:item.contentHash,groupId:'revision-group',roundId:'revision-round'};
  const opened=await attempts.mutate({schemaVersion:1,kind:'checkpoint',attemptId:'revision-first',operationId:'revision-open',
    binding,expectedRevision:0,updatedAt:preview.day+'T00:01:00.000Z',answer:' 4 ',parentAttemptId:null,
    checkpoint:{phase:'answering',position:0,traversed:false,visited:[],pending:[],skipped:[],mode:'calculation',purpose:'first'}});
  await attempts.mutate({schemaVersion:1,kind:'submit',attemptId:'revision-first',operationId:'revision-submit',binding,
    expectedRevision:opened.revision,answerRevision:opened.attempt.answerRevision,assistance:'unknown',updatedAt:preview.day+'T00:02:00.000Z'});
  const body=structuredClone(item);delete body.contentHash;
  body.sourceHash='b'.repeat(64);body.practice={...body.practice,prompt:'实数 x = 2。求 (x + 1)^2 的最终数值。',answer:'9',
    explanation:'(x + 1)^2 = x^2 + 2x + 1；x = 2 时为 4 + 4 + 1 = 9。'};
  assert.equal(typeof preview.reviseMaterial,'function');
  await preview.reviseMaterial(body);
  const fresh=await preview.client.load(),reference=await attempts.referenceBundle('revision-first');
  assert.equal(fresh.bundle.snapshot.revision,2);assert.equal(fresh.bundle.items[0].itemKey,item.itemKey);
  assert.notEqual(fresh.bundle.items[0].contentHash,item.contentHash);assert.equal(fresh.bundle.items[0].practice.answer,'9');
  assert.equal(fresh.bundle.items[0].practice.explanation,'(x + 1)^2 = x^2 + 2x + 1；x = 2 时为 4 + 4 + 1 = 9。');
  assert.equal(reference.item.practice.explanation,'(x + 1)^2 = x^2 + 2x + 1；x = 1 时为 1 + 2 + 1 = 4。');
  assert.equal(reference.item.contentHash,item.contentHash);assert.equal(reference.item.practice.answer,'4');
  assert.equal(reference.snapshot.snapshotId,old.bundle.snapshot.snapshotId);
  assert.equal((await attempts.read('revision-first')).submitted.answer,' 4 ');
  assert.equal((await preview.status()).counts.records,0);assert.equal((await preview.status()).counts.aiRequests,0);
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
