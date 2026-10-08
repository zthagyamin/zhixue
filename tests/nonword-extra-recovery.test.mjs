import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks, loader, nodes, text, button, tick, deferred} from './helpers/causal-harness.mjs';
import {createLocalAttemptRepository} from '../src/infrastructure/learning-attempt/index.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {bindExtraNonWordRound, projectExtraNonWordRound} from '../src/features/nonword-study/extra-round.ts';

globalThis.indexedDB = new IDBFactory();
let serial = 0;
const Marker = () => null;
const displayOverrides = {
  'app/study-plugin-options.tsx': {StudyPluginOptionsProvider: () => null, StudyPluginOptionsSlot: () => null},
  'app/study-guidance.tsx': {StudyGuidanceHelp: () => null}, 'app/review-context.tsx': {ReviewContext: () => null},
  'app/learning-draft.tsx': {LearningDraftBoundary: () => null, LearningDraftLeaveGuard: () => null},
  'app/study-item-source.tsx': {StudyItemSource: () => null}, 'app/math-text.tsx': {MathText: () => null},
  'app/calculation-client.ts': {gradeCalculationInWorker: () => assert.fail('No grading service in this fixture')},
};
function snapshot() {
  const ownerId = `extra-recovery-${serial++}`, workspaceId = `account:${ownerId}`;
  const items = ['A', 'B'].map((id, index) => ({id, pluginType: 'recall', prompt: `Synthetic ${id}`, explanation: `Reference ${id}`, contentHash: (index ? 'b' : 'a').repeat(64)}));
  const recoveryScopes = items.map(item => ({workspaceId, ownerId, libraryId: 'extra-library', snapshotId: 'original-header', itemKey: item.id, contentHash: item.contentHash, groupId: 'normal-group', roundId: 'normal-round', cloud: false, temporary: true}));
  return {scopeKey: `extra-key-${ownerId}`, recoveryDay: '2026-10-05', title: 'Synthetic extra', items, modes: ['recall', 'recall'], sourceModes: ['recall', 'recall'], recoveryScopes, source: {title: 'Synthetic', scope: 'synthetic'}};
}
async function settle(hooks) {
  const cycle = async () => {hooks.flush(); await tick(); hooks.render();};
  for (let i = 0; i < 20; i++) await cycle();
  const loading = () => text(hooks.view()).includes('正在恢复本组巩固');
  const deadline = Date.now() + 15000;
  while (loading() && Date.now() < deadline) await cycle();
  assert.equal(loading(), false, 'Extra page did not acknowledge its original round');
}
async function page(t, source, {wrapRound = group => group} = {}) {
  const hooks = createHooks(), plugin = {id: '@zhixue/plugin-recall', renderUI: () => null};
  const roundApi = loader(hooks.api, displayOverrides)('app/study-dashboard/nonword-round-cache.ts');
  const load = loader(hooks.api, {...displayOverrides, 'app/plugins/index.ts': {registry: {get: () => plugin}}, 'app/study-dashboard/nonword-plugin-host.tsx': {NonWordPluginHost: Marker},
    'app/study-dashboard/nonword-round-cache.ts': {...roundApi, useNonWordRoundCache() {const get = roundApi.useNonWordRoundCache(); return async(...args) => {const group = await get(...args); return group ? wrapRound(group) : null;};}}});
  hooks.mount(load('app/extra-practice-session.tsx').ExtraPracticeSession, {snapshot: source, onExit() {}, canOpenLocal: false, getObsidianUri: () => ''});
  t.after(() => hooks.unmount()); await settle(hooks);
  return {hooks, card: () => [...nodes(hooks.view())].find(node => node.type === Marker), async settle() {await settle(hooks);}};
}
async function active(t, currentPage, {driverGate} = {}) {
  const card = currentPage.card(); assert.ok(card); assert.equal(typeof card.props.round, 'function');
  const boundHooks = createHooks(), hostHooks = createHooks(); let handles;
  const probe = props => {handles = props; props.context.draft.read('answer', ''); return null;};
  const boundLoad = loader(boundHooks.api, displayOverrides), hostLoad = loader(hostHooks.api);
  const outer = boundLoad('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost({...card.props, plugin: {id: '@zhixue/plugin-recall', renderUI: probe}});
  boundHooks.mount(outer.type, outer.props); let hostProps = boundHooks.view().props;
  if (driverGate) {
    const createDriver = hostProps.createDriver;
    hostProps = {...hostProps, async createDriver(...args) {await driverGate.promise; return createDriver(...args);}};
  }
  hostHooks.mount(hostLoad('src/features/nonword-study/host.tsx').NonWordStudyHost, hostProps);
  t.after(() => {hostHooks.unmount(); boundHooks.unmount();});
  async function flush() {for (let i = 0; i < 24; i++) {hostHooks.flush(); await tick(); hostHooks.render();
    for (const node of nodes(hostHooks.view())) if (typeof node.type === 'function' && typeof node.props.renderPlugin === 'function') {
      const rendered = node.type(node.props); if (rendered && typeof rendered.type === 'function') rendered.type(rendered.props);
    }
  } await currentPage.settle();}
  await flush();
  const deadline = Date.now() + 15000;
  while (!handles?.context.nonWordLearning.ready && Date.now() < deadline) await flush();
  assert.equal(handles?.context.nonWordLearning.ready, true, 'Extra host did not acknowledge its saved source and driver');
  return {hostProps, hostHooks, get handles() {return handles;}, flush,
    async answer(raw, rating = 'again', deferred = true) {
      handles.context.draft.write('answer', raw); await handles.context.nonWordLearning.submit(raw);
      if (rating === 'pending') {await handles.context.nonWordLearning.waitForReview('Synthetic offline result'); await handles.context.nonWordLearning.continuePending();}
      else {await handles.context.nonWordLearning.assess({status: rating === 'good' ? 'correct' : 'incorrect', source: 'self-assess', rating, explanation: `Synthetic ${rating}`}); await handles.onGrade(rating, {deferAdvance: deferred});
        if (deferred) {assert.equal(handles.context.draft.continueAfterFeedback(), true); assert.equal(handles.context.draft.continueAfterFeedback(), false);}}
      await flush();
    }, stop() {hostHooks.unmount(); boundHooks.unmount();},
  };
}

test('extra page fixture waits for its real round before cold recovery reads plugin props', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  let finished = false;
  const opening = page(t, snapshot(), {wrapRound: async group => {await gate.promise; return group;}}).then(value => {finished = true; return value;});
  for (let i = 0; i < 80; i++) await tick();
  assert.equal(finished, false, 'An unacknowledged cold round must remain loading');
  gate.resolve(); const restored = await opening;
  assert.ok(restored.card());
});

