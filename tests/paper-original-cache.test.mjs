import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {createHash} from 'node:crypto';
import {IDBFactory, IDBObjectStore, IDBTransaction, IDBDatabase} from 'fake-indexeddb';
import {createPaperOriginalCache} from '../app/paper-reading/original-cache.ts';
import {openStudyDb, loadWorkspaceRecord, updateWorkspaceRecord, saveWorkspaceRecord, exportRecoveryWorkspaceRecords} from '../app/local-study-db.ts';
import {createPaperOriginalCacheService} from '../src/application/paper-reading/index.ts';
import {createPaperOriginalCacheStore, createPaperOriginalIndexedDbPort, paperOriginalRecordKey, sha256PaperOriginal} from '../src/infrastructure/paper-reading/index.ts';
import {paperFromPages} from '../app/paper-import.ts';
import {paperFingerprint, openPaperDraft} from '../app/paper-draft-store.ts';

const bytes = new TextEncoder().encode('%PDF-1.7\ncontrolled original\n%%EOF');
const hash = value => createHash('sha256').update(value).digest('hex');
const scope = (overrides = {}) => ({ownerId: 'account:original-test', libraryId: 'library:one', sourceVersion: hash(bytes), ...overrides});
beforeEach(() => {globalThis.indexedDB = new IDBFactory();});

async function rows() {
  const db = await openStudyDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-records', 'readonly');
      const request = tx.objectStore('workspace-records').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {db.close();}
}
async function mutateOriginal(change) {
  const row = (await rows()).find(row => row.kind.startsWith('paper-original:v1:'));
  await updateWorkspaceRecord(row.workspaceId, row.kind, null, change);
}
async function mutateEnvelope(change) {
  const row = (await rows()).find(row => row.kind.startsWith('paper-original:v1:'));
  const db = await openStudyDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-records', 'readwrite');
      tx.objectStore('workspace-records').put(change(row));
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  } finally {db.close();}
}

test('original bytes persist through real IndexedDB transactions and reopen', async () => {
  await createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes});
  const loaded = await createPaperOriginalCache().read(scope());
  assert.equal(loaded.filename, 'paper.pdf');
  assert.deepEqual(loaded.bytes, bytes);
  const records = await rows();
  assert.equal(records.length, 1);
  assert.ok(records[0].kind.startsWith('paper-original:v1:'));
});

test('owner, library and upload version are separate immutable cache identities', async () => {
  const cache = createPaperOriginalCache();
  await cache.save(scope(), {filename: 'one.pdf', bytes});
  for (const other of [scope({ownerId: 'account:other'}), scope({libraryId: 'library:other'}), scope({sourceVersion: 'f'.repeat(64)})]) {
    assert.equal(await cache.read(other), null);
  }
  await cache.save(scope({ownerId: 'account:other'}), {filename: 'other.pdf', bytes});
  await cache.save(scope({libraryId: 'library:other'}), {filename: 'library.pdf', bytes});
  const nextBytes = new Uint8Array([...bytes, 10]);
  await cache.save(scope({sourceVersion: hash(nextBytes)}), {filename: 'version.pdf', bytes: nextBytes});
  assert.equal((await rows()).length, 4);
  assert.equal((await cache.read(scope())).filename, 'one.pdf');
});

test('invalid scope, wrong fingerprint and byte limits reject before persistence', async () => {
  const cache = createPaperOriginalCache();
  for (const invalid of [scope({ownerId: ''}), scope({libraryId: '  '}), scope({sourceVersion: 'A'.repeat(64)}), scope({sourceVersion: 'a'.repeat(63)})]) {
    await assert.rejects(cache.save(invalid, {filename: 'paper.pdf', bytes}), /scope|version/i);
    await assert.rejects(cache.read(invalid), /scope|version/i);
  }
  await assert.rejects(cache.save(scope({sourceVersion: 'a'.repeat(64)}), {filename: 'paper.pdf', bytes}), /fingerprint/i);
  await assert.rejects(cache.save(scope(), {filename: '', bytes}), /filename/i);
  await assert.rejects(cache.save(scope(), {filename: 'paper.pdf', bytes: new Uint8Array()}), /size/i);
  await assert.rejects(cache.save(scope(), {filename: 'paper.pdf', bytes: new Uint8Array(20_000_001)}), /size/i);
  assert.deepEqual(await rows(), []);
});

test('the existing inclusive 20,000,000 byte limit is retained', async () => {
  const large = new Uint8Array(20_000_000);
  const largeScope = scope({sourceVersion: hash(large)});
  const cache = createPaperOriginalCache();
  await cache.save(largeScope, {filename: 'limit.pdf', bytes: large});
  assert.equal((await cache.read(largeScope)).bytes.length, large.length);
});

