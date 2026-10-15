import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReadingClock, createPaperReadingGroupClock} from '../src/application/paper-reading-clock/index.ts';

const scope = {ownerId: 'account:u', libraryId: 'local:l', materialFingerprint: 'a'.repeat(64)};
function fixture() {
    let time = 0, id = 0, saved = null, fail = false;
    const store = {
        async read() {return structuredClone(saved);},
        async save(key, value, expectedRevision) {
            if (fail) throw Error('quota');
            assert.deepEqual(key, scope);
            if ((saved?.revision ?? 0) !== expectedRevision) throw Error('clock-conflict');
            saved = structuredClone(value);
            return structuredClone(saved);
        },
    };
    const make = (extra = {}) => createPaperReadingClock({scope, store, now: () => time, makeId: () => `clock-${++id}`, ...extra});
    return {make, store, advance: ms => {time += ms;}, fail: value => {fail = value;}, saved: () => saved};
}

test('reading clock counts eligible visible interaction and excludes pause, hidden and inactive intervals', async () => {
    const f = fixture(), clock = f.make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    f.advance(12000); assert.equal(clock.snapshot().elapsedMs, 12000);
    await clock.pause(true); f.advance(90000); assert.equal(clock.snapshot().elapsedMs, 12000);
    await clock.pause(false); f.advance(3000); clock.setVisible(false); f.advance(90000);
    assert.equal(clock.snapshot().elapsedMs, 15000);
    clock.setVisible(true); f.advance(2000); clock.setActive(false); f.advance(90000);
    assert.equal(clock.snapshot().elapsedMs, 17000);
    clock.setActive(true); f.advance(1000); await clock.flush();
    assert.equal(f.saved().elapsedMs, 18000);
});

test('refresh restores elapsed and pause without crediting time while absent', async () => {
    const f = fixture(), clock = f.make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    f.advance(10000); await clock.pause(true); clock.dispose(); f.advance(900000);
    const restored = f.make(); await restored.load(); restored.setVisible(true); restored.setActive(true);
    assert.equal(restored.snapshot().paused, true); assert.equal(restored.snapshot().elapsedMs, 10000);
    f.advance(5000); assert.equal(restored.snapshot().elapsedMs, 10000);
    await restored.pause(false); f.advance(5000); assert.equal(restored.snapshot().elapsedMs, 15000);
});

test('save failure retains live elapsed and pause, preserves old checkpoint and allows retry', async () => {
    const f = fixture(), clock = f.make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    f.advance(3000); await clock.flush(); const old = structuredClone(f.saved()); f.advance(2000); f.fail(true);
    await assert.rejects(clock.pause(true), /quota/); assert.deepEqual(f.saved(), old);
    assert.equal(clock.snapshot().paused, true); assert.equal(clock.snapshot().elapsedMs, 5000);
    assert.equal(clock.snapshot().saveStatus, 'failed'); f.advance(90000); f.fail(false); await clock.flush();
    assert.equal(f.saved().elapsedMs, 5000); assert.equal(clock.snapshot().saveStatus, 'saved');
});

test('late restore or write cannot update a disposed or changed owner scope', async () => {
    const f = fixture(); let release, current = true;
    const read = new Promise(resolve => {release = resolve;});
    const clock = f.make({store: {...f.store, read: () => read}, isCurrent: () => current});
    const loading = clock.load(); current = false; release(null); await loading;
    assert.equal(clock.snapshot().status, 'loading'); await assert.rejects(clock.flush(), /inactive|scope/);
    const ready = f.make(); await ready.load(); ready.dispose(); await assert.rejects(ready.pause(true), /inactive/);
});

test('failed or corrupt restore never resets or overwrites an existing clock', async () => {
    const f = fixture(), clock = f.make({store: {...f.store, read: async () => {throw Error('corrupt');}}});
    await assert.rejects(clock.load(), /corrupt/); assert.equal(clock.snapshot().status, 'unavailable');
    await assert.rejects(clock.flush(), /not-ready/); assert.equal(f.saved(), null);
});

test('soft target never stops reading or estimates learning quality and backward time does not subtract', async () => {
    const f = fixture(), clock = f.make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    f.advance(600000); assert.equal(clock.snapshot().softTarget, 'within');
    f.advance(600000); assert.equal(clock.snapshot().softTarget, 'beyond'); assert.equal(clock.snapshot().paused, false);
    f.advance(-1000); assert.equal(clock.snapshot().elapsedMs, 1200000);
});

