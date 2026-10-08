import type {CloudPlanningCatalogV1,CloudPlanningFactsV1} from './account-study-planning';
import type {StudyBundle} from './account-study-content';
import type {AccountReadModel} from './account-study-read-model';
import type {AccountReadCache} from './account-study-read-cache';
import type {StudyRecordEnvelope} from './account-study-record';
import type {LongTermPlanMutation,LongTermPlanMutationResult} from './long-term-plan-state';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseLongTermPlanState,parseLongTermPlanMutation} from './long-term-plan-state.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyId} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {readAccountModel,sharedAccountRead,cancelSharedAccountReads} from './account-study-read.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {createAccountReadCache} from './account-study-read-cache.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {readAccountPages} from './account-study-paging.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseReadContentDecision} from './account-study-read-model.ts';

type Fetcher=typeof fetch;type Prepared={grantId:string;libraryId:string;tokenHash:string;label:string};
export type AccountStudyLoaded={bundle:StudyBundle;bundles:StudyBundle[];catalog:CloudPlanningCatalogV1;catalogs:CloudPlanningCatalogV1[];facts:CloudPlanningFactsV1;records:{sequence:number;record:StudyRecordEnvelope}[];writebacks:unknown[];eventThrough:number;taskThrough:number};
export type AccountAiSettingsResponse={serverAvailable:boolean;settings:{revision:number;enabled:boolean;configured:boolean}};
export function parseAccountAiSettings(raw:unknown):AccountAiSettingsResponse{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('account-ai-settings-invalid');const value=raw as {serverAvailable?:unknown;settings?:unknown};if(typeof value.serverAvailable!=='boolean')throw new Error('account-ai-server-availability-invalid');if(!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings))throw new Error('account-ai-settings-invalid');const settings=value.settings as {revision?:unknown;enabled?:unknown;configured?:unknown};if(!Number.isSafeInteger(settings.revision)||Number(settings.revision)<0||typeof settings.enabled!=='boolean'||typeof settings.configured!=='boolean')throw new Error('account-ai-settings-invalid');return{serverAvailable:value.serverAvailable,settings:{revision:settings.revision as number,enabled:settings.enabled,configured:settings.configured}};}
export class AccountLibraryReplacementRequired extends Error{code='library-replacement-required';prepared:Prepared;profileRevision:number;
  constructor(prepared:Prepared,revision:number){super('library-replacement-required');this.prepared=prepared;this.profileRevision=revision;}}
