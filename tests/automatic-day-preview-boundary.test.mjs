import assert from 'node:assert/strict';
import test from 'node:test';
import {startAutomaticDayPreview} from './fixtures/automatic-day-preview.mjs';

for (const [instant, expected] of [
  ['2026-10-09T00:30:00+08:00', '2026-10-08'],
  ['2026-10-09T03:59:59+08:00', '2026-10-08'],
  ['2026-10-09T04:00:00+08:00', '2026-10-09'],
  ['2026-10-09T23:59:59+08:00', '2026-10-09'],
]) {
  test(`automatic preview seeds the actual study day at ${instant}`, async context => {
    context.mock.method(Date, 'now', () => Date.parse(instant));
    const preview = await startAutomaticDayPreview({port: 0, scenario: 'enabled', now: instant});
    try {
      assert.equal(preview.day, expected);
      assert.equal((await preview.state()).day, expected);
      const goals = await preview.goals();
      assert.equal(goals.snapshot.spec.startDate < expected, true);
      assert.equal(goals.snapshot.spec.targetDeadline > expected, true);
      assert.equal(preview.inspect().records, 0);
      assert.deepEqual(preview.inspect().aiRequests, []);
      assert.deepEqual(preview.mutations, []);
    } finally {
      await preview.close();
    }
  });
}