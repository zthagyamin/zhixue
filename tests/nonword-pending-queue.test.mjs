import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks, loader, nodes, text, button, deferred, tick} from './helpers/causal-harness.mjs';
import {tsxFunction} from './fixtures/tsx-functions.mjs';

function row(id, changes = {}) {
  return {schemaVersion: 1, attemptId: id, binding: {ownerId: 'owner', libraryId: 'library', snapshotId: 'old-snapshot',
    itemKey: `question:${id}`, contentHash: 'a'.repeat(64), groupId: 'old-day-group', roundId: 'old-round'},
    parentAttemptId: null, revision: 3, answerRevision: 1, answer: 'temporary field must not replace submitted original',
    updatedAt: '2026-10-06T01:00:00.000Z', checkpoint: {phase: 'submitted', position: 0, traversed: true, mode: 'recall', purpose: 'first'},
    submitted: {answer: `ORIGINAL ${id}`, answerRevision: 1, submittedAt: '2026-10-05T01:00:00.000Z', assistance: 'unknown'},
    evaluation: {status: 'pending', reason: 'offline'}, formal: null, operations: [], ...changes};
}
const source = attempt => ({attemptId: attempt.attemptId, binding: attempt.binding, kind: 'practice',
  title: '原题标题', sourceLabel: '旧来源 §2', prompt: '解释 $x^2$ 的条件。', reference: '原参考 $x^2=x*x$。'});
async function settle(f) {for (let i = 0; i < 8; i++) {f.hooks.flush(); await tick(); f.hooks.render();}}
function fixture({rows = [row('one')], list, reference = source, onResume, props = {}} = {}) {
  const hooks = createHooks(), calls = [], load = loader(hooks.api);
  let Component;
  try { Component = load('src/features/nonword-study/pending.tsx').PendingAnswerQueue; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(typeof Component, 'function', 'Pending queue must render the real controlled feature');
  const port = {async list() {calls.push(['list']); return list ? list() : rows;},
    async reference(attempt) {calls.push(['reference', attempt.attemptId]); return reference(attempt);},
    async onResume(attempt) {calls.push(['resume', attempt]); return onResume?.(attempt);}};
  const initial = {ownerId: 'owner', libraryId: 'library', version: 'v1', port, renderMath: value => value, ...props};
  hooks.mount(Component, initial);
  return {hooks, calls, port, props: initial, view: () => hooks.view(),
    async click(label) {const target = button(hooks.view(), label); assert.ok(target, `Missing ${label}: ${text(hooks.view())}`);
      assert.notEqual(target.props.disabled, true); const pending = target.props.onClick(); hooks.render(); await settle(this); return pending;}};
}

test('an unavailable account read cannot be presented as a verified empty backlog',async()=>{
  const f=fixture({rows:[]});f.port.notice=()=> '当前服务尚不支持待核对答案读取；本机答案保留。';
  await f.click('待核对答案');assert.match(text(f.view()),/尚不支持待核对答案读取/);
  assert.doesNotMatch(text(f.view()),/当前资料库没有待核对/);f.hooks.unmount();
});

test('closed queue performs no reads; opening includes only owned submitted first nonword answers across days', async () => {
  const eligible = row('one');
  const rows = [eligible, row('foreign', {binding: {...eligible.binding, ownerId: 'other'}}),
    row('library', {binding: {...eligible.binding, libraryId: 'other'}}), row('draft', {submitted: null,answer:''}),
    row('guided', {checkpoint: {...eligible.checkpoint, purpose: 'guided'}}), row('child', {parentAttemptId: 'first'}),
    row('anchor', {checkpoint: {...eligible.checkpoint, mode: 'lesson', purpose: 'guided'}}),
    row('word', {binding: {...eligible.binding, itemKey: 'word:tree'}}),
    row('linked', {evaluation: {status: 'resolved'}, formal: {status: 'linked'}}),
    row('save-pending', {evaluation: {status: 'resolved'}, formal: {status: 'claimed'}})];
  const f = fixture({rows}); await settle(f); assert.deepEqual(f.calls, []);
  await f.click('待核对答案');
  assert.match(text(f.view()), /待核对答案 2/);
  assert.match(text(f.view()), /旧来源 §2/); assert.match(text(f.view()), /正式保存待完成/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'reference').map(call => call[1]).sort(), ['one', 'save-pending']);
  const times = [...nodes(f.view())].filter(node => node.type === 'time');
  assert.equal(times[0].props.dateTime, eligible.submitted.submittedAt); f.hooks.unmount();
});

