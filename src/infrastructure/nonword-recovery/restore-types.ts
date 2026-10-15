import type {LearningAttempt} from '../../domain/learning-attempt';
import type {RecoveryDatabaseKind,RecoveryRow} from './database';
export type RecoveryFormalProof={ownerId:string;libraryId:string;eventId:string;coreHash:string;itemKey:string;contentHash:string;snapshotId:string;reviewedAt:string;rating:string;authoritativeRecord?:{attemptId:string;roundId:string}|null};
export type RestoreOptions={current:()=>boolean;verifyFormal?:(attempt:LearningAttempt)=>Promise<RecoveryFormalProof|null>;
  verifyRow?:(kind:RecoveryDatabaseKind,store:string,row:RecoveryRow)=>Promise<boolean>};
export type RestoreDecision={kind:RecoveryDatabaseKind;store:string;row:RecoveryRow;state:'restore'|'existing'|'conflict'|'review'};
export type RestorePreview={schemaVersion:1;workspaceId:string;packageHash:string;previewHash:string;restorable:number;existing:number;conflicts:number;review:number;decisions:RestoreDecision[]};
export type RestoreResult={status:'restored'|'partial'|'stale';restored:number;existing:number;conflicts:number;review:number;archiveHash:string};
