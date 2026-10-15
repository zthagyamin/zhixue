import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {createPaperReadingRecoveryService} from '../app/paper-reading/recovery.ts';
import {openStudyDb} from '../app/local-study-db.ts';
import {parsePaperStudyData, emptyPaperDraft} from '../app/paper-study.ts';
import {savePaperMaterial, paperFingerprint, loadPaperMaterials} from '../app/paper-draft-store.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {createPaperReadingClockStore} from '../app/paper-reading/clock.ts';
import {createPaperReadingGroupClock} from '../src/application/paper-reading-clock/index.ts';
import {createPreparedPaperTaskService} from '../src/application/paper-reading/index.ts';
import {createPreparedPaperTaskIndexedDbStore} from '../src/infrastructure/paper-reading/index.ts';
import {paperReadingTask} from '../src/domain/paper-reading/index.ts';
import {canonicalAttemptJson} from '../src/domain/learning-attempt/index.ts';

const scope = {ownerId: 'account:u', libraryId: 'local:l'};
const hash = text => createHash('sha256').update(text).digest('hex');
function reset() {globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;}
async function put(row) {
    const db = await openStudyDb(), tx = db.transaction('workspace-records', 'readwrite'); tx.objectStore('workspace-records').put(row);
    await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);}); db.close();
}
async function all() {
    const db = await openStudyDb(), tx = db.transaction('workspace-records', 'readonly'), get = tx.objectStore('workspace-records').getAll();
    const values = await new Promise((resolve, reject) => {tx.oncomplete = () => resolve(get.result); tx.onabort = () => reject(tx.error);}); db.close(); return values;
}
async function fixture() {
    reset();
    const paper = parsePaperStudyData({paperId: 'paper', title: 'A controlled paper', origin: {kind: 'upload', version: 'b'.repeat(64), filename: 'controlled.pdf'},
        sections: [{id: 's', title: 'Mechanism', paragraphs: [{id: 'p', rawEn: 'Attention mixes values using learned weights.', pageNumber: 1}]}]});
    await savePaperMaterial(scope.ownerId, scope.libraryId, paper); const fingerprint = await paperFingerprint(paper);
    const source = {...scope, materialFingerprint: fingerprint, sourceVersion: paper.origin.version, sectionId: 's', paragraphs: [{id: 'p', rawEn: paper.sections[0].paragraphs[0].rawEn, pageNumber: 1}]};
    const unit = {schemaVersion: 1, unitId: 'unit', title: paper.title, goal: 'Explain the mechanism', source};
    const reading = createPaperReadingStore();
    await reading.mutate(scope, {schemaVersion: 1, operationId: 'register', unitId: 'unit', expectedRevision: 0, kind: 'register', unit});
    const task = paperReadingTask({taskId: 'task', revision: 1, source, goal: unit.goal, origin: 'ai', ability: 'mechanism',
        question: 'How does attention mix values?', reference: [{point: 'Uses learned weights.', paragraphId: 'p', quote: 'using learned weights'}]});
    await reading.writeService(scope, {schemaVersion: 1, operationId: 'task', unitId: 'unit', expectedRevision: 1, kind: 'task', task});
    await reading.mutate(scope, {schemaVersion: 1, operationId: 'answer', unitId: 'unit', expectedRevision: 2, kind: 'submit', answer: 'It uses learned weights.',
        referenceSeen: false, submittedAt: '2026-10-08T09:00:00Z'});
    await reading.writeService(scope, {schemaVersion: 1, operationId: 'feedback', unitId: 'unit', expectedRevision: 3, kind: 'feedback', attemptId: 'task:first',
        answerRevision: 1, taskRevision: 1, evaluation: {status: 'resolved', outcome: 'correct', matched: ['Uses learned weights.'], issues: [], explanation: 'Matches the supplied source.'}});
    const prepared = createPreparedPaperTaskService(createPreparedPaperTaskIndexedDbStore(openStudyDb), async text => hash(text));
    const packet = {schemaVersion: 1, documentType: 'paper-reading-prepared-question', materialFingerprint: fingerprint, sourceVersion: source.sourceVersion,
        sectionId: 's', paragraphIds: ['p'], question: 'How are values mixed?', ability: 'mechanism', reference: task.reference};
    await prepared.save(scope, unit, packet); await prepared.save(scope, unit, {...packet, question: 'Which weights mix the values?'});
    const clocks = createPaperReadingClockStore(), clockScope = {...scope, materialFingerprint: fingerprint};
    await clocks.save(clockScope, {schemaVersion: 1, scope: clockScope, revision: 1, operationId: 'clock-old', elapsedMs: 20000, paused: true}, 0);
    let time = 0, id = 0; const group = createPaperReadingGroupClock({scope: clockScope, store: clocks, now: () => time, makeId: () => `group-${++id}`});
    await group.load(); group.setActive(true); group.setVisible(true); await group.pause(false); time = 5000; await group.startGroup(); time = 7000; await group.pause(true); group.dispose();
    const kind = 'paper-draft:' + JSON.stringify([scope.libraryId, fingerprint]);
    await put({id: scope.ownerId + ':' + kind, workspaceId: scope.ownerId, kind, value: {paper, draft: {...emptyPaperDraft(), summaries: {p: 'My old summary.'}}}});
    await savePaperMaterial('other-owner', scope.libraryId, {...paper, title: 'OTHER OWNER PRIVATE'});
    await savePaperMaterial(scope.ownerId, 'other-library', {...paper, title: 'OTHER LIBRARY PRIVATE'});
    await put({id: 'excluded-key', workspaceId: scope.ownerId, kind: 'account-study-secret', value: {apiKey: 'PRIVATE MODEL KEY'}});
    await put({id: 'excluded-pdf', workspaceId: scope.ownerId, kind: 'paper-original:v1:local', value: {bytes: new Uint8Array([37, 80, 68, 70]), marker: 'RAW PDF PRIVATE'}});
    return {paper, fingerprint, unit, reading, recovery: createPaperReadingRecoveryService(scope)};
}
async function reseal(artifact) {
    for (const record of artifact.records) {const {hash: old, ...body} = record; void old; record.hash = hash(canonicalAttemptJson(body));}
    const {hash: old, ...body} = artifact; void old; artifact.hash = hash(canonicalAttemptJson(body)); return artifact;
}

