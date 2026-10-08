import test from 'node:test';
import assert from 'node:assert/strict';
import {deferred, tick, waitForObservation} from './helpers/causal-harness.mjs';

test('causal readiness stays pending until the actual completion signal', async () => {
    const gate = deferred();
    let ready = false, returned = false, pumped = false;
    const pending = waitForObservation(async () => { pumped = true; await tick(); }, () => ready)
        .then(() => { returned = true; });
    await tick();
    assert.equal(pumped, true);
    assert.equal(returned, false);
    gate.promise.then(() => { ready = true; });
    gate.resolve();
    await pending;
    assert.equal(returned, true);
});

test('missing observation fails even when a lesson test freezes Date.now', async () => {
    const original = Date.now;
    Date.now = () => 10000;
    try {
        await assert.rejects(waitForObservation(tick, () => false,
            {timeoutMs: 10, label: 'synthetic missing readiness'}), /synthetic missing readiness/);
    } finally { Date.now = original; }
});
