import type {SubmissionRow,StudySubmissionV1,CorePersistenceState} from '../../domain/sync';
import type {SubmissionJournalPort as SubmissionJournal} from './ports';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseStudySubmission} from '../../domain/sync/index.ts';
/** Delivery only: old stores may still dispatch their already-frozen records
 * when the new DB is unavailable. Never use this fallback for complete history. */
export async function readJournalForDelivery(journal:Pick<SubmissionJournal,'get'>,workspaceId:string,eventId:string):Promise<SubmissionRow|null>{
  try{return await journal.get(workspaceId,eventId);}catch(error){
    if(error instanceof Error&&/conflict|integrity|binding|^invalid-|^unsupported-|^unknown-/.test(error.message))throw error;
    return null;
  }
}

type PersistDependencies={journal:Pick<SubmissionJournal,'put'>&Partial<Pick<SubmissionJournal,'markCoreStored'>>;persistCore:(payload:StudySubmissionV1)=>Promise<void|CorePersistenceState>};

export async function persistStudySubmission(raw:unknown,deps:PersistDependencies):Promise<{journalSaved:boolean;coreStored:boolean;auxiliarySaved:boolean}&CorePersistenceState>{
  const payload=await parseStudySubmission(raw);let journalSaved=false;
  try{await deps.journal.put(payload);journalSaved=true;}catch(error){
    if(error instanceof Error&&/conflict|integrity|binding|^invalid-|^unsupported-|^unknown-/.test(error.message))throw error;
  }
  let coreState:CorePersistenceState|undefined;
  try{coreState=await deps.persistCore(payload)||undefined;}catch(error){
    if(!journalSaved||error instanceof Error&&/conflict|integrity|binding|^invalid-/.test(error.message))throw error;
    return{journalSaved:true,coreStored:false,auxiliarySaved:Boolean(payload.summary)};
  }
  if(journalSaved)try{await deps.journal.markCoreStored?.(payload.workspaceId,payload.eventId);}catch{/* Immutable journal replays idempotently after restart. */}
  return{journalSaved,coreStored:true,auxiliarySaved:journalSaved&&Boolean(payload.summary),...(coreState?.mirror?{mirror:coreState.mirror,localMetadataSaved:journalSaved||coreState.localMetadataSaved!==false}:{})};
}

export async function recoverStudySubmissions(workspaceId:string,deps:{journal:SubmissionJournal;persistCore:(payload:StudySubmissionV1)=>Promise<void|CorePersistenceState>}):Promise<{recovered:number;failed:number}>{
  let recovered=0,failed=0;for(const row of await deps.journal.list(workspaceId))if(!row.coreStored){
    try{await deps.persistCore(row.payload);await deps.journal.markCoreStored(workspaceId,row.eventId);recovered++;}catch{failed++;}
  }return{recovered,failed};
}
