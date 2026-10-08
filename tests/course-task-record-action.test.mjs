import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRecordAction } from '../src/application/account-study/record-actions.ts';
import { sealStudyRecord } from '../app/account-study-record.ts';
import { recordBody } from './fixtures/account-study-fixtures.mjs';
import { attempt } from './fixtures/task-event-fixtures.mjs';

for (const code of ['course-task-word', 'course-task-unreviewed', 'course-task-prompt-mismatch', 'course-task-missing-conditions', 'unfocused-recall-question']) {
  test(`record batch retains acknowledgments around blocked course source: ${code}`, async () => {
    const records = await Promise.all(['first', 'blocked', 'last'].map(async (name, index) => sealStudyRecord(await recordBody({ attemptId: `attempt-${name}`, event: await attempt(`event-${name}`, `2026-10-06T00:0${index}:00Z`, 0, 1) }))));
    const stored = [];
    const reply = await executeRecordAction({ action: 'append-records', records }, { principal: { kind: 'browser' } }, {
      deps: { getStudyStore: async () => ({ appendRecord: async (_, record) => {
        if (record.event.eventId === 'event-blocked') throw Error(code);
        stored.push(record.event.eventId);
        return { status: 'applied', durable: true, sequence: stored.length };
      } }) }, scope: async () => ({ ownerId: 'owner-a', libraryId: 'library-a' }), requireRole: () => {},
    });
    assert.deepEqual(stored, ['event-first', 'event-last']);
    assert.equal(reply.value.results[0].receipt.eventId, 'event-first');
    assert.equal(reply.value.results[2].receipt.eventId, 'event-last');
    assert.deepEqual(reply.value.results[1], { eventId: 'event-blocked', status: 'blocked', durable: false, error: code, retryable: false });
  });
}