test('receipt loss retries the same checkpoint before saving later elapsed and pause', async () => {
    const f = fixture(); let lost = true;
    const store = {...f.store, async save(key, value, revision) {
        if (f.saved()?.operationId === value.operationId) return structuredClone(f.saved());
        const receipt = await f.store.save(key, value, revision);
        if (lost) {lost = false; throw Error('lost-receipt');} return receipt;
    }};
    const clock = f.make({store}); await clock.load(); clock.setVisible(true); clock.setActive(true); f.advance(2000);
    await assert.rejects(clock.flush(), /lost-receipt/); const committed = f.saved().operationId;
    f.advance(1000); await clock.pause(true);
    assert.equal(f.saved().revision, 2); assert.notEqual(f.saved().operationId, committed);
    assert.equal(f.saved().elapsedMs, 3000); assert.equal(f.saved().paused, true);
});

test('late old-scope write receipts never publish into the new reader', async () => {
    const f = fixture(); let release, start, current = true;
    const gate = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {start = resolve;});
    const clock = f.make({isCurrent: () => current, store: {...f.store, async save(...args) {start(); await gate; return f.store.save(...args);}}});
    await clock.load(); clock.setVisible(true); clock.setActive(true); f.advance(2000);
    let calls = 0; clock.subscribe(() => calls++); const write = clock.flush(); await started;
    current = false; const priorCalls = calls; release(); await write;
    assert.equal(calls, priorCalls); assert.notEqual(clock.snapshot().saveStatus, 'saved');
});

function groupFixture(legacy = null) {
    let time = 0, id = 0, groups = null, fail = false, lost = false;
    const store = {
        async read() {return structuredClone(legacy);},
        async save() {throw Error('legacy-write-forbidden');},
        async readGroups() {return structuredClone(groups);},
        async saveGroups(key, value, expected) {
            assert.deepEqual(key, scope);
            if (fail) throw Error('quota');
            if (groups?.operationId === value.operationId) return structuredClone(groups);
            if ((groups?.revision ?? 0) !== expected) throw Error('groups-conflict');
            groups = structuredClone(value);
            if (lost) {lost = false; throw Error('lost-groups-receipt');}
            return structuredClone(groups);
        },
    };
    return {make: (extra = {}) => createPaperReadingGroupClock({scope, store, now: () => time, makeId: () => `group-op-${++id}`, ...extra}), store,
        advance: ms => {time += ms;}, fail: value => {fail = value;}, lose: () => {lost = true;}, saved: () => structuredClone(groups)};
}
test('first reading group starts at zero without rewriting or borrowing legacy material time', async () => {
    const legacy = {schemaVersion: 1, scope, revision: 7, operationId: 'legacy', elapsedMs: 1200000, paused: true};
    const f = groupFixture(legacy), clock = f.make(); await clock.load(); clock.setActive(true); clock.setVisible(true);
    assert.equal(clock.snapshot().elapsedMs, 0); assert.equal(clock.snapshot().materialElapsedMs, 1200000);
    assert.equal(clock.snapshot().paused, true); assert.equal(clock.snapshot().softTarget, 'below');
    f.advance(60000); assert.equal(clock.snapshot().elapsedMs, 0); await clock.pause(false);
    f.advance(1000); await clock.flush(); assert.equal(clock.snapshot().elapsedMs, 1000);
    assert.equal(legacy.elapsedMs, 1200000); assert.equal(legacy.revision, 7);
});
test('new group preserves the previous group and restores its own identity elapsed and pause', async () => {
    const f = groupFixture(), clock = f.make(); await clock.load(); clock.setActive(true); clock.setVisible(true);
    const first = clock.snapshot().groupId; f.advance(600000); await clock.startGroup();
    assert.notEqual(clock.snapshot().groupId, first); assert.equal(clock.snapshot().elapsedMs, 0);
    assert.equal(clock.snapshot().softTarget, 'below'); assert.equal(f.saved().groups[0].elapsedMs, 600000);
    assert.equal(f.saved().groups[0].completed, true); f.advance(2000); await clock.pause(true); clock.dispose();
    f.advance(900000); const restored = f.make(); await restored.load(); restored.setActive(true); restored.setVisible(true);
    assert.equal(restored.snapshot().groupId, f.saved().groups[1].groupId);
    assert.equal(restored.snapshot().elapsedMs, 2000); assert.equal(restored.snapshot().paused, true);
    assert.equal(restored.snapshot().materialElapsedMs, 602000);
});
test('group soft target never closes the group; completion is explicit and later new group retains history', async () => {
    const f = groupFixture(), clock = f.make(); await clock.load(); clock.setActive(true); clock.setVisible(true);
    f.advance(1200000); const id = clock.snapshot().groupId;
    assert.equal(clock.snapshot().softTarget, 'beyond'); assert.equal(clock.snapshot().groupCompleted, false);
    await clock.completeGroup(); f.advance(90000); assert.equal(clock.snapshot().elapsedMs, 1200000);
    assert.equal(clock.snapshot().groupId, id); assert.equal(clock.snapshot().groupCompleted, true);
    await clock.completeGroup(); assert.equal(f.saved().groups.length, 1);
    await clock.startGroup(); f.advance(1000); clock.setVisible(false); f.advance(90000); clock.setVisible(true);
    clock.setActive(false); f.advance(90000); clock.setActive(true); f.advance(1000); await clock.flush();
    assert.equal(clock.snapshot().elapsedMs, 2000); assert.equal(f.saved().groups.length, 2);
});
test('failed new-group boundary keeps the prior visible group and retries uncertain receipt without duplicate groups', async () => {
    const f = groupFixture(), clock = f.make(); await clock.load(); clock.setActive(true); clock.setVisible(true);
    f.advance(3000); await clock.flush(); const first = clock.snapshot().groupId;
    f.lose(); await assert.rejects(clock.startGroup(), /lost-groups-receipt/);
    assert.equal(clock.snapshot().groupId, first); assert.equal(clock.snapshot().saveStatus, 'failed');
    f.advance(90000); assert.equal(clock.snapshot().elapsedMs, 3000);
    await clock.flush(); assert.notEqual(clock.snapshot().groupId, first); assert.equal(clock.snapshot().elapsedMs, 0);
    assert.equal(f.saved().groups.length, 2);
});