test('the raw submitted answer is complete and expandable even when original source cannot load', async () => {
  const original = 'RAW '.repeat(3000) + '\nEND OF ORIGINAL';
  const f = fixture({rows: [row('long', {submitted: {...row('long').submitted, answer: original}})],
    reference: async () => {throw Error('Original source offline');}});
  await f.click('待核对答案');
  const answer = [...nodes(f.view())].find(node => node.type === 'pre');
  assert.equal(text(answer), original); assert.notEqual([...nodes(f.view())].find(node => node.type === 'details').props.open, true);
  assert.match(text(f.view()), /原回答仍保留/);
  assert.equal(button(f.view(), '继续核对原答案').props.disabled, true);
  assert.equal(f.calls.some(call => call[0] === 'resume'), false); f.hooks.unmount();
});

test('source version substitution is rejected and the original answer survives retry', async () => {
  let reads = 0; const original = row('one');
  const f = fixture({reference: async attempt => ++reads === 1
    ? {...source(attempt), binding: {...attempt.binding, contentHash: 'b'.repeat(64)}} : source(attempt)});
  await f.click('待核对答案'); assert.match(text(f.view()), /版本不一致/);
  assert.match(text(f.view()), /ORIGINAL one/); assert.equal(button(f.view(), '继续核对原答案').props.disabled, true);
  await f.click('重试读取原资料'); await f.click('继续核对原答案');
  const resumed = f.calls.find(call => call[0] === 'resume')[1];
  assert.deepEqual(resumed, original); assert.equal(resumed.binding.snapshotId, 'old-snapshot'); f.hooks.unmount();
});

test('duplicate resume clicks share one action; failed resume can explicitly retry the exact saved identity', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({onResume: async () => {if (++calls === 1) {await gate.promise; throw Error('当前来源尚未恢复');}}});
  await f.click('待核对答案'); const click = button(f.view(), '继续核对原答案').props.onClick;
  click(); click(); await settle(f); assert.equal(calls, 1);
  gate.resolve(); await settle(f); assert.match(text(f.view()), /当前来源尚未恢复/);
  await f.click('继续核对原答案'); assert.equal(calls, 2);
  assert.deepEqual(f.calls.filter(call => call[0] === 'resume').map(call => call[1].attemptId), ['one', 'one']); f.hooks.unmount();
});

test('owner or list-version change ignores late list and reference responses and hides previous raw work immediately', async () => {
  const list = deferred(), f = fixture({list: () => list.promise});
  f.click('待核对答案'); await settle(f);
  f.hooks.render({...f.props, ownerId: 'new-owner'}); assert.doesNotMatch(text(f.view()), /ORIGINAL one/);
  list.resolve([row('one')]); await settle(f); assert.doesNotMatch(text(f.view()), /ORIGINAL one/);
  assert.equal(f.calls.some(call => call[0] === 'reference'), false); f.hooks.unmount();
  const reference = deferred(), second = fixture({reference: () => reference.promise});
  await second.click('待核对答案');
  second.hooks.render({...second.props, version: 'v2'}); reference.resolve(source(row('one')));
  await settle(second); assert.doesNotMatch(text(second.view()), /ORIGINAL one|旧来源/); second.hooks.unmount();
});

test('account unsupported notice preserves controlled local reading and never invokes a scoring service', async () => {
  const f = fixture({props: {accountCapability: 'unsupported'}});
  await f.click('待核对答案'); assert.match(text(f.view()), /账号服务尚不支持/);
  assert.match(text(f.view()), /ORIGINAL one/); await f.click('继续核对原答案');
  assert.deepEqual(new Set(f.calls.map(call => call[0])), new Set(['list', 'reference', 'resume'])); f.hooks.unmount();
});

test('a word override found in the authoritative reference is excluded rather than displayed or resumed', async () => {
  const f = fixture({reference: async attempt => ({...source(attempt), kind: 'word'})});
  await f.click('待核对答案'); assert.match(text(f.view()), /待核对答案 0/);
  assert.doesNotMatch(text(f.view()), /ORIGINAL one/); assert.equal(button(f.view(), '继续核对原答案'), undefined); f.hooks.unmount();
});