test('save waits for transaction completion and rejects an aborted write', async () => {
  const originalPut = IDBObjectStore.prototype.put;
  const originalDispatch = IDBTransaction.prototype.dispatchEvent;
  let completed = false;
  IDBTransaction.prototype.dispatchEvent = function(event) {
    if (event.type === 'complete' && this.mode === 'readwrite') completed = true;
    return originalDispatch.call(this, event);
  };
  try {
    await createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes});
    assert.equal(completed, true);
    IDBObjectStore.prototype.put = function(value, ...args) {
      const request = originalPut.call(this, value, ...args);
      this.transaction.abort();
      return request;
    };
    // The existing DB adapter's request error bubbles before its abort event.
    await assert.rejects(createPaperOriginalCache().save(scope({libraryId: 'aborted'}), {filename: 'paper.pdf', bytes}), {message: '无法保存本地学习空间。'});
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    IDBTransaction.prototype.dispatchEvent = originalDispatch;
  }
  assert.equal((await rows()).length, 1);
});

test('QuotaExceeded and unavailable IndexedDB never claim a successful save', async () => {
  await saveWorkspaceRecord(scope().ownerId, 'paper-draft:keep', {answer: 'kept'});
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function() {throw new DOMException('full', 'QuotaExceededError');};
  try {await assert.rejects(createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes}), {name: 'QuotaExceededError'});}
  finally {IDBObjectStore.prototype.put = originalPut;}
  assert.deepEqual(await loadWorkspaceRecord(scope().ownerId, 'paper-draft:keep', null), {answer: 'kept'});
  const factory = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    await assert.rejects(createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes}), /不可用|unavailable/i);
    await assert.rejects(createPaperOriginalCache().read(scope()), /不可用|unavailable/i);
  } finally {globalThis.indexedDB = factory;}
  assert.equal((await rows()).length, 1);
});

test('scope and byte snapshots cannot be redirected by a late caller change', async () => {
  let unblock;
  const blocked = new Promise(resolve => {unblock = resolve;});
  const store = createPaperOriginalCacheStore({
    read: key => loadWorkspaceRecord('cache-test', key, null),
    update: (key, change) => updateWorkspaceRecord('cache-test', key, null, change),
  });
  const cache = createPaperOriginalCacheService({store, fingerprint: async value => {await blocked; return sha256PaperOriginal(value);}});
  const currentScope = scope();
  const currentBytes = bytes.slice();
  const saving = cache.save(currentScope, {filename: 'paper.pdf', bytes: currentBytes});
  currentScope.ownerId = 'account:late';
  currentScope.libraryId = 'late-library';
  currentBytes.fill(0);
  unblock();
  await saving;
  assert.deepEqual((await cache.read(scope())).bytes, bytes);
  assert.equal(await cache.read(currentScope), null);
});

test('corrupted bytes, scope, format and size reject without silently replacing originals', async () => {
  const mutations = [
    record => ({...record, bytes: new Uint8Array(record.bytes).fill(0)}),
    record => ({...record, scope: {...record.scope, ownerId: 'account:wrong'}}),
    record => ({...record, schemaVersion: 2}),
    record => ({...record, byteLength: record.byteLength + 1}),
  ];
  for (const change of mutations) {
    globalThis.indexedDB = new IDBFactory();
    const cache = createPaperOriginalCache();
    await cache.save(scope(), {filename: 'paper.pdf', bytes});
    await mutateOriginal(change);
    await assert.rejects(cache.read(scope()), /corrupt|scope|fingerprint|version|size/i);
    await assert.rejects(cache.save(scope(), {filename: 'replacement.pdf', bytes}), /corrupt|scope|immutable|version|size/i);
    assert.equal((await rows()).length, 1);
  }
});

test('duplicate saves and competing cache instances keep the first version identity', async () => {
  const cache = createPaperOriginalCache();
  await cache.save(scope(), {filename: 'first.pdf', bytes});
  await Promise.all([cache.save(scope(), {filename: 'second.pdf', bytes}), createPaperOriginalCache().save(scope(), {filename: 'third.pdf', bytes})]);
  assert.equal((await rows()).length, 1);
  assert.equal((await cache.read(scope())).filename, 'first.pdf');
  await assert.rejects(cache.save(scope(), {filename: 'different.pdf', bytes: new Uint8Array([...bytes, 10])}), /fingerprint/i);
  const read = await cache.read(scope());
  read.bytes.fill(0);
  assert.deepEqual((await cache.read(scope())).bytes, bytes);
});

test('retry after a lost receipt reuses the existing original record', async () => {
  let loseReceipt = true;
  const store = createPaperOriginalCacheStore({
    read: key => loadWorkspaceRecord('cache-test', key, null),
    update: async (key, change) => {
      await updateWorkspaceRecord('cache-test', key, null, change);
      if (loseReceipt) {loseReceipt = false; throw new Error('receipt-lost');}
    },
  });
  const cache = createPaperOriginalCacheService({store, fingerprint: sha256PaperOriginal});
  await assert.rejects(cache.save(scope(), {filename: 'first.pdf', bytes}), /receipt-lost/);
  await cache.save(scope(), {filename: 'retry.pdf', bytes});
  assert.equal((await rows()).length, 1);
  assert.equal((await cache.read(scope())).filename, 'first.pdf');
  assert.equal((await rows())[0].kind, paperOriginalRecordKey(scope()));
});