async function payload(response:Response):Promise<Record<string,unknown>>{let value:unknown;try{value=await response.json();}catch{throw new Error('account-response-invalid');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('account-response-invalid');if(!response.ok)throw Object.assign(new Error(String((value as {error?:unknown}).error??'account-request-failed')),{status:response.status});return value as Record<string,unknown>;}
let clientIdentity=0;
export function createAccountStudyClient(options:{companionUrl:string;sessionToken?:string;fetcher?:Fetcher;expectedUserId?:string;libraryId?:string;cache?:AccountReadCache|null}){
  const fetcher=options.fetcher??fetch,localHeaders={'Content-Type':'application/json',...(options.sessionToken?{'X-Study-Loop-Session':options.sessionToken}:{})};
  const local=async(action:string,body?:unknown,method='POST')=>{if(!options.sessionToken)throw new Error('companion-pairing-required');return payload(await fetcher(`${options.companionUrl}/v1/account-sync/${action}`,{method,headers:localHeaders,...(body===undefined?{}:{body:JSON.stringify(body)})}));};
  const expectedOwner:Record<string,string>=options.expectedUserId===undefined?{}:{expectedUserId:options.expectedUserId};
  if(options.expectedUserId!==undefined)studyId(options.expectedUserId,'expected-user');if(options.libraryId!==undefined)studyId(options.libraryId,'library');
  let model:AccountReadModel|null=null,libraryId=options.libraryId,lifecycle=0;
  const cache=options.expectedUserId?(options.cache===undefined?createAccountReadCache():options.cache):null,identity=++clientIdentity;
  // Explicit fields fail closed on older servers, which reject unknown fields;
  // a header alone could be ignored while a newer cookie performs a mutation.
  const cloudGet=async(action:string,query:Record<string,string|number>={},signal?:AbortSignal)=>{const params=new URLSearchParams({action,...(libraryId&&action!=='bootstrap'?{libraryId}:{}),...Object.fromEntries(Object.entries(query).map(([k,v])=>[k,String(v)])),...expectedOwner});return payload(await fetcher(`/api/account-study?${params}`,{cache:'no-store',credentials:'same-origin',signal}));};
  const cloudPost=async(action:string,body:Record<string,unknown>={},signal?:AbortSignal)=>payload(await fetcher('/api/account-study',{method:'POST',credentials:'same-origin',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...(libraryId&&action!=='register-grant'?{libraryId}:{}),...body,...expectedOwner})}));
  return {
    localStatus:()=>local('status',undefined,'GET'),
    async prepare(label:string,choice:{replaceLibrary?:boolean;rotateGrant?:boolean}={}):Promise<Prepared>{
      const requested=lifecycle;
      const prepared=await local('prepare',{label,...(choice.rotateGrant?{rotateGrant:true}:{})}) as unknown as Prepared,bootstrap=await cloudGet('bootstrap'),profile=bootstrap.profile as {libraryId?:string|null;revision:number};
      if(profile.libraryId&&profile.libraryId!==prepared.libraryId&&!choice.replaceLibrary)throw new AccountLibraryReplacementRequired(prepared,profile.revision);
      if(requested!==lifecycle)throw new DOMException('Study library or cache changed','AbortError');
      await cloudPost('register-grant',{...prepared,expectedProfileRevision:profile.revision,replaceLibrary:Boolean(choice.replaceLibrary)});
      if(requested!==lifecycle)throw new DOMException('Study library or cache changed','AbortError');
      if(libraryId!==prepared.libraryId){lifecycle++;cancelSharedAccountReads(fetcher,options.expectedUserId??identity);libraryId=prepared.libraryId;model=null;}return prepared;
    },
    start:(grantId:string)=>local('start',{grantId}),stop:(grantId:string)=>local('stop',{grantId}),
    async currentLibrary(signal?:AbortSignal):Promise<string|null>{
      const boot=await cloudGet('bootstrap',{},signal),target=(boot.profile as {libraryId?:unknown})?.libraryId;
      if(target===null||target===undefined)return null;studyId(target,'library');return target as string;
    },
    async prepareLibraryAdoption():Promise<()=>string>{
      const requested=lifecycle,boot=await cloudGet('bootstrap'),target=(boot.profile as {libraryId?:unknown})?.libraryId;
      if(requested!==lifecycle)throw new DOMException('Study library or cache changed','AbortError');
      if(typeof target!=='string')throw new Error('study-library-not-configured');studyId(target,'library');
      return()=>{
        if(requested!==lifecycle)throw new DOMException('Study library or cache changed','AbortError');
        if(target!==libraryId){lifecycle++;cancelSharedAccountReads(fetcher,options.expectedUserId??identity);libraryId=target;model=null;}return target;
      };
    },
    async adoptCurrentLibrary():Promise<string>{return(await this.prepareLibraryAdoption())();},
    async cached():Promise<AccountStudyLoaded|null>{
      if(!options.expectedUserId)return null;const requested=lifecycle,saved=cache?(libraryId?await cache.read({userId:options.expectedUserId,libraryId}):await cache.latest(options.expectedUserId)):null;
      if(requested!==lifecycle)return null;
      if(cache)model=saved?.model??null;if(saved?.model)libraryId=saved.scope.libraryId;return model?structuredClone(model.loaded):null;
    },
    async clearReadCache():Promise<void>{lifecycle++;cancelSharedAccountReads(fetcher,options.expectedUserId??identity);if(cache&&options.expectedUserId)await cache.clearUser(options.expectedUserId);model=null;},
    async load(request:{signal?:AbortSignal}={}):Promise<AccountStudyLoaded>{
      const requested=lifecycle,key=JSON.stringify([options.expectedUserId??identity,libraryId??'discover',Boolean(cache)]);
      const result=await sharedAccountRead(fetcher,key,async signal=>{
        const startedEpoch=cache&&options.expectedUserId?await cache.epoch(options.expectedUserId):null;signal.throwIfAborted();
        for(let attempt=0;attempt<3;attempt++){
        const boot=await cloudGet('bootstrap',{},signal),target=(boot.profile as {libraryId?:unknown})?.libraryId;
        if(typeof target!=='string')throw new Error('study-library-not-configured');studyId(target,'library');
        if(libraryId&&target!==libraryId)throw new Error('account-library-changed');
        if(!boot.snapshot)throw new Error('study-library-not-configured');
        const scope=options.expectedUserId?{userId:options.expectedUserId,libraryId:target}:null,saved=scope&&cache?await cache.read(scope):null;
        if(saved&&saved.token.userEpoch!==startedEpoch)throw new Error('account-cache-stale');
        const next=await readAccountModel(cloudGet,boot,saved?.model??model,signal);
        if(scope&&cache&&saved){try{await cache.commit(scope,next,saved.token,{signal});}catch(error){
          signal.throwIfAborted();
          // Another read pool (or a discovering client) can commit the same
          // owner's newer generation. Re-read incrementally; never adopt a new
          // clear epoch or weaken the underlying compare-and-swap fence.
          if(attempt<2&&error instanceof Error&&error.message==='account-cache-stale'&&await cache.epoch(scope.userId)===startedEpoch)continue;
          throw error;
        }}return next;
        }
        throw new Error('account-cache-stale');
      },request.signal);
      if(requested!==lifecycle)throw new DOMException('Study library or cache changed','AbortError');
      model=result;libraryId=result.loaded.bundle.snapshot.libraryId;return structuredClone(result.loaded);
    },
    appendRecords:(records:StudyRecordEnvelope[])=>cloudPost('append-records',{records}),
    getPlanState:(day:string)=>cloudGet('plan-state',{day}),mutatePlan:(mutation:unknown)=>cloudPost('mutate-plan',{mutation}),
    getLongTermPlanState:async()=>parseLongTermPlanState(await cloudGet('long-term-plan')),
    async mutateLongTermPlan(mutation:LongTermPlanMutation):Promise<LongTermPlanMutationResult>{
      const result=await cloudPost('mutate-long-term-plan',{mutation:parseLongTermPlanMutation(mutation)});
      if(!['accepted','duplicate','stale'].includes(String(result.status)))throw new Error('invalid-long-term-response');
      return{status:result.status as LongTermPlanMutationResult['status'],state:parseLongTermPlanState(result.state)};
    },
    async getPlanOperations(){await this.load();return{operations:structuredClone(model!.operations),through:model!.operationThrough};},
    async getPlanExecutions(){await this.load();return{executions:structuredClone(model!.executions),through:model!.executionThrough};},
    async getContentDecisions(){
      // These rows change status in place. Their insertion sequence is not an
      // update cursor, so keep a complete bounded refresh instead of skipping changes.
      const page=await readAccountPages(params=>cloudGet('content-decisions',{after:params.after,limit:20,...(params.through===undefined?{}:{through:params.through})}),{collection:'operations',parse:parseReadContentDecision});
      return{operations:page.rows,through:page.through};
    },
    aiWorkspaceRequest:(action:'settings'|'configure'|'chat'|'models',value?:unknown,signal?:AbortSignal)=>action==='models'?cloudPost('ai-models',{selection:value},signal):action==='settings'?cloudGet('ai-settings',{},signal):action==='configure'?cloudPost('configure-plan-ai',{settings:value},signal):fetcher('/api/account-study',{method:'POST',credentials:'same-origin',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ai-chat',libraryId,request:value,...expectedOwner})}),
    getAiSettings:async()=>parseAccountAiSettings(await cloudGet('ai-settings')),configureAi:(settings:unknown)=>cloudPost('configure-plan-ai',{settings}),
    recommendPlan:(request:{requestId:string;day:string;request:unknown})=>cloudPost('recommend-plan-ai',request as unknown as Record<string,unknown>),
    decideContent:(decision:unknown)=>cloudPost('decide-content',{decision}),
    questionAi:(request:{requestId:string;request:unknown})=>cloudPost('question-ai',request as unknown as Record<string,unknown>),
  };
}
