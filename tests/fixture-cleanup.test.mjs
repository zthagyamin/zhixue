import assert from 'node:assert/strict';
import test from 'node:test';
import {withFixtureCleanup} from './helpers/fixture-cleanup.mjs';

test('an installer assertion and cleanup failure are both retained in the test result',async()=>{
  const primary=new Error('synthetic installer assertion failure'),cleanup=new Error('synthetic cleanup failure');
  await assert.rejects(withFixtureCleanup(async()=>{throw primary;},async()=>{throw cleanup;}),error=>{
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors,[primary,cleanup]);return true;
  });
});
test('successful fixture and cleanup keep the original result',async()=>{
  let cleaned=false;assert.equal(await withFixtureCleanup(async()=>7,async()=>{cleaned=true;}),7);assert.equal(cleaned,true);
});
test('a standalone cleanup error is not hidden',async()=>{
  const error=new Error('synthetic cleanup-only failure');
  await assert.rejects(withFixtureCleanup(async()=>7,async()=>{throw error;}),value=>value===error);
});
