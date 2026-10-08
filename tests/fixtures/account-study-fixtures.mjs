import {attempt} from './task-event-fixtures.mjs';

export const SOURCE_HASH='a'.repeat(64);
export function quizBody(overrides={}) {
  return {schemaVersion:1,kind:'practice',itemKey:'question-one',eventKind:'due',subjectId:'reading',title:'Reading check',
    sourceHash:SOURCE_HASH,completionRule:'graded-practice',practice:{itemId:'question-one',abilityId:'reading-main',domain:'course',
      questionType:'quiz',prompt:'Choose the stated result.',options:['First','Second'],answer:0,explanation:'The first result.',sourceLabel:'Reading'},...overrides};
}
export function wordBody(overrides={}) {
  return {schemaVersion:1,kind:'word',itemKey:'word:tree',eventKind:'word',subjectId:'vocab',title:'Tree',
    sourceHash:SOURCE_HASH,completionRule:'three-stage',recommendedPlugin:'three-stage',language:'en',word:{word:'Tree',phonetic:'/triː/',meaning:'树',
      context:'植物',example:'A tree grows here.',source:'词库',level:'A1',distractors:['草','花']},...overrides};
}
export function snapshotBody(items,overrides={}) {
  return {schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',revision:1,generatedAt:'2026-09-01T00:00:00.000Z',
    sourceHash:SOURCE_HASH,eventCursor:0,taskCursor:0,items:items.map(item=>({itemKey:item.itemKey,contentHash:item.contentHash})),...overrides};
}
export async function recordBody(overrides={}) {
  return {schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',contentHash:SOURCE_HASH,originDeviceId:'device-a',
    provenanceMode:'verified-round',practiceMode:'three-stage',roundId:'round-one',attemptId:'attempt-one',parentEventId:null,
    event:await attempt('event-one','2026-09-01T00:01:00Z',0,1),...overrides};
}