test('extra fixture waits for the actual driver acknowledgment before exposing learner actions', async t => {
  const gate = deferred(), p = await page(t, snapshot());
  t.after(() => gate.resolve());
  let finished = false;
  const opening = active(t, p, {driverGate: gate}).then(value => {finished = true; return {value};}, error => {finished = true; return {error};});
  for (let i = 0; i < 80; i++) await tick();
  assert.equal(finished, false, 'An unopened driver is still awaiting its real receipt');
  gate.resolve(); const result = await opening;
  assert.equal(result.error, undefined);
  assert.equal(result.value.handles.context.nonWordLearning.ready, true);
});

for (const result of ['again', 'pending']) test(`extra ${result} continues durably to B and a cold reentry restores B raw with no official result`, async t => {
  const source = snapshot(), p = await page(t, source), a = await active(t, p); await a.answer(`EXTRA_A_${result}`, result); a.stop();
  assert.equal(p.card().props.context.nonWordScope.itemKey, 'B'); const b = await active(t, p); b.handles.context.draft.write('answer', 'B_UNSUBMITTED_RAW');
  const driver = await b.hostProps.createDriver('first', 'review'); await driver.runtime.session.save('B_UNSUBMITTED_RAW', {answer: 'B_UNSUBMITTED_RAW'});
  const id = driver.runtime.session.snapshot().attemptId, group = await p.card().props.round(), before = await group.read(); b.stop(); p.hooks.unmount();
  const cold = await page(t, source); assert.equal(cold.card().props.context.nonWordScope.itemKey, 'B'); const restored = await active(t, cold), same = await restored.hostProps.createDriver('first', 'review');
  assert.equal(same.runtime.session.snapshot().attemptId, id); assert.equal(restored.handles.context.draft.read('answer', ''), 'B_UNSUBMITTED_RAW'); assert.equal((await (await cold.card().props.round()).read()).runId, before.runId);
  const repo = createLocalAttemptRepository({userId: source.recoveryScopes[0].ownerId, libraryId: 'extra-library'}), attempts = await repo.list();
  assert.ok(attempts.some(row => row.submitted?.answer === `EXTRA_A_${result}`)); assert.ok(attempts.every(row => !row.formal && row.checkpoint.purpose !== 'first'));
  assert.deepEqual(await createSubmissionJournal().list(source.recoveryScopes[0].workspaceId), []);
});

