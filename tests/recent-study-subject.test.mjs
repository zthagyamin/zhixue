import test from 'node:test';
import assert from 'node:assert/strict';
import {recentStudySubject} from '../src/features/planning/recent-study-subject.ts';

const item={itemKey:'one',contentHash:'hash-1',subjectId:'math'};
const attempt={eventType:'practice-attempt',occurredAt:'2026-10-28T01:00:00Z',itemKey:'one',contentHash:'hash-1',verified:true};
test('recent subject uses verified attempts with a unique current item and never a baseline',()=>{
  assert.deepEqual(recentStudySubject({historyVerified:false,records:[attempt],items:[item]}),{kind:'checking'});
  assert.deepEqual(recentStudySubject({historyVerified:true,records:[{...attempt,eventType:'review-baseline'}],items:[item]}),{kind:'none'});
  assert.deepEqual(recentStudySubject({historyVerified:true,records:[attempt],items:[item]}),{kind:'available',subjectId:'math'});
});
test('the newest missing, changed, unverified or ambiguous record cannot silently select an older subject',()=>{
  const base={historyVerified:true,records:[attempt],items:[item]};
  const newer={...attempt,occurredAt:'2026-10-28T02:00:00Z',itemKey:'missing'};
  assert.deepEqual(recentStudySubject({...base,records:[attempt,newer]}),{kind:'unavailable'});
  assert.deepEqual(recentStudySubject({...base,records:[attempt,{...newer,itemKey:'one',contentHash:'other'}]}),{kind:'unavailable'});
  assert.deepEqual(recentStudySubject({...base,records:[attempt,{...attempt,verified:false}]}),{kind:'unavailable'});
  assert.deepEqual(recentStudySubject({...base,items:[item,{...item,subjectId:'other'}]}),{kind:'unavailable'});
  assert.deepEqual(recentStudySubject({...base,records:[attempt,{...newer,occurredAt:'invalid'}]}),{kind:'unavailable'});
});
