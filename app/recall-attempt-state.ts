// @ts-expect-error TS5097: standalone Node tests.
import {loadWorkspaceRecord,updateWorkspaceRecord,type WorkspaceRecordKind} from './local-study-db.ts';
// @ts-expect-error TS5097: standalone Node tests.
import {studyHash,studyId,studyDigest} from './account-study-content.ts';
export type RecallAttemptScope={workspaceId:string;libraryId:string;itemKey:string;contentHash:string};
export type RecallAttemptState={schemaVersion:1;attemptId:string;maxPreHintLevel:number};
async function key(scope:RecallAttemptScope){studyId(scope.workspaceId);studyId(scope.libraryId);studyId(scope.itemKey);studyDigest(scope.contentHash);return `recall-attempt:${await studyHash([scope.libraryId,scope.itemKey,scope.contentHash])}` as WorkspaceRecordKind;}
function parse(value:RecallAttemptState){if(!value||value.schemaVersion!==1||!Number.isInteger(value.maxPreHintLevel)||value.maxPreHintLevel<0||value.maxPreHintLevel>3)throw new Error('recall-attempt-state-invalid');studyId(value.attemptId);return value;}
const fresh=():RecallAttemptState=>({schemaVersion:1,attemptId:crypto.randomUUID(),maxPreHintLevel:0});
export async function openRecallAttempt(scope:RecallAttemptScope,isCompleted:(id:string)=>Promise<boolean>):Promise<RecallAttemptState>{
 if(typeof indexedDB==='undefined')throw new Error('recall-attempt-storage-unavailable');
 const kind=await key(scope),old=await loadWorkspaceRecord<RecallAttemptState|null>(scope.workspaceId,kind,null);
 const completed=old?await isCompleted(parse(old).attemptId):false;
 let result:RecallAttemptState|undefined;
 await updateWorkspaceRecord<RecallAttemptState|null>(scope.workspaceId,kind,null,current=>{
  if(!current){result=fresh();return result;}parse(current);
  result=completed&&current.attemptId===old?.attemptId?fresh():current;return result;
 });return parse(result!);
}
export async function recordRecallHint(scope:RecallAttemptScope,attemptId:string,level:number):Promise<RecallAttemptState>{
 if(!Number.isInteger(level)||level<0||level>3)throw new Error('invalid-recall-hint-level');
 let result:RecallAttemptState|undefined;
 await updateWorkspaceRecord<RecallAttemptState|null>(scope.workspaceId,await key(scope),null,current=>{
  if(!current||parse(current).attemptId!==attemptId)throw new Error('recall-attempt-changed');
  result={...current,maxPreHintLevel:Math.max(current.maxPreHintLevel,level)};return result;
 });return parse(result!);
}
