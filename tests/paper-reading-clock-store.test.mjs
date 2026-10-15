import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingClockStore} from '../app/paper-reading/clock.ts';
import {openStudyDb} from '../app/local-study-db.ts';
import {paperReadingClockKey, paperReadingGroupsKey, createPaperReadingGroupClock} from '../src/application/paper-reading-clock/index.ts';

const scope = {ownerId: 'account:u', libraryId: 'local:l', materialFingerprint: 'a'.repeat(64)};
const checkpoint = (value = {}) => ({schemaVersion: 1, scope, revision: 1, operationId: 'clock-op', elapsedMs: 12000, paused: true, ...value});
test('clock checkpoint waits for IDB commit, restores pause and isolates owner, library and material', async () => {
    globalThis.indexedDB = new IDBFactory(); const store = createPaperReadingClockStore(), value = checkpoint();
    assert.deepEqual(await store.save(scope, value, 0), value);
    assert.deepEqual(await createPaperReadingClockStore().read(scope), value);
    assert.equal(await store.read({...scope, ownerId: 'account:other'}), null);
    assert.equal(await store.read({...scope, libraryId: 'another'}), null);
    assert.equal(await store.read({...scope, materialFingerprint: 'b'.repeat(64)}), null);
    assert.deepEqual(await store.save(scope, value, 0), value);
});
test('two tabs cannot overwrite a clock revision or decrease elapsed time', async () => {
    globalThis.indexedDB = new IDBFactory(); const a = createPaperReadingClockStore(), b = createPaperReadingClockStore();
    await a.save(scope, checkpoint(), 0);
    const results = await Promise.allSettled([
        a.save(scope, checkpoint({revision: 2, operationId: 'a', elapsedMs: 15000}), 1),
        b.save(scope, checkpoint({revision: 2, operationId: 'b', elapsedMs: 18000}), 1),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const old = await a.read(scope);
    await assert.rejects(a.save(scope, checkpoint({revision: 3, operationId: 'backward', elapsedMs: 0}), 2), /conflict/);
    assert.deepEqual(await a.read(scope), old);
});
test('foreign and corrupt checkpoints cannot restore or overwrite old clock data', async () => {
    globalThis.indexedDB = new IDBFactory(); const store = createPaperReadingClockStore(); await store.save(scope, checkpoint(), 0);
    await assert.rejects(store.save({...scope, ownerId: 'other'}, checkpoint(), 0), /corrupt/);
    const database = await openStudyDb();
    const tx = database.transaction('workspace-records', 'readwrite'), objectStore = tx.objectStore('workspace-records');
    const read = objectStore.get(paperReadingClockKey(scope));
    read.onsuccess = () => {const row = read.result; row.value.elapsedMs = -1; objectStore.put(row);};
    await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);}); database.close();
    await assert.rejects(store.read(scope), /corrupt/);
    await assert.rejects(store.save(scope, checkpoint({revision: 2}), 1), /corrupt/);
});
test('missing or failing IDB is explicit and never returns a successful checkpoint', async () => {
    globalThis.indexedDB = undefined; const store = createPaperReadingClockStore();
    await assert.rejects(store.read(scope), /不可用/); await assert.rejects(store.save(scope, checkpoint(), 0), /不可用/);
    const failing = createPaperReadingClockStore({openDb: async () => {throw Error('quota');}});
    await assert.rejects(failing.save(scope, checkpoint(), 0), /quota/);
});

test('an aborted clock transaction preserves the last checkpoint and unrelated original answer', async () => {
    globalThis.indexedDB = new IDBFactory(); const store = createPaperReadingClockStore(); await store.save(scope, checkpoint(), 0);
    const original = {id: 'original-answer', workspaceId: scope.ownerId, kind: 'paper-reading:v1', value: {answer: 'First original answer', attempts: ['first'], source: scope}};
    const db = await openStudyDb(), tx = db.transaction('workspace-records', 'readwrite');
    tx.objectStore('workspace-records').put(original);
    await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);}); db.close();
    const failing = createPaperReadingClockStore({openDb: async () => {
        const database = await openStudyDb(), transaction = database.transaction.bind(database);
        database.transaction = (...args) => {
            const writer = transaction(...args);
            const objectStore = writer.objectStore.bind(writer);
            writer.objectStore = name => {
                const records = objectStore(name);
                records.put = () => {writer.abort(); throw Error('quota');};
                return records;
            };
            return writer;
        };
        return database;
    }});
    await assert.rejects(failing.save(scope, checkpoint({revision: 2, operationId: 'failed', elapsedMs: 18000}), 1), /quota/);
    assert.deepEqual(await store.read(scope), checkpoint());
    const reopened = await openStudyDb(), readTx = reopened.transaction('workspace-records', 'readonly');
    const read = readTx.objectStore('workspace-records').get(original.id);
    const value = await new Promise((resolve, reject) => {readTx.oncomplete = () => resolve(read.result); readTx.onabort = () => reject(readTx.error);}); reopened.close();
    assert.deepEqual(value, original);
});

