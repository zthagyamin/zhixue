// @ts-expect-error TS5097: standalone Node source contracts.
import {NONWORD_RECOVERY_DATABASES,captureRecoveryDatabase} from './database.ts';
import type {RecoveryDatabase} from './database';
// @ts-expect-error TS5097: standalone Node source contracts.
import {validateNonwordRecovery} from './validation.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';
export type NonwordRecovery={schemaVersion:1;owners:string[];databases:RecoveryDatabase[]};
export async function collectNonwordRecovery(workspaceId:string):Promise<NonwordRecovery>{
  if(!workspaceId.startsWith('account:'))throw Error('recovery-account-required');
  const owner=attemptId(workspaceId.slice(8)),owners=[owner,attemptId(workspaceId)];
  const databases=await Promise.all(NONWORD_RECOVERY_DATABASES.map(descriptor=>captureRecoveryDatabase(descriptor,owners)));
  const value:NonwordRecovery={schemaVersion:1,owners,databases};
  await validateNonwordRecovery(value);return value;
}
export function nonwordPending(value:NonwordRecovery):string[]{
  const pending=new Set<string>();
  for(const database of value.databases)for(const [store,rows]of Object.entries(database.stores))for(const row of rows){
    const attempt=row.attempt as {submitted?:unknown;evaluation?:{status?:string};formal?:{status?:string}}|undefined;
    if(store==='outbox'||row.status==='cloud-conflict'||store==='requests'
      ||database.kind==='attempts'&&store==='attempts'&&attempt?.submitted&&attempt.evaluation?.status==='pending')
      pending.add(JSON.stringify(row.key.slice(0,3)));
  }
  return [...pending].sort();
}
