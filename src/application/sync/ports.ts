import type {StudySubmissionV1,SubmissionRow,StudyRecordEnvelope,CorePersistenceState,LocalStudyEventRecord,DeliveryTarget,DeliveryState} from '../../domain/sync';
import type {StudyEventV3} from '../../domain/evidence';

/** Existing journal format; the application has no database handles or delete capability. */
export type SubmissionJournalPort={
  get:(owner:string,eventId:string)=>Promise<SubmissionRow|null>;
  list:(owner:string)=>Promise<SubmissionRow[]>;
  put:(raw:unknown)=>Promise<'accepted'|'duplicate'>;
  markCoreStored:(owner:string,eventId:string)=>Promise<void>;
  ackSummary:(owner:string,eventId:string,receipt:unknown)=>Promise<void>;
  applyReceipt:(owner:string,eventId:string,revision:number,receipt:unknown)=>Promise<void>;
};
export type AccountDeliveryRow={record:StudyRecordEnvelope;cloud:'pending'|'acked'};
export type SubmissionStores={
  persistOriginalSubmission:(payload:StudySubmissionV1)=>Promise<CorePersistenceState>;
  getLocalStudyRecord:(owner:string,libraryId:string,eventId:string)=>Promise<AccountDeliveryRow|null>;
  applyLocalStudyReceipt:(owner:string,receipt:unknown)=>Promise<unknown>;
  getLocalStudyEvent:(owner:string,eventId:string)=>Promise<LocalStudyEventRecord|undefined>;
  updateStudyEventDelivery:(owner:string,eventId:string,target:DeliveryTarget,state:DeliveryState)=>Promise<void>;
  isStudyStorageFailure:(error:unknown)=>boolean;
};
export type DeliveryHttpPort={
  account:(libraryId:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
  native:(action:string,body:unknown,conflictEventId?:string)=>Promise<Record<string,unknown>>;
  bootstrap:()=>Promise<Record<string,unknown>>;
  boundEvents:(events:StudyEventV3[])=>Promise<Record<string,unknown>>;
};