test('rehashed backups cannot turn a saved Notion receipt into an arbitrary protocol link',async()=>{
  for(const url of ['obsidian://new?name=Synthetic-note','https://synthetic.invalid/note','//www.notion.so/'+ 'a'.repeat(32),'https://www.notion.so/'+ 'a'.repeat(32)+'\n']){
    const f=await fixture(),artifact=await f.recovery.export();
    artifact.records.find(row=>row.type==='draft').value.draft.noteReceipt={requestId:'note-request',localLibraryId:scope.libraryId,status:'written',kind:'notion',url};
    await reseal(artifact);reset();const recovery=createPaperReadingRecoveryService(scope);
    await assert.rejects(recovery.preview(artifact),/note-receipt-location/);
    await assert.rejects(recovery.restore(artifact,artifact.hash),/note-receipt-location/);
    assert.equal((await all()).length,0);
  }
});

test('canonical saved Notion and Obsidian receipts retain complete drafts through backup restore',async()=>{
  for(const location of [{kind:'notion',url:'https://www.notion.so/'+ 'a'.repeat(32)},{kind:'obsidian',path:'notes/原阅读笔记.md',day:'2026-10-10'}]){
    const f=await fixture(),artifact=await f.recovery.export(),receipt={requestId:'note-request',localLibraryId:scope.libraryId,status:'written',...location};
    artifact.records.find(row=>row.type==='draft').value.draft.noteReceipt=receipt;
    await reseal(artifact);reset();const recovery=createPaperReadingRecoveryService(scope);
    const preview=await recovery.preview(artifact);await recovery.restore(artifact,preview.artifactHash);
    assert.deepEqual((await all()).find(row=>row.kind.startsWith('paper-draft:')).value.draft.noteReceipt,receipt);
    assert.match(JSON.stringify(await all()),/My old summary/);
  }
});
test('complete scoped backup includes all prepared history, original answers and clocks, excluding secrets, other scopes and PDF', async () => {
    const f = await fixture(), artifact = await f.recovery.export();
    assert.equal(artifact.complete, true); assert.equal(artifact.records.length, 6);
    assert.deepEqual(artifact.records.map(value => value.type).sort(), ['clock', 'draft', 'groups', 'materials', 'prepared', 'workspace']);
    assert.equal(artifact.records.find(value => value.type === 'prepared').value.recipes.length, 2);
    const serialized = JSON.stringify(artifact); assert.doesNotMatch(serialized, /PRIVATE|OTHER OWNER|OTHER LIBRARY|RAW PDF/);
    assert.match(serialized, /It uses learned weights/); assert.match(serialized, /My old summary/);
    const before = await all(), preview = await f.recovery.preview(serialized);
    assert.equal(preview.duplicates, 6); assert.equal(preview.added, 0); assert.equal(preview.canRestore, true);
    assert.equal(preview.originalPdf, 'excluded'); assert.deepEqual(await all(), before);
});
test('empty destination restores atomically and exact repeat is idempotent, with old feedback marked as restored evidence', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    const preview = await recovery.preview(artifact); assert.equal(preview.added, 6);
    const receipt = await recovery.restore(artifact, preview.artifactHash); assert.equal(receipt.durable, true); assert.equal(receipt.added, 6);
    const repeat = await recovery.restore(artifact, preview.artifactHash); assert.equal(repeat.duplicates, 6); assert.equal(repeat.added, 0);
    assert.equal(receipt.feedbackProvenance, 'restored-reading-evidence');
    const reading = await createPaperReadingStore().read(scope, 'unit'); assert.equal(reading.attempts[0].submission.answer, 'It uses learned weights.');
    assert.equal(reading.attempts[0].evaluation.status, 'resolved');
    assert.equal((await loadPaperMaterials(scope.ownerId, scope.libraryId))[0].fingerprint, f.fingerprint);
    assert.equal((await createPaperReadingClockStore().readGroups({...scope, materialFingerprint: f.fingerprint})).groups.length, 2);
});
test('cut files, artifact hashes, per-record hashes and mismatched scope are rejected before any target write', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    await assert.rejects(recovery.preview(JSON.stringify(artifact).slice(0, -10)), /json/);
    await assert.rejects(recovery.preview({...artifact, hash: '0'.repeat(64)}), /hash/);
    const corrupt = structuredClone(artifact); corrupt.records[0].hash = '0'.repeat(64);
    const {hash: old, ...body} = corrupt; void old; corrupt.hash = hash(canonicalAttemptJson(body));
    await assert.rejects(recovery.preview(corrupt), /record-hash/);
    await assert.rejects(createPaperReadingRecoveryService({...scope, ownerId: 'foreign'}).preview(artifact), /scope/);
    await assert.rejects(recovery.restore(artifact, '0'.repeat(64)), /preview-changed/); assert.equal((await all()).length, 0);
});
test('canonical recipe hashes for inactive history are checked even when artifact hashes are recomputed', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    const tampered = structuredClone(artifact), prepared = tampered.records.find(value => value.type === 'prepared');
    prepared.value.recipes[0].packet.question = 'A changed old question?'; await reseal(tampered);
    await assert.rejects(recovery.preview(tampered), /prepared-hash/); assert.equal((await all()).length, 0);
});
test('material fingerprint, source version and exact original paragraph prevent restored answers from attaching to changed sources', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    const material = structuredClone(artifact); material.records.find(value => value.type === 'materials').value[0].paper.sections[0].paragraphs[0].rawEn = 'Changed source.';
    await reseal(material); await assert.rejects(recovery.preview(material), /material-hash/);
    const source = structuredClone(artifact), workspace = source.records.find(value => value.type === 'workspace').value;
    workspace.unit.source.sourceVersion = 'c'.repeat(64); workspace.operations[0].unit.source.sourceVersion = 'c'.repeat(64);
    workspace.task.source.sourceVersion = 'c'.repeat(64); workspace.operations[1].task.source.sourceVersion = 'c'.repeat(64);
    workspace.attempts[0].task.source.sourceVersion = 'c'.repeat(64); await reseal(source);
    await assert.rejects(recovery.preview(source), /source-version/); assert.equal((await all()).length, 0);
    const content = structuredClone(artifact), stored = content.records.find(value => value.type === 'workspace').value;
    const changeSources = value => {
        if (!value || typeof value !== 'object') return;
        if (value.source?.paragraphs) value.source.paragraphs[0].rawEn = 'Attention mixes values using learned weights in a forged condition.';
        for (const entry of Object.values(value)) changeSources(entry);
    };
    changeSources(stored); await reseal(content);
    await assert.rejects(recovery.preview(content), /source-content/); assert.equal((await all()).length, 0);
});
test('existing different content and changes after preview cause whole-batch rejection without replacing either side', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    const preview = await recovery.preview(artifact); assert.equal(preview.canRestore, true);
    const existing = {...structuredClone(artifact.records.find(value => value.type === 'draft')), value: {paper: f.paper, draft: {...emptyPaperDraft(), summaries: {p: 'Keep target draft.'}}}};
    delete existing.type; delete existing.hash; await put(existing); const before = await all();
    const conflicted = await recovery.preview(artifact); assert.equal(conflicted.canRestore, false); assert.equal(conflicted.conflicts.length, 1);
    await assert.rejects(recovery.restore(artifact, preview.artifactHash), /conflict/);
    assert.deepEqual(await all(), before); assert.match(JSON.stringify(artifact), /My old summary/);
});
test('a real IDB abort after an earlier write rolls the entire restore back with no partial records', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); let writes = 0;
    const recovery = createPaperReadingRecoveryService(scope, {openDb: async () => {
        const db = await openStudyDb(), transaction = db.transaction.bind(db);
        db.transaction = (...args) => {
            const tx = transaction(...args); if (args[1] !== 'readwrite') return tx;
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = name => {
                const store = objectStore(name), put = store.put.bind(store);
                store.put = value => {if (++writes === 2) {tx.abort(); throw Error('quota-abort');} return put(value);}; return store;
            }; return tx;
        }; return db;
    }});
    await assert.rejects(recovery.restore(artifact, artifact.hash), /quota-abort/);
    assert.equal(writes, 2); assert.equal((await all()).length, 0);
});

