import type {AccountStudyLoaded} from './account-study-client';
import type {SubmissionJournal} from './study-submission-journal';
// @ts-expect-error TS5097: standalone Node contracts.
import {readAccountLocalPractice} from './study-submission-history.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {listLocalStudyRecords} from './local-account-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyId,studyCount} from './account-study-content.ts';

/** Called immediately before shared plan mutations, not just during rendering.
 * A local ACK beyond this page's remote fence still needs read-back. Auxiliary
 * receipts are deliberately irrelevant to the original learning evidence. */
export async function assertAccountPlanEvidence(workspaceId:string,loaded:Pick<AccountStudyLoaded,'bundle'|'records'|'eventThrough'|'taskThrough'>,journal:Pick<SubmissionJournal,'list'>):Promise<void>{
  studyId(workspaceId,'workspace');if(!workspaceId.startsWith('account:'))throw new Error('account-plan-owner-required');
  const libraryId=loaded.bundle.snapshot.libraryId;studyCount(loaded.eventThrough,'event-through');
  let previous=0;const remote=new Map<string,string>();
  for(const {sequence,record} of loaded.records){if(sequence<=previous||sequence>loaded.eventThrough||record.libraryId!==libraryId)throw new Error('账号学习历史尚未完整核对。');previous=sequence;remote.set(record.event.eventId,record.envelopeHash);}
  if(previous!==loaded.eventThrough||loaded.taskThrough!==loaded.eventThrough)throw new Error('账号学习历史尚未完整核对。');
  const [practice,original]=await Promise.all([readAccountLocalPractice(workspaceId,libraryId,journal),listLocalStudyRecords(workspaceId,libraryId)]);
  for(const record of [...practice.records,...original.map(row=>row.record)])if(remote.get(record.event.eventId)!==record.envelopeHash)throw new Error('本机作答尚未完整进入当前账号视图。请先同步作答并刷新，再调整、生成或批准计划；已保存作答无需重做。');
}
