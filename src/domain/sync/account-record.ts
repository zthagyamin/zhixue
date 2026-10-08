import type {StudyAttemptEventV3} from '../evidence';
import type {TaskEventV1} from '../planning';
import type {PracticeMode as PluginType} from '../content';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseCloudStudyEventV3} from '../evidence/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {validateTaskEvent} from '../planning/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyObject,studyId,studyDigest,studyCount,studySize,studyHash} from './validation.ts';
type Common={schemaVersion:1;libraryId:string;snapshotId:string;originDeviceId:string};

type PracticeCommon=Common&{event:StudyAttemptEventV3;contentHash:string;practiceMode:PluginType;attemptId:string;parentEventId:string|null};

export type RoundRecordBody=PracticeCommon&{provenanceMode:'verified-round';roundId:string};

export type LegacyRecordBody=PracticeCommon&{provenanceMode:'legacy-continuation';resumeId:string;resumeStateHash:string;
  legacyStage:1|2;legacyAnchorEventId:string|null};

export type TaskRecordBody=Common&{provenanceMode:'task';event:TaskEventV1;planHash:string;assignmentId:string;completionKey:string};

export type StudyRecordBody=RoundRecordBody|LegacyRecordBody|TaskRecordBody;

export type StudyRecordEnvelope=StudyRecordBody&{envelopeHash:string};

const MAX_RECORD_BYTES=64*1024;


async function parseBody(raw:unknown,hasHash:boolean):Promise<StudyRecordBody> {
  const common=['schemaVersion','libraryId','snapshotId','originDeviceId','provenanceMode','event'];
  const practice=['contentHash','practiceMode','attemptId','parentEventId'];
  const legacy=['resumeId','resumeStateHash','legacyStage','legacyAnchorEventId'];
  const task=['planHash','assignmentId','completionKey'];
  const object=studyObject(raw,common,[...practice,...legacy,...task,'roundId',...(hasHash?['envelopeHash']:[])]);
  if (object.schemaVersion!==1) throw new Error('unsupported-study-version');
  for (const key of ['libraryId','snapshotId','originDeviceId']) studyId(object[key],key);
  if (hasHash) studyDigest(object.envelopeHash);
  const mode=object.provenanceMode;
  if (mode==='task') {
    studyObject(object,[...common,...task],hasHash?['envelopeHash']:[]);
    studyDigest(object.planHash);studyId(object.assignmentId,'assignment');studyId(object.completionKey,'completion');
    object.event=await validateTaskEvent(object.event);
  } else if (mode==='verified-round'||mode==='legacy-continuation') {
    studyObject(object,[...common,...practice,...(mode==='verified-round'?['roundId']:legacy)],hasHash?['envelopeHash']:[]);
    studyDigest(object.contentHash);studyId(object.attemptId,'attempt');
    if(typeof object.practiceMode!=='string'||!['three-stage','quiz','recall','calculation','code','flashcard','spelling'].includes(object.practiceMode)) throw new Error('invalid-practice-mode');
    if (object.parentEventId!==null) studyId(object.parentEventId,'parent-event');
    if (mode==='verified-round') studyId(object.roundId,'round');
    else {
      studyId(object.resumeId,'resume');studyDigest(object.resumeStateHash);studyCount(object.legacyStage,'legacy-stage',1);
      if (object.legacyStage>2) throw new Error('invalid-legacy-stage');
      if (object.legacyAnchorEventId!==null) studyId(object.legacyAnchorEventId,'legacy-anchor');
    }
    const event=await parseCloudStudyEventV3(object.event);
    if (event.eventType!=='practice-attempt') throw new Error('study-record-requires-attempt');
    if (event.attempt.stageBefore>3||event.attempt.stageAfter>3) throw new Error('invalid-study-stage');
    // clientStateAfter is explicitly not part of V3 core evidence. Portable
    // records bind the original core, never a device-specific float projection.
    if (event.scheduling?.clientStateAfter!==undefined) {
      if (hasHash) throw new Error('nonportable-client-projection');
      delete event.scheduling.clientStateAfter;
    }
    object.event=event;
  } else throw new Error('invalid-study-provenance');
  delete object.envelopeHash;
  return object as StudyRecordBody;
}

function frozenInput(raw:unknown):unknown {
  studySize(raw,MAX_RECORD_BYTES);
  try {return structuredClone(raw);} catch {throw new Error('invalid-study-record');}
}
export async function sealStudyRecord(raw:unknown):Promise<StudyRecordEnvelope> {
  const body=await parseBody(frozenInput(raw),false);
  const record={...body,envelopeHash:await studyHash(body)};
  studySize(record,MAX_RECORD_BYTES);return record;
}

export async function parseStudyRecord(raw:unknown):Promise<StudyRecordEnvelope> {
  const frozen=frozenInput(raw);
  const envelopeHash=(frozen as StudyRecordEnvelope)?.envelopeHash;
  const body=await parseBody(frozen,true);
  if (await studyHash(body)!==envelopeHash) throw new Error('study-record-integrity');
  return {...body,envelopeHash};
}

/** Both arguments must first pass parseStudyRecord at the storage boundary. */
export function compareStudyRecord(existing:StudyRecordEnvelope,incoming:StudyRecordEnvelope):'duplicate'|'conflict' {
  return existing.libraryId===incoming.libraryId && existing.event.eventId===incoming.event.eventId
    && existing.event.coreHash===incoming.event.coreHash && existing.envelopeHash===incoming.envelopeHash ? 'duplicate':'conflict';
}
