import assert from 'node:assert/strict';
import test from 'node:test';
import {nativePreviewRead} from './fixtures/native-preview-read.mjs';
test('the isolated native preview exposes the new bounded protocol without reaching an external account',async()=>{
  const events=new Map(Array.from({length:25},(_,i)=>[`event-${i}`,{eventId:`event-${i}`}])) ,read=nativePreviewRead(events,'synthetic-owner');
  const first=await read(new Request('http://127.0.0.1:3014/api/sync/study-events-v3?expectedUserId=synthetic-owner&limit=100'));
  const body=await first.json();assert.equal(body.protocol,'zhixue-native-history-v1');assert.equal(body.events.length,20);assert.equal(body.through,25);
  assert.equal((await read(new Request('http://127.0.0.1:3014/api/sync/study-events-v3?expectedUserId=someone-else'))).status,409);
});