test('refreshing the list does not unlock an in-flight resume of the same saved answer', async () => {
  const gate = deferred(); let reads = 0;
  const saved = row('one'), f = fixture({onResume: () => gate.promise, list: async () => [reads++ === 0 ? saved
    : {...saved, binding: Object.fromEntries(Object.entries(saved.binding).reverse())}]});
  await f.click('待核对答案'); const click = button(f.view(), '继续核对原答案').props.onClick;
  click(); await settle(f); await f.click('刷新待核对答案');
  assert.equal(button(f.view(), '正在打开原答案…').props.disabled, true);
  click(); await settle(f); assert.equal(f.calls.filter(call => call[0] === 'resume').length, 1);
  gate.resolve(); await settle(f); f.hooks.unmount();
});

test('empty saved work is described honestly without inventing an oral transcript or outcome', async () => {
  const f = fixture({rows: [row('empty', {submitted: {...row('empty').submitted, answer: ''}})]});
  await f.click('待核对答案'); assert.match(text(f.view()), /本次没有保存文字回答/);
  assert.doesNotMatch(text(f.view()), /本次为口头回忆/); f.hooks.unmount();
});

test('paused unsubmitted first work offers explicit continuation without claiming submitted feedback',async()=>{
  const draft=row('old-draft',{submitted:null,answer:'SAVED UNFINISHED ANSWER',updatedAt:'2026-10-05T19:59:00.000Z',checkpoint:{phase:'answering',position:0,traversed:false,mode:'recall',purpose:'first',view:{purpose:'guided',instanceId:'guided-old-instance',lessonStep:'guided',paused:true,referenceSeen:true}}});
  const f=fixture({rows:[draft]});await f.click('待核对答案');assert.match(text(f.view()),/尚未提交/);assert.match(text(f.view()),/SAVED UNFINISHED ANSWER/);assert.doesNotMatch(text(f.view()),/等待核对|正式保存待完成/);
  assert.equal(nodes(f.view()).find(node=>node.type==='time').props.dateTime,draft.updatedAt);await f.click('继续学习原草稿');assert.equal(f.calls.filter(call=>call[0]==='resume').length,1);assert.equal(f.calls.find(call=>call[0]==='resume')[1].submitted,null);f.hooks.unmount();
});

test('source reads are bounded while every complete original answer remains available', async () => {
  const gates = new Map(), rows = Array.from({length: 8}, (_, i) => row(String(i)));
  const f = fixture({rows, reference: attempt => {
    const gate = deferred(); gates.set(attempt.attemptId, gate); return gate.promise;
  }});
  await f.click('待核对答案'); assert.equal(gates.size, 4);
  assert.equal([...nodes(f.view())].filter(node => node.type === 'pre').length, 8);
  gates.get('0').resolve(source(rows[0])); await settle(f); assert.equal(gates.size, 5);
  f.hooks.unmount(); for (const [id, gate] of gates) gate.resolve(source(rows.find(attempt => attempt.attemptId === id)));
  await tick();
});

test('a late resume rejection cannot expose the previous owner error or answer in a new scope', async () => {
  const gate = deferred(), f = fixture({onResume: () => gate.promise});
  await f.click('待核对答案'); button(f.view(), '继续核对原答案').props.onClick(); await settle(f);
  f.hooks.render({...f.props, ownerId: 'another-owner'});
  gate.reject(Error('PREVIOUS OWNER PRIVATE ERROR')); await settle(f);
  assert.doesNotMatch(text(f.view()), /PREVIOUS OWNER|ORIGINAL one/); f.hooks.unmount();
});

test('Strict Mode effect rehearsal restores liveness while invalidating requests from its cleanup', () => {
  const live = {current: true}, sequence = {current: 0};
  const setup = tsxFunction(new URL('../src/features/nonword-study/pending.tsx', import.meta.url),
    'PendingAnswerQueue', {live, sequence}, {effect: true});
  setup()(); assert.equal(live.current, false); assert.equal(sequence.current, 1);
  const cleanup = setup(); assert.equal(live.current, true);
  cleanup(); assert.equal(sequence.current, 2);
});