test('completed extra summary survives refresh and only explicit replay creates new auxiliary IDs', async t => {
  const source = snapshot(), p = await page(t, source), a = await active(t, p); await a.answer('OLD_A_WRONG'); a.stop(); const b = await active(t, p); await b.answer('OLD_B_CORRECT', 'good', false); b.stop();
  assert.equal(p.card(), undefined); assert.match(text(p.hooks.view()), /待巩固 1/); const cold = await page(t, source); assert.equal(cold.card(), undefined); assert.match(text(cold.hooks.view()), /待巩固 1/);
  const repo = createLocalAttemptRepository({userId: source.recoveryScopes[0].ownerId, libraryId: 'extra-library'}), before = (await repo.list()).filter(row => row.submitted);
  assert.equal(before.length, 2); await button(cold.hooks.view(), '再巩固一遍').props.onClick(); await cold.settle(); assert.equal(cold.card().props.context.nonWordScope.itemKey, 'A');
  const replay = await active(t, cold), next = await replay.hostProps.createDriver('first', 'review'); assert.ok(before.every(row => row.attemptId !== next.runtime.session.snapshot().attemptId)); assert.equal(next.runtime.session.snapshot().submitted, null);
  assert.deepEqual((await repo.list()).filter(row => row.submitted), before); const latest = await page(t, source); assert.equal(latest.card().props.context.nonWordScope.itemKey, 'A');
  assert.equal((await latest.card().props.round()).anchorAttemptId, (await cold.card().props.round()).anchorAttemptId); assert.deepEqual(await createSubmissionJournal().list(source.recoveryScopes[0].workspaceId), []);
});

test('auxiliary cursor binding is source exact, separate from normal and rejects words, missing scopes or mixed owners', () => {
  const source = snapshot(), entries = source.items.map((data, index) => ({data, mode: source.modes[index], sourceMode: source.sourceModes[index], scope: source.recoveryScopes[index]}));
  const bound = bindExtraNonWordRound(source.scopeKey, entries, source.recoveryDay); assert.ok(bound); assert.equal(bound.scope.temporary, false); assert.notEqual(bound.scope.groupId, entries[0].scope.groupId); assert.ok(source.recoveryScopes.every(scope => scope.temporary));
  assert.equal(bindExtraNonWordRound(source.scopeKey, [{...entries[0], data: {...entries[0].data, word: 'tree'}}], source.recoveryDay), null);
  assert.equal(bindExtraNonWordRound(source.scopeKey, [{...entries[0], scope: undefined}], source.recoveryDay), null);
  assert.equal(bindExtraNonWordRound(source.scopeKey, [entries[0], {...entries[1], scope: {...entries[1].scope, ownerId: 'other'}}], source.recoveryDay), null);
  assert.equal(bindExtraNonWordRound(source.scopeKey, [{...entries[0], data: {...entries[0].data, contentHash: 'c'.repeat(64)}}], source.recoveryDay), null);
  assert.throws(() => projectExtraNonWordRound(bound, {members: [{...bound.scope.members[0], snapshotId: 'new-head'}]}), /来源版本/);
});