test('atomic storage rejects different bytes even when an injected fingerprint collides', async () => {
  const store = createPaperOriginalCacheStore({
    read: key => loadWorkspaceRecord('cache-test', key, null),
    update: (key, change) => updateWorkspaceRecord('cache-test', key, null, change),
  });
  // A controlled collision exercises the immutable-byte rule independently of SHA256.
  const cache = createPaperOriginalCacheService({store, fingerprint: async () => hash(bytes)});
  await cache.save(scope(), {filename: 'first.pdf', bytes});
  await assert.rejects(cache.save(scope(), {filename: 'collision.pdf', bytes: new Uint8Array(bytes).fill(0)}), /immutable-version-conflict/);
  assert.deepEqual((await cache.read(scope())).bytes, bytes);
  assert.equal((await rows()).length, 1);
});

test('null payload and tampered outer ownership are corrupt records rather than cache misses', async () => {
  for (const change of [row => ({...row, value: null}), row => ({...row, value: undefined}), row => ({...row, workspaceId: 'another-owner'}), row => ({...row, kind: 'paper-draft:unrelated'})]) {
    globalThis.indexedDB = new IDBFactory();
    const cache = createPaperOriginalCache();
    await cache.save(scope(), {filename: 'paper.pdf', bytes});
    await mutateEnvelope(change);
    await assert.rejects(cache.read(scope()), /corrupt|scope/i);
    await assert.rejects(cache.save(scope(), {filename: 'replace.pdf', bytes}), /corrupt|scope/i);
    assert.equal((await rows()).length, 1);
  }
});

test('the controlled KV port refuses unrelated record keys and closes all opened connections', async () => {
  const port = createPaperOriginalIndexedDbPort(openStudyDb);
  const originalClose = IDBDatabase.prototype.close;
  let closes = 0;
  IDBDatabase.prototype.close = function() {closes++; return originalClose.call(this);};
  try {
    await assert.rejects(port.read('cloud-outbox'), /invalid-key/);
    await assert.rejects(port.update('paper-draft:unrelated', () => null), /invalid-key/);
    assert.equal(closes, 0);
    const cache = createPaperOriginalCache();
    await cache.save(scope(), {filename: 'paper.pdf', bytes});
    assert.equal(closes, 1);
    await cache.read(scope());
    assert.equal(closes, 2);
    await cache.read(scope({ownerId: 'missing'}));
    assert.equal(closes, 3);
    await mutateEnvelope(row => ({...row, value: null}));
    closes = 0;
    await assert.rejects(cache.read(scope()), /corrupt/);
    assert.equal(closes, 1);
    await assert.rejects(cache.save(scope(), {filename: 'replace.pdf', bytes}), /corrupt/);
    assert.equal(closes, 2);
  } finally {IDBDatabase.prototype.close = originalClose;}
});

test('late read scope changes do not return bytes under the new owner identity', async () => {
  await createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes});
  let unblock;
  const wait = new Promise(resolve => {unblock = resolve;});
  const store = createPaperOriginalCacheStore({
    read: async key => {await wait; return loadWorkspaceRecord('paper-original-cache:v1', key, null);},
    update: (key, change) => updateWorkspaceRecord('paper-original-cache:v1', key, null, change),
  });
  const cache = createPaperOriginalCacheService({store, fingerprint: sha256PaperOriginal});
  const currentScope = scope();
  const reading = cache.read(currentScope);
  currentScope.ownerId = 'account:late-reader';
  unblock();
  assert.deepEqual((await reading).bytes, bytes);
  assert.equal(await cache.read(currentScope), null);
});

test('original caching leaves material fingerprint, draft JSON and recovery exports unchanged', async () => {
  const paper = paperFromPages('Paper', [{pageNumber: 1, text: 'The controlled original remains unchanged.'}], {kind: 'upload', filename: 'paper.pdf', version: hash(bytes)});
  const before = JSON.stringify(paper);
  const fingerprint = await paperFingerprint(paper);
  const draft = await openPaperDraft(scope().ownerId, scope().libraryId, paper);
  await draft.flush();
  await draft.update(current => ({...current, summaries: {'p-1': 'An existing answer'}}));
  await draft.flush();
  const draftRows = (await rows()).filter(row => row.kind.startsWith('paper-draft:'));
  await createPaperOriginalCache().save(scope(), {filename: 'paper.pdf', bytes});
  assert.equal(JSON.stringify(paper), before);
  assert.equal(await paperFingerprint(paper), fingerprint);
  assert.deepEqual((await rows()).filter(row => row.kind.startsWith('paper-draft:')), draftRows);
  assert.equal((await exportRecoveryWorkspaceRecords(scope().ownerId)).some(row => row.kind.startsWith('paper-original:')), false);
});