test('repeated start is one group boundary and a competing completion never changes its meaning', async () => {
    const f = groupFixture(); let release, started;
    const gate = new Promise(resolve => {release = resolve;}), entered = new Promise(resolve => {started = resolve;});
    const clock = f.make({store: {...f.store, async saveGroups(key, value, revision) {
        if (value.groups.length === 2) {started(); await gate;} return f.store.saveGroups(key, value, revision);
    }}});
    await clock.load(); const one = clock.startGroup(), repeated = clock.startGroup();
    assert.equal(one, repeated); await entered; await assert.rejects(clock.completeGroup(), /boundary-conflict/);
    release(); await one; assert.equal(f.saved().groups.length, 2); assert.equal(clock.snapshot().groupCompleted, false);
});

test('new-group save failure preserves current identity and old durable group until retry', async () => {
    const f = groupFixture(), clock = f.make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    f.advance(5000); await clock.flush(); const prior = f.saved(), id = clock.snapshot().groupId;
    f.fail(true); await assert.rejects(clock.startGroup(), /quota/);
    assert.equal(clock.snapshot().groupId, id); assert.deepEqual(f.saved(), prior);
    f.advance(90000); assert.equal(clock.snapshot().elapsedMs, 5000);
    f.fail(false); await clock.flush(); assert.equal(f.saved().groups.length, 2); assert.equal(clock.snapshot().elapsedMs, 0);
});

test('late group boundary or restore cannot publish into a changed reading scope', async () => {
    const f = groupFixture(); let release, started, current = true;
    const gate = new Promise(resolve => {release = resolve;}), entered = new Promise(resolve => {started = resolve;});
    const clock = f.make({isCurrent: () => current, store: {...f.store, async saveGroups(key, value, revision) {
        if (value.groups.length === 2) {started(); await gate;} return f.store.saveGroups(key, value, revision);
    }}});
    await clock.load(); const id = clock.snapshot().groupId; let calls = 0; clock.subscribe(() => calls++);
    const switching = clock.startGroup(); await entered; current = false; const priorCalls = calls; release(); await switching;
    assert.equal(clock.snapshot().groupId, id); assert.equal(calls, priorCalls);
    await assert.rejects(clock.startGroup(), /inactive/);
});
