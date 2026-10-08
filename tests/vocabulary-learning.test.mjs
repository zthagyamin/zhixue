import assert from 'node:assert/strict';
import test from 'node:test';
import {word,attempt,baseline,DAY} from './fixtures/task-event-fixtures.mjs';

let api;
try {api=await import('../app/vocabulary-learning.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
async function project(events=[],words=[word()],history={complete:true,legacyItemKeys:[]}) {
  assert.equal(typeof api?.projectVocabulary,'function','First-learning projector must exist');
  return api.projectVocabulary(words,events,history);
}
test('new vocabulary stays unseen until actual evidence arrives',async()=>{
  assert.equal((await project())[0].status,'unseen');
});
test('first-start and first-completion retain the actual physical source key',async()=>{
  const source=word({itemKey:'word:second:tree',subjectId:'second'});
  const first=await attempt('physical-first','2026-08-31T00:00:00Z',0,1,true,{item:{kind:'word',key:source.itemKey}});
  const done=await attempt('physical-done','2026-08-31T00:01:00Z',1,3,true,{item:{kind:'word',key:source.itemKey}});
  const states=await project([first,done],[word(),source]);
  assert.equal(states[0].firstStartedItemKey,source.itemKey);
  assert.equal(states[0].firstLearnedItemKey,source.itemKey);
});
test('an initial failure is still initial learning even when it schedules FSRS',async()=>{
  const states=await project([await attempt('initial-error','2026-08-31T00:00:00Z',0,0,false)]);
  assert.equal(states[0].status,'initial-in-progress');
  assert.equal(api.countNewWords(DAY,states),0);
});
test('intermediate three-stage evidence does not fill the new-word goal',async()=>{
  const events=[await attempt('initial-one','2026-08-31T00:00:00Z',0,1),await attempt('initial-two','2026-08-31T00:01:00Z',1,2)];
  const states=await project(events);
  assert.equal(states[0].status,'initial-in-progress');
  assert.equal(api.countNewWords(DAY,states),0);
});
test('first completion counts once despite duplicate delivery and later reset',async()=>{
  const events=[await attempt('first-one','2026-08-31T00:00:00Z',0,1),await attempt('first-two','2026-08-31T00:01:00Z',1,2),await attempt('first-done','2026-08-31T00:02:00Z',2,3)];
  const states=await project([...events,events[2],await attempt('later-error','2026-08-31T01:00:00Z',3,0,false)]);
  assert.equal(states[0].status,'learned');
  assert.equal(states[0].firstLearnedAt,'2026-08-31T00:02:00.000Z');
  assert.equal(api.countNewWords(DAY,states),1);
});
test('baseline import time is never a first-learning date',async()=>{
  const states=await project([await baseline(),await attempt('after-import','2026-08-31T02:00:00Z',2,3)]);
  assert.equal(states[0].firstLearnedAt,undefined);
  assert.equal(api.countNewWords(DAY,states),0);
});
test('incomplete history and legacy-only stages never masquerade as new words',async()=>{
  assert.equal((await project([],undefined,{complete:false,legacyItemKeys:[]}))[0].status,'history-unknown');
  assert.equal((await project([],undefined,{complete:true,legacyItemKeys:['word:tree']}))[0].status,'history-unknown');
});
test('a trace beginning at an intermediate old stage cannot prove first-ever completion',async()=>{
  const states=await project([await attempt('missing-start','2026-08-31T00:00:00Z',2,3)]);
  assert.equal(api.countNewWords(DAY,states),0);
});
test('first completion after Shanghai midnight counts on the new day',async()=>{
  const events=[await attempt('midnight-one','2026-08-30T15:58:00Z',0,1),await attempt('midnight-two','2026-08-30T15:59:00Z',1,2),await attempt('midnight-done','2026-08-30T16:00:01Z',2,3)];
  const states=await project(events.reverse());
  assert.equal(api.countNewWords('2026-08-30',states),0);
  assert.equal(api.countNewWords(DAY,states),1);
});
test('same lexeme across registered sources contributes once without merging item identity',async()=>{
  const words=[word(),word({itemKey:'word:other:tree',subjectId:'other',word:'ＴＲＥＥ',completionRule:'graded-practice'})];
  const states=await project([await attempt('cross-source','2026-08-31T00:00:00Z',0,3)],words);
  assert.equal(states.length,1);
  assert.deepEqual(new Set(states[0].itemKeys),new Set(['word:tree','word:other:tree']));
  assert.equal(api.countNewWords(DAY,states),1);
});
test('only explicit legacy aliases participate in novelty classification',async()=>{
  const old=await attempt('legacy-word','2026-08-30T00:00:00Z',0,3);
  const scoped=word({itemKey:'word:scoped:tree',completionRule:'graded-practice'});
  assert.equal((await project([old],[scoped]))[0].status,'unseen');
  assert.equal((await project([old],[{...scoped,legacyKeys:['word:tree']}]))[0].status,'learned');
});
test('unknown language never produces a confident new-word identity',async()=>{
  assert.equal((await project([],[word({language:''})]))[0].status,'history-unknown');
});
test('invalid event hashes stop projection rather than silently losing evidence',async()=>{
  assert.ok(api,'First-learning projector must exist');
  const event=await attempt('tampered-word','2026-08-31T00:00:00Z',0,3);
  await assert.rejects(project([{...event,coreHash:'0'.repeat(64)}]));
});
test('equal timestamps use the same code-point identity order as canonical replay',async()=>{
  assert.ok(api);
  const low=await attempt('event-a','2026-08-31T00:00:00Z',1,2);
  const high=await attempt('event-A','2026-08-31T00:00:00Z',0,1);
  assert.deepEqual((await api.uniqueStudyEvents([low,high])).map(event=>event.eventId),['event-A','event-a']);
});
test('a second source history gap is not hidden by another source beginning at zero',async()=>{
  const words=[word({itemKey:'word:a:tree'}),word({itemKey:'word:b:tree',subjectId:'other'})];
  const first=await attempt('source-a-start','2026-08-31T00:00:00Z',0,1,true,{item:{kind:'word',key:'word:a:tree'}});
  const missing=await attempt('source-b-gap','2026-08-31T00:01:00Z',2,3,true,{item:{kind:'word',key:'word:b:tree'}});
  const states=await project([first,missing],words);
  assert.equal(api.countNewWords(DAY,states),0);
  assert.equal(states[0].firstLearnedAt,undefined);
});
