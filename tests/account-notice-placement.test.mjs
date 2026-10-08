import assert from 'node:assert/strict';
import test from 'node:test';
import * as sources from '../src/domain/sources/index.ts';

test('ordinary background reads keep their status with source details while material remains visible',()=>{
  for(const phase of ['loading','cached','ready'])assert.equal(sources.accountReadNoticePlacement({phase},true),'details',phase);
});
test('initial loading still explains the absence of personal material above the page',()=>{
  for(const phase of ['loading','cached'])assert.equal(sources.accountReadNoticePlacement({phase},false),'above',phase);
});
test('failed, changed, cleared and missing library notices remain prominent even with old material',()=>{
  for(const phase of ['failed','library-changed','cleared','not-connected','identity-changed'])assert.equal(sources.accountReadNoticePlacement({phase},true),'above',phase);
});
test('a deferred source always remains a prominent notice instead of silently replacing an active round',()=>{
  for(const phase of ['loading','cached','ready'])assert.equal(sources.accountReadNoticePlacement({phase,deferred:true},true),'above',phase);
});