test('group IDB sidecar restores independently and never dual-writes the old material checkpoint', async () => {
    globalThis.indexedDB = new IDBFactory(); const store = createPaperReadingClockStore(), legacy = checkpoint({elapsedMs: 1800000});
    await store.save(scope, legacy, 0); let time = 0, id = 0;
    const make = () => createPaperReadingGroupClock({scope, store, now: () => time, makeId: () => `group-${++id}`});
    const clock = make(); await clock.load(); clock.setVisible(true); clock.setActive(true);
    assert.equal(clock.snapshot().elapsedMs, 0); assert.equal(clock.snapshot().materialElapsedMs, 1800000);
    assert.equal(clock.snapshot().paused, true); await clock.pause(false); time += 5000; await clock.startGroup();
    const first = structuredClone((await store.readGroups(scope)).groups[0]); time += 2000; await clock.pause(true); clock.dispose(); time += 90000;
    const restored = make(); await restored.load(); assert.equal(restored.snapshot().elapsedMs, 2000);
    assert.equal(restored.snapshot().paused, true); assert.equal(restored.snapshot().materialElapsedMs, 1807000);
    assert.deepEqual((await store.readGroups(scope)).groups[0], first); assert.deepEqual(await store.read(scope), legacy);
    assert.equal(await store.readGroups({...scope, ownerId: 'other'}), null);
    assert.equal(await store.readGroups({...scope, libraryId: 'other'}), null);
    assert.equal(await store.readGroups({...scope, materialFingerprint: 'b'.repeat(64)}), null);
});

test('group sidecar rejects competing revisions and deletion or alteration of completed history', async () => {
    globalThis.indexedDB = new IDBFactory(); const a = createPaperReadingClockStore(), b = createPaperReadingClockStore(); let id = 0;
    const clock = createPaperReadingGroupClock({scope, store: a, now: () => 0, makeId: () => `group-${++id}`});
    await clock.load(); await clock.startGroup(); const prior = await a.readGroups(scope);
    const next = operationId => ({...structuredClone(prior), revision: prior.revision + 1, operationId});
    const competed = await Promise.allSettled([a.saveGroups(scope, next('one'), prior.revision), b.saveGroups(scope, next('two'), prior.revision)]);
    assert.equal(competed.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(competed.filter(value => value.status === 'rejected').length, 1);
    const latest = await a.readGroups(scope), tampered = {...structuredClone(latest), revision: latest.revision + 1, operationId: 'tamper'};
    tampered.groups[0].elapsedMs = 1;
    await assert.rejects(a.saveGroups(scope, tampered, latest.revision), /history-conflict/);
    const removed = {...structuredClone(latest), revision: latest.revision + 1, operationId: 'removed', groups: latest.groups.slice(1)};
    await assert.rejects(a.saveGroups(scope, removed, latest.revision), /history-conflict/);
    assert.deepEqual(await a.readGroups(scope), latest);
});

test('corrupt or unavailable group storage cannot be replaced by a freshly reset group', async () => {
    globalThis.indexedDB = new IDBFactory(); const store = createPaperReadingClockStore(); let id = 0;
    const clock = createPaperReadingGroupClock({scope, store, now: () => 0, makeId: () => `group-${++id}`}); await clock.load();
    const database = await openStudyDb(), tx = database.transaction('workspace-records', 'readwrite');
    const objectStore = tx.objectStore('workspace-records'), request = objectStore.get(paperReadingGroupsKey(scope));
    request.onsuccess = () => {const row = request.result; row.value.groups[0].elapsedMs = -1; objectStore.put(row);};
    await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);}); database.close();
    const restored = createPaperReadingGroupClock({scope, store, now: () => 0, makeId: () => `group-${++id}`});
    await assert.rejects(restored.load(), /corrupt/); await assert.rejects(restored.startGroup(), /not-ready/);
    await assert.rejects(store.readGroups(scope), /corrupt/);
    globalThis.indexedDB = undefined; await assert.rejects(createPaperReadingClockStore().readGroups(scope), /不可用/);
});
