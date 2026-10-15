import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReadingRecovery} from '../src/application/paper-reading-recovery/index.ts';
const scope = {ownerId: 'account:u', libraryId: 'local:l'};
test('portable recovery rejects a corrupt artifact before a restore port can commit', async () => {
    let commits = 0;
    const recovery = createPaperReadingRecovery({scope, port: {snapshot: async () => [], inspect: async () => ({added: 0, duplicates: 0, conflicts: []}),
        commit: async () => {commits++; return {added: 0, duplicates: 0, durable: true};}},
        codec: {parseMaterial: value => value, fingerprint: async () => 'a'.repeat(64)}, hash: async () => 'b'.repeat(64)});
    const bad = {schemaVersion: 1, documentType: 'paper-reading-recovery', scope, complete: true,
        originalPdf: 'excluded', feedbackProvenance: 'restored-reading-evidence', records: [], hash: 'a'.repeat(64)};
    await assert.rejects(recovery.preview(bad), /hash/);
    await assert.rejects(recovery.restore(bad, bad.hash), /hash/);
    assert.equal(commits, 0);
});