test('controlled extra skip waits for a durable cursor, rejects duplicates and preserves raw input on failure', async t => {
  const source = snapshot(); let fail = true, writes = 0; const gate = deferred();
  const p = await page(t, source, {wrapRound: group => ({...group, async saveCursor(cursor, expected) {writes++; if (fail) throw Error('Synthetic cursor write failure'); await gate.promise; return group.saveCursor(cursor, expected);}})});
  const a = await active(t, p), driver = await a.hostProps.createDriver('first', 'review'); a.handles.context.draft.write('answer', 'UNSUBMITTED_A_RAW'); await driver.runtime.session.save('UNSUBMITTED_A_RAW', {answer: 'UNSUBMITTED_A_RAW'});
  button(p.hooks.view(), '暂时跳过').props.onClick(); await p.settle(); assert.equal(p.card().props.context.nonWordScope.itemKey, 'A'); assert.match(text(p.hooks.view()), /Synthetic cursor write failure/);
  assert.equal((await driver.runtime.repository.read(driver.runtime.session.snapshot().attemptId)).answer, 'UNSUBMITTED_A_RAW');
  fail = false; const skip = button(p.hooks.view(), '暂时跳过'); skip.props.onClick(); skip.props.onClick(); await p.settle(); assert.equal(writes, 2); assert.equal(p.card().props.context.nonWordScope.itemKey, 'A');
  gate.resolve(); await p.settle(); const accepted = await (await p.card().props.round()).read(); assert.equal(accepted.currentItemKey, 'B'); assert.deepEqual(accepted.traversal.skippedKeys, ['A']);
  assert.deepEqual(accepted.traversal.wrongKeys, []); assert.deepEqual(accepted.traversal.awaitingReviewKeys, []); assert.equal((await driver.runtime.repository.read(driver.runtime.session.snapshot().attemptId)).answer, 'UNSUBMITTED_A_RAW');
  const cold = await page(t, source); assert.equal(cold.card().props.context.nonWordScope.itemKey, 'B'); assert.deepEqual(await createSubmissionJournal().list(source.recoveryScopes[0].workspaceId), []);
});

test('failed extra replay retains the summary and old callbacks cannot advance the accepted new run', async t => {
  const source = snapshot(); let failReplay = false;
  const p = await page(t, source, {wrapRound: group => ({...group, startNewRound: input => {if (failReplay) throw Error('Synthetic replay write failure'); return group.startNewRound(input);}})});
  const a = await active(t, p), oldUI = p.card().props.context.nonWordNavigation.resumeFormal, oldDriver = await a.hostProps.createDriver('first', 'review'); await a.answer('OLD_A'); a.stop();
  const b = await active(t, p); await b.answer('OLD_B', 'good'); b.stop(); assert.equal(p.card(), undefined); failReplay = true;
  button(p.hooks.view(), '再巩固一遍').props.onClick(); await p.settle(); assert.equal(p.card(), undefined); assert.match(text(p.hooks.view()), /Synthetic replay write failure/);
  failReplay = false; button(p.hooks.view(), '再巩固一遍').props.onClick(); await p.settle(); const group = await p.card().props.round(), before = await group.read(); assert.equal(before.currentItemKey, 'A');
  await assert.rejects(oldDriver.continueGroup('good'), /run-conflict/); oldUI('good'); await p.settle(); assert.equal(p.card().props.context.nonWordScope.itemKey, 'A'); assert.deepEqual(await group.read(), before);
});

test('word source with recovery metadata and older no-scope extra entry never open an auxiliary cursor', async t => {
  for (const word of [true, false]) {
    const source = snapshot(), original = structuredClone(source);
    if (word) {source.sourceModes = ['three-stage', 'three-stage']; source.items = source.items.map(item => ({...item, word: 'tree', pluginType: 'three-stage'}));}
    else delete source.recoveryScopes;
    const p = await page(t, source, {wrapRound() {assert.fail('Legacy source cannot create a cursor');}});
    assert.equal(p.card(), undefined); const rendered = [...nodes(p.hooks.view())].find(node => node.props.context); assert.ok(rendered); assert.equal(rendered.props.context.nonWordScope, undefined); assert.strictEqual(rendered.props.context.contentSource.data, source.items[0]);
    const repo = createLocalAttemptRepository({userId: original.recoveryScopes[0].ownerId, libraryId: 'extra-library'}); assert.deepEqual(await repo.list(), []); assert.equal(button(p.hooks.view(), '暂时跳过'), undefined);
  }
});

test('legacy no-scope recall retains its explicit skip after saved feedback', async t => {
  const source = snapshot(); delete source.recoveryScopes; const p = await page(t, source);
  const card = [...nodes(p.hooks.view())].find(node => node.props.context); await card.props.onGrade('again', {deferAdvance: true});
  assert.equal(card.props.context.draft.hasSavedFeedback(), true); card.props.context.recallNavigation.onSkip(); await p.settle();
  const next = [...nodes(p.hooks.view())].find(node => node.props.context); assert.equal(next.props.context.contentSource.data.id, 'B'); assert.equal(next.props.context.nonWordScope, undefined);
});