test('rehashed artifacts cannot inject foreign records, credentials, formal scores or omit necessary original materials', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); const recovery = createPaperReadingRecoveryService(scope);
    const secret = structuredClone(artifact); secret.records.find(value => value.type === 'draft').value.draft.apiKey = 'forged-secret'; await reseal(secret);
    await assert.rejects(recovery.preview(secret), /credentials-not-allowed/);
    const foreign = structuredClone(artifact), clock = foreign.records.find(value => value.type === 'clock');
    clock.workspaceId = 'other-owner'; clock.id = 'paper-reading-clock:v1:' + JSON.stringify(['other-owner', scope.libraryId, f.fingerprint]);
    clock.value.scope.ownerId = 'other-owner'; await reseal(foreign); await assert.rejects(recovery.preview(foreign), /not-allowed|scope/);
    const formal = structuredClone(artifact), record = formal.records.find(value => value.type === 'workspace');
    record.id = scope.ownerId + ':progress'; record.workspaceId = scope.ownerId; record.kind = 'progress'; record.value = {score: 100}; await reseal(formal);
    await assert.rejects(recovery.preview(formal), /not-allowed/);
    const incomplete = structuredClone(artifact); incomplete.records = incomplete.records.filter(value => value.type !== 'materials' && value.type !== 'draft'); await reseal(incomplete);
    await assert.rejects(recovery.preview(incomplete), /required-material-missing/); assert.equal((await all()).length, 0);
});

