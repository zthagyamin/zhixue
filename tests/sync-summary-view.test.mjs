import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSummary} from '../src/features/sync/summary.ts';

const scope={workspaceId:'account:a',libraryId:'library:a'};
test('incomplete summary stays unknown and does not invent a check time',()=>{
  const view=syncSummary({...scope,pending:null});
  assert.match(view.queue,/待核对/);
  assert.match(view.checked,/尚未核对/);
  assert.deepEqual(view.recent,[]);
});
test('the supplied deduplicated total and check time remain distinct from a single receipt',()=>{
  const view=syncSummary({...scope,pending:{total:2,uploads:1,writebacks:2,assistance:0},checkedAt:'2026-10-27T06:00:00.000Z',receipts:{...scope,eventId:'a',cloud:'acked',companion:'received'}});
  assert.match(view.queue,/当前账号.*待处理.*2/);
  assert.match(view.checked,/核对/);
  assert.match(view.recent.join(' '),/账号.*已接收/);
  assert.match(view.recent.join(' '),/Companion.*已接收.*待核对/);
  assert.doesNotMatch(view.recent.join(' '),/学习库.*已写回/);
});
test('connection guidance treats offline and disabled as states, not lost answers',()=>{
  const view=syncSummary({...scope,pending:null,accountStatus:'not-enabled',companionStatus:'offline'});
  assert.match(view.guidance.join(' '),/账号.*未启用/);
  assert.match(view.guidance.join(' '),/Companion.*离线/);
  assert.doesNotMatch(view.guidance.join(' '),/丢失/);
});
test('only an applied receipt claims writeback; pending and conflict describe safe next steps',()=>{
  const applied=syncSummary({...scope,pending:{total:0,uploads:0,writebacks:0,assistance:0},receipts:{...scope,eventId:'a',companion:'applied'}});
  assert.match(applied.recent.join(' '),/学习库.*已写回/);
  const blocked=syncSummary({...scope,pending:null,receipts:{...scope,eventId:'b',cloud:'conflict',companion:'blocked'}});
  assert.match(blocked.recent.join(' '),/冲突/);
  assert.match(blocked.recent.join(' '),/待处理/);
  assert.doesNotMatch(blocked.recent.join(' '),/已写回/);
});
test('stale account or library receipts never describe the current learning space',()=>{
  for(const receipts of [{workspaceId:'account:b',libraryId:'library:a',eventId:'a',cloud:'acked'},{...scope,libraryId:'library:b',eventId:'a',companion:'applied'}]){
    assert.deepEqual(syncSummary({...scope,pending:null,receipts}).recent,[]);
  }
});
