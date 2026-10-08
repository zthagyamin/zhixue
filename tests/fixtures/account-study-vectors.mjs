// Synthetic protocol vectors. Never read the installed Companion or real Vault.
import {readFile} from 'node:fs/promises';
import {wordBody,quizBody,snapshotBody,recordBody} from './account-study-fixtures.mjs';
import {attempt} from './task-event-fixtures.mjs';
import {sealStudyItem,sealStudySnapshot} from '../../app/account-study-content.ts';
import {sealStudyRecord} from '../../app/account-study-record.ts';

export async function accountStudyVectors() {
  const word=await sealStudyItem(wordBody({title:'Tree 🌳'}));
  const calculation=quizBody({itemKey:'practice:小数',title:'数值 · Decimal'});
  calculation.practice={itemId:'小数',abilityId:'math-decimals',domain:'course',questionType:'calculation',
    prompt:'5 ÷ 4 = ?',answer:'1.25',sourceLabel:'合成练习'};
  const items=[word,await sealStudyItem(calculation)];
  const snapshot=await sealStudySnapshot(snapshotBody(items));
  const body=await recordBody({contentHash:word.contentHash});
  const first=await sealStudyRecord(body);
  const second=await sealStudyRecord({...body,attemptId:'attempt-two',parentEventId:first.event.eventId,
    event:await attempt('event-two','2026-09-01T00:02:00Z',1,2)});
  const third=await sealStudyRecord({...body,attemptId:'attempt-three',parentEventId:second.event.eventId,
    event:await attempt('event-three','2026-09-01T00:03:00Z',2,3)});
  const legacyBody={...body};delete legacyBody.roundId;
  const legacy=await sealStudyRecord({...legacyBody,provenanceMode:'legacy-continuation',resumeId:'resume-one',
    resumeStateHash:'c'.repeat(64),legacyStage:1,legacyAnchorEventId:null,
    event:await attempt('legacy-next','2026-09-01T00:01:00Z',1,2)});
  const taskCore=JSON.parse(await readFile(new URL('./task-event-v1.json',import.meta.url),'utf8'));
  const task=await sealStudyRecord({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',originDeviceId:'device-a',
    provenanceMode:'task',planHash:'a'.repeat(64),assignmentId:'assignment-one',completionKey:'completion-one',event:taskCore});
  return {bundle:{snapshot,items},records:[first,second,third],legacy,task};
}