test('export refuses missing material or over-limit scopes instead of returning a partial complete artifact', async () => {
    const f = await fixture();
    const db = await openStudyDb(), tx = db.transaction('workspace-records', 'readwrite');
    tx.objectStore('workspace-records').delete(scope.ownerId + ':paper-document:' + scope.libraryId);
    tx.objectStore('workspace-records').delete(scope.ownerId + ':paper-draft:' + JSON.stringify([scope.libraryId,f.fingerprint]));
    await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);}); db.close();
    await assert.rejects(f.recovery.export(), /required-material-missing/);
    reset(); const database = await openStudyDb(), writer = database.transaction('workspace-records', 'readwrite'), store = writer.objectStore('workspace-records');
    for (let index = 0; index < 2001; index++) {
        const kind = 'paper-reading:v1:' + JSON.stringify([scope.ownerId, scope.libraryId, `unit-${index}`]);
        store.put({id: 'paper-reading-workspaces:v1:' + kind, workspaceId: 'paper-reading-workspaces:v1', kind, value: {synthetic: index}});
    }
    await new Promise((resolve, reject) => {writer.oncomplete = resolve; writer.onabort = () => reject(writer.error);}); database.close();
    await assert.rejects(createPaperReadingRecoveryService(scope).export(), /limit/);
});

test('a changed current scope prevents preview and restore from touching the new owner database', async () => {
    const f = await fixture(), artifact = await f.recovery.export(); reset(); let current = true;
    const recovery = createPaperReadingRecoveryService(scope, {isCurrent: () => current});
    const preview = await recovery.preview(artifact); current = false;
    await assert.rejects(recovery.restore(artifact, preview.artifactHash), /inactive-scope/);
    await assert.rejects(recovery.export(), /inactive-scope/); assert.equal((await all()).length, 0);
});
