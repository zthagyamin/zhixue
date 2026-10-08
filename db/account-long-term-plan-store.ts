import type {LongTermPlanState,LongTermPlanMutationResult} from '../app/long-term-plan-state';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {emptyLongTermPlanState,parseLongTermPlanState,parseLongTermPlanMutation,assertLongTermPlanTransition,canonicalLongTermJson,longTermRequestHash} from '../app/long-term-plan-state.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyId} from '../app/account-study-content.ts';

type Scope={userId:string;libraryId:string};
type D1=Pick<D1Database,'prepare'|'batch'>;
type StateRow={user_id:string;library_id:string;revision:number;state_json:string|null;last_operation_id:string|null};
type OperationRow={request_hash:string;state_revision:number};
function scopeArgs(scope:Scope):[string,string]{studyId(scope.userId,'user');studyId(scope.libraryId,'library');return[scope.userId,scope.libraryId];}

/** Account-scoped planning preferences; never writes a learning event or approved daily plan. */
export class AccountLongTermPlanStore{
  private database:D1;
  constructor(database:D1){this.database=database;}
  private q(sql:string,...bindings:unknown[]){return this.database.prepare(sql).bind(...bindings);}
  async getState(scope:Scope):Promise<LongTermPlanState>{
    const args=scopeArgs(scope);
    const row=await this.q('SELECT * FROM account_long_term_plan_states WHERE user_id=? AND library_id=?',...args).first<StateRow>();
    if(!row)return emptyLongTermPlanState();
    const state=row.state_json===null?emptyLongTermPlanState():parseLongTermPlanState(JSON.parse(row.state_json));
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.revision!==state.revision||row.last_operation_id!==state.lastOperationId)throw new Error('long-term-state-integrity');
    return state;
  }
  private async operation(scope:Scope,id:string):Promise<OperationRow|null>{
    return this.q('SELECT request_hash,state_revision FROM account_long_term_plan_operations WHERE user_id=? AND library_id=? AND operation_id=?',...scopeArgs(scope),id).first<OperationRow>();
  }
  async mutate(scope:Scope,raw:unknown):Promise<LongTermPlanMutationResult>{
    const args=scopeArgs(scope),mutation=parseLongTermPlanMutation(raw),requestHash=await longTermRequestHash(mutation);
    const prior=await this.operation(scope,mutation.operationId);
    if(prior){if(prior.request_hash!==requestHash)throw new Error('long-term-operation-conflict');return{status:'duplicate',state:await this.getState(scope)};}
    await this.q('INSERT INTO account_long_term_plan_states(user_id,library_id,revision) VALUES(?,?,0) ON CONFLICT DO NOTHING',...args).run();
    const before=await this.getState(scope);
    if(before.revision!==mutation.expectedRevision)return{status:'stale',state:before};
    assertLongTermPlanTransition(before.snapshot,mutation.snapshot);
    const next:LongTermPlanState={revision:before.revision+1,enabled:mutation.enabled,snapshot:mutation.snapshot,lastOperationId:mutation.operationId};
    parseLongTermPlanState(next);
    const beforeJson=canonicalLongTermJson(before),afterJson=canonicalLongTermJson(next);
    if(new TextEncoder().encode(afterJson).byteLength>2_000_000)throw new Error('long-term-plan-too-large');
    const update=this.q('UPDATE account_long_term_plan_states SET revision=?,state_json=?,last_operation_id=? WHERE user_id=? AND library_id=? AND revision=? AND NOT EXISTS (SELECT 1 FROM account_long_term_plan_operations WHERE user_id=? AND library_id=? AND operation_id=?)',
      next.revision,afterJson,mutation.operationId,...args,before.revision,...args,mutation.operationId);
    const insert=this.q('INSERT INTO account_long_term_plan_operations(user_id,library_id,operation_id,request_hash,state_revision,before_json,after_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_long_term_plan_states WHERE user_id=? AND library_id=? AND revision=? AND last_operation_id=?) ON CONFLICT DO NOTHING',
      ...args,mutation.operationId,requestHash,next.revision,beforeJson,afterJson,...args,next.revision,mutation.operationId);
    const written=await this.database.batch([update,insert]);
    const saved=await this.operation(scope,mutation.operationId),state=await this.getState(scope);
    if(!saved)return{status:'stale',state};
    if(saved.request_hash!==requestHash)throw new Error('long-term-operation-conflict');
    return{status:written[0].meta.changes===1?'accepted':'duplicate',state};
  }
}
