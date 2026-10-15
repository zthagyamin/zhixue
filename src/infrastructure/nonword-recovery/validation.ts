import type {NonwordRecovery} from './index';
import type {RecoveryRow} from './database';
// @ts-expect-error TS5097: standalone Node source contracts.
import {NONWORD_RECOVERY_DATABASES} from './database.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {attemptId,canonicalAttemptJson,parseAttemptMutation,parseLearningAttempt} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {attemptFingerprint,evaluationFingerprint} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseCourseEvidence,parseCourseEvidenceMutation,parseNativeCourseCapture} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parsePracticeEvidence,parsePracticeEvidenceMutation,practiceEvidenceFingerprint} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseNativeMathCapture,parseNativeMathClaim} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {courseEvidenceFingerprint} from '../course-study/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyHash} from '../../domain/sync/index.ts';

const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
function shape(row:RecoveryRow,kind:string,store:string){
 let required:string[],optional:string[]=[];
 if(store==='outbox')required=['key','scope','mutation','fingerprint'];
 else if(kind==='attempts'&&store==='attempts')required=['key','scope','attempt','cloudRevision','status'];
 else if(store==='references')required=['key','scope','item'];
 else if(store==='captures')required=['key','capture','rowHash'];
 else if(store==='identities')required=['key','captureId'];
 else if(store==='attempts')required=['key','binding','captureId','linkHash'];
 else if(store==='claims')required=['key','claim','rowHash'];
 else if(store==='requests')required=['key','requestId'];
 else if(kind==='course-evidence')required=['key','scope','evidence','cloudRevision','status'];
 else if(kind==='practice-evidence'){required=['key','scope','record','cloudRevision','status'];optional=['firstReportOperation'];}
 else required=['key','record','rowHash'];
 if(!row||typeof row!=='object'||Array.isArray(row)||required.some(key=>!Object.hasOwn(row,key))
  ||Object.keys(row).some(key=>!required.includes(key)&&!optional.includes(key)))throw Error('nonword-recovery-row-schema');
 const length=store==='outbox'?4:kind==='math-mappings'?5:3;
 if(!Array.isArray(row.key)||row.key.length!==length)throw Error('nonword-recovery-row-key');
}
function scope(row:RecoveryRow,owners:readonly string[]){
  if(!Array.isArray(row.key)||row.key.length<3||row.key.length>5||!owners.includes(row.key[0]))throw Error('nonword-recovery-row-owner');
  row.key.slice(0,2).forEach(attemptId);
  if(row.key.some(value=>typeof value!=='string'||!value.trim()||value.length>64000))throw Error('nonword-recovery-row-key');
  if(row.scope!==undefined&&!same(row.scope,row.key.slice(0,2)))throw Error('nonword-recovery-row-scope');
  for(const raw of [row.binding,(row.attempt as {binding?:unknown}|undefined)?.binding,(row.mutation as {binding?:unknown}|undefined)?.binding,
    (row.evidence as {binding?:unknown}|undefined)?.binding,(row.record as {binding?:unknown}|undefined)?.binding])if(raw){
    const binding=raw as {ownerId?:unknown;libraryId?:unknown};
    if(binding.ownerId!==row.key[0]||binding.libraryId!==row.key[1])throw Error('nonword-recovery-binding');
  }
}
/** Validates exported source integrity; importing still needs separate authority and conflict checks. */
export async function validateNonwordRecovery(value:NonwordRecovery):Promise<void>{
  if(value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','owners','databases'].includes(key))||!Array.isArray(value.owners)||value.owners.length!==2||!Array.isArray(value.databases))throw Error('nonword-recovery-version');
  value.owners.forEach(attemptId);
  if(value.owners[1]!==`account:${value.owners[0]}`||value.databases.length!==NONWORD_RECOVERY_DATABASES.length)throw Error('nonword-recovery-owner');
  for(const descriptor of NONWORD_RECOVERY_DATABASES){
    const matches=value.databases.filter(database=>database.kind===descriptor.kind);
    if(matches.length!==1)throw Error('nonword-recovery-database');const database=matches[0];
    if(Object.keys(database).some(key=>!['kind','stores'].includes(key)))throw Error('nonword-recovery-database');
    if(!same(Object.keys(database.stores).sort(),[...descriptor.stores].sort()))throw Error('nonword-recovery-stores');
    for(const [store,rows]of Object.entries(database.stores)){
      if(!Array.isArray(rows)||rows.length>100000)throw Error('nonword-recovery-record-limit');const seen=new Set<string>();
      for(const row of rows){
        shape(row,descriptor.kind,store);scope(row,value.owners);const identity=canonicalAttemptJson(row.key);
        if(seen.has(identity))throw Error('nonword-recovery-duplicate');seen.add(identity);
        if(descriptor.kind==='attempts'&&store==='attempts'){
          const attempt=parseLearningAttempt(row.attempt);
          if(attempt.attemptId!==row.key[2])throw Error('nonword-recovery-attempt-key');
          if(!['device-only','cloud-acked','cloud-conflict'].includes(String(row.status))||!Number.isSafeInteger(row.cloudRevision)||Number(row.cloudRevision)<0)throw Error('nonword-recovery-attempt-status');
          if(attempt.evaluation.status==='resolved'&&attempt.evaluation.evaluationHash!==await evaluationFingerprint(attempt.evaluation))throw Error('nonword-recovery-evaluation-hash');
        }else if(store==='outbox'){
          const mutation=descriptor.kind==='attempts'?parseAttemptMutation(row.mutation):descriptor.kind==='course-evidence'?parseCourseEvidenceMutation(row.mutation):parsePracticeEvidenceMutation(row.mutation);
          const fingerprint=descriptor.kind==='attempts'?await attemptFingerprint(mutation):descriptor.kind==='course-evidence'?await courseEvidenceFingerprint(mutation):await practiceEvidenceFingerprint(mutation);
          if(mutation.attemptId!==row.key[2]||mutation.operationId!==row.key[3]||row.fingerprint!==fingerprint)throw Error('nonword-recovery-operation');
        }else if(descriptor.kind==='course-evidence'&&store==='records')parseCourseEvidence(row.evidence);
        else if(descriptor.kind==='practice-evidence'&&store==='records')parsePracticeEvidence(row.record);
        else if(store==='captures'){
          const capture=descriptor.kind==='native-course'?await parseNativeCourseCapture(row.capture):await parseNativeMathCapture(row.capture);
          if(capture.captureId!==row.key[2]||capture.identity.libraryId!==row.key[1]||row.rowHash!==await studyHash({key:row.key,capture:row.capture}))throw Error('nonword-recovery-source');
        }else if(descriptor.kind==='native-math'&&store==='claims'){
          const claim=parseNativeMathClaim(row.claim);
          if(claim.attempt.attemptId!==row.key[2]||claim.attempt.binding.ownerId!==row.key[0]||claim.attempt.binding.libraryId!==row.key[1]||row.rowHash!==await studyHash({key:row.key,claim:row.claim}))throw Error('nonword-recovery-claim');
        }else if(descriptor.kind==='math-mappings'||descriptor.kind==='native-math-mappings'){
          if(row.rowHash!==await studyHash({key:row.key,record:row.record}))throw Error('nonword-recovery-mapping');
        }else if(store==='requests')attemptId(row.requestId);
        else if(store==='attempts'&&row.linkHash!==await studyHash({key:row.key,binding:row.binding,captureId:row.captureId}))throw Error('nonword-recovery-source-link');
      }
    }
  }
}
