import type {StudyRecordEnvelope,StudyItemVersion} from '../src/domain/sync';
export type {RoundRecordBody,LegacyRecordBody,TaskRecordBody,StudyRecordBody,StudyRecordEnvelope} from '../src/domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
export {sealStudyRecord,parseStudyRecord,compareStudyRecord} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {compareStudyRecord} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyCompatibleModes} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {courseTaskReadiness} from '../src/domain/content/index.ts';
type PracticeRecord=Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>;
const MAX_ANCESTORS=10000;
function checkItem(record:PracticeRecord,item:StudyItemVersion):void {
  if(item.learningSupport?.schemaVersion===2&&'task' in item.learningSupport){const issues=courseTaskReadiness(item.learningSupport.task,item.kind==='practice'?item.practice.prompt:'',item.kind==='word');if(issues.length)throw Error(issues[0]);}
  if (record.contentHash!==item.contentHash||record.event.item.key!==item.itemKey||record.event.item.kind!==item.eventKind) {
    throw new Error('study-record-item-binding');
  }
  const {correct,stageBefore,stageAfter}=record.event.attempt;
  const rating=record.event.attempt.rating;
  if((!correct&&(rating==='good'||rating==='easy'))||(correct&&rating==='again')) throw new Error('inconsistent-study-rating');
  if (record.provenanceMode==='legacy-continuation'&&(item.kind!=='word'||record.practiceMode!=='three-stage')) throw new Error('invalid-legacy-content');
  if(!studyCompatibleModes(item).includes(record.practiceMode)) throw new Error('invalid-study-practice-mode');
  if (record.practiceMode==='three-stage') {
    if (stageBefore>=3||stageAfter!==(correct?stageBefore+1:0)) throw new Error('invalid-word-stage-transition');
  } else if (stageAfter!==(correct?3:0)) throw new Error('invalid-practice-stage-transition');
  const scheduled=record.practiceMode!=='three-stage'||!correct||stageAfter===3;
  if (Boolean(record.event.scheduling)!==scheduled) throw new Error('invalid-study-scheduling');
  if (record.event.scheduling&&record.event.scheduling.reviewedAt!==record.event.occurredAt) throw new Error('invalid-study-scheduling-time');
}
function checkParent(child:PracticeRecord,parent:StudyRecordEnvelope):asserts parent is PracticeRecord {
  if (parent.provenanceMode==='task'||parent.provenanceMode!==child.provenanceMode
    ||parent.libraryId!==child.libraryId||parent.snapshotId!==child.snapshotId||parent.contentHash!==child.contentHash
    ||parent.originDeviceId!==child.originDeviceId||parent.practiceMode!==child.practiceMode||parent.event.item.key!==child.event.item.key
    ||parent.event.item.kind!==child.event.item.kind) throw new Error('study-record-parent-binding');
  if (child.provenanceMode==='verified-round') {
    if (parent.provenanceMode!=='verified-round'||parent.roundId!==child.roundId) throw new Error('study-record-parent-binding');
  } else if (parent.provenanceMode!=='legacy-continuation'||parent.resumeId!==child.resumeId
    ||parent.resumeStateHash!==child.resumeStateHash||parent.legacyStage!==child.legacyStage
    ||parent.legacyAnchorEventId!==child.legacyAnchorEventId) throw new Error('study-record-parent-binding');
  if (parent.event.occurredAt>child.event.occurredAt) throw new Error('study-record-parent-time');
  if (parent.attemptId===child.attemptId) throw new Error('duplicate-study-attempt');
  if (parent.event.attempt.stageAfter===3 || (parent.provenanceMode==='legacy-continuation'&&!parent.event.attempt.correct)) {
    throw new Error('terminal-study-round');
  }
  if (parent.event.attempt.stageAfter!==child.event.attempt.stageBefore) throw new Error('study-record-parent-stage');
}
/** Validates full supplied ancestry, not merely the immediately preceding stage.
 * The caller must separately verify manifest membership and task-plan bindings. */
export function checkStudyRecordBinding(record:StudyRecordEnvelope,item:StudyItemVersion,
  parent?:StudyRecordEnvelope|readonly StudyRecordEnvelope[]):'ready'|'pending-parent' {
  if (record.provenanceMode==='task') throw new Error('task-plan-binding-required');
  const ancestors:readonly StudyRecordEnvelope[]=parent===undefined?[]:Array.isArray(parent)?parent:[parent as StudyRecordEnvelope];
  if (ancestors.length>MAX_ANCESTORS) throw new Error('study-ancestry-too-large');
  const byId=new Map<string,StudyRecordEnvelope>();
  for (const entry of [record,...ancestors]) {
    const old=byId.get(entry.event.eventId);
    if (old&&compareStudyRecord(old,entry)!=='duplicate') throw new Error('study-parent-conflict');
    byId.set(entry.event.eventId,entry);
  }
  // Reject unresolved siblings as a set before any member drives a projection.
  // The durable store must retain conflicting evidence separately and serialize
  // acceptance; it must not apply one branch and later silently apply another.
  const children=new Map<string|null,string>(),attempts=new Set<string>();
  for (const entry of byId.values()) {
    if (entry.provenanceMode==='task'||entry.libraryId!==record.libraryId||entry.originDeviceId!==record.originDeviceId) continue;
    const sameRound=record.provenanceMode==='verified-round'
      ? entry.provenanceMode==='verified-round'&&entry.roundId===record.roundId
      : entry.provenanceMode==='legacy-continuation'&&entry.resumeId===record.resumeId;
    if (!sameRound) continue;
    if (entry.snapshotId!==record.snapshotId||entry.contentHash!==record.contentHash||entry.practiceMode!==record.practiceMode) throw new Error('study-record-round-binding');
    const sibling=children.get(entry.parentEventId);
    if (sibling!==undefined&&sibling!==entry.event.eventId) throw new Error('study-round-fork');
    children.set(entry.parentEventId,entry.event.eventId);
    if (attempts.has(entry.attemptId)) throw new Error('duplicate-study-attempt');
    attempts.add(entry.attemptId);
  }
  const seen=new Set<string>();let current:PracticeRecord=record;
  while (true) {
    if (seen.has(current.event.eventId)) throw new Error('study-parent-cycle');
    seen.add(current.event.eventId);checkItem(current,item);
    if (current.parentEventId===null) {
      if (current.practiceMode==='three-stage') {
        const start=current.provenanceMode==='legacy-continuation'?current.legacyStage:0;
        if (current.event.attempt.stageBefore!==start) throw new Error('invalid-study-start-stage');
      }
      return 'ready';
    }
    const prior=byId.get(current.parentEventId);
    if (!prior) return 'pending-parent';
    checkParent(current,prior);current=prior;
  }
}
