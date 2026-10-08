import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {studyDay,countNewWords} from '../app/vocabulary-learning.ts';
import * as api from '../src/domain/planning/index.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/study-day-4am.json',import.meta.url),'utf8'));

test('study day uses the shared migration and exact four-am boundary',()=>{
 for(const [instant,day]of fixture.cases)assert.equal(studyDay(instant),day,instant);
});
test('transition day is 28 hours and later windows are four-to-four',()=>{
 assert.equal(typeof api.studyDayBounds,'function');
 const first=api.studyDayBounds('2026-09-22');assert.equal(new Date(first.start).toISOString(),'2026-09-21T16:00:00.000Z');assert.equal(new Date(first.end).toISOString(),'2026-09-22T20:00:00.000Z');assert.equal(first.end-first.start,28*3600000);
 const next=api.studyDayBounds('2026-09-23');assert.equal(next.start,first.end);assert.equal(next.end-next.start,86400000);
 assert.throws(()=>api.studyDayBounds('2026-02-30'));
});
test('first-learning completion before four counts toward the preceding study day only',()=>{
 const words=[{lexemeKey:'en:a',status:'learned',itemKeys:['a'],firstLearnedAt:'2026-09-22T19:59:59.999Z'},
 {lexemeKey:'en:b',status:'learned',itemKeys:['b'],firstLearnedAt:'2026-09-22T20:00:00.000Z'}];
 assert.equal(countNewWords('2026-09-22',words),1);assert.equal(countNewWords('2026-09-23',words),1);
});
test('recorded legacy day and new study day both read without rewriting declared history',()=>{
 assert.equal(typeof api.acceptsRecordedStudyDay,'function');
 assert.equal(api.acceptsRecordedStudyDay('2026-09-22T17:00:00.000Z','2026-09-23'),true);
 assert.equal(api.acceptsRecordedStudyDay('2026-09-22T17:00:00.000Z','2026-09-22'),true);
 assert.equal(api.acceptsRecordedStudyDay('2026-09-22T17:00:00.000Z','2026-09-21'),false);
});
test('date-only source review starts at four but genuine ISO due instant is unchanged',()=>{
 assert.equal(typeof api.sourceReviewDueAt,'function');
 assert.equal(api.sourceReviewDueAt('2026-09-23T00:00:00+08:00'),'2026-09-23T04:00:00+08:00');
 assert.equal(api.sourceReviewDueAt('2026-09-22T16:00:00.000Z'),'2026-09-22T16:00:00.000Z');
});
