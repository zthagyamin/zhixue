import type {StudyDevicePrincipal} from '../../domain/account-study';
import type {LearningAttemptStorePort} from '../learning-attempt';
import type {AccountPracticeEvidenceStorePort,PracticeEvidenceServiceWritePort,AccountPracticeEvidenceMappingPort} from '../practice-evidence';
import type {CourseEvidenceStorePort,CourseTaskProviderPort} from '../course-study';
import type {AttemptEvaluation} from '../../domain/learning-attempt';
import type {StudySnapshot,StudyItemVersion,StudyRecordEnvelope,AccountAssistanceV1,AssistanceReceiptV1,MachineWritebackReceipt} from '../../domain/sync';
import type {CloudTaskPlanV1,CloudPlanningCatalogV1} from '../../domain/planning';
import type {StudyAISettings,StudyAIModelSelection,StudyAIChatRequest,StudyAIStreamEvent,PlanAiRequest,PlanAiResult,QuestionAiRequest,QuestionAiResult} from '../../domain/ai';

export type StudyScope={userId:string;libraryId:string};
export type Principal={kind:'browser';userId:string}|StudyDevicePrincipal;
export type Authenticated={principal:Principal;secret?:string};
export type RequestTrace={modelId:string;promptVersion:string;ruleVersion:string};
export interface AccountAccessPort{
  profile(userId:string):Promise<{libraryId:string|null;revision:number}>;
  authenticate(secret:unknown):Promise<StudyDevicePrincipal|null>;
  register(userId:string,input:unknown):Promise<unknown>;
  activate(secret:unknown):Promise<StudyDevicePrincipal>;
  revoke(userId:string,grantId:string):Promise<boolean>;
}
export interface StudyStorePort{
  getSnapshot(scope:StudyScope,snapshotId?:string):Promise<StudySnapshot|null>;
  readFences(scope:StudyScope):Promise<unknown>;
  getSnapshotItems(scope:StudyScope,snapshot:string,position:number,limit:number):Promise<unknown>;
  getSnapshotItem(scope:StudyScope,snapshot:string,item:string):Promise<StudyItemVersion|null>;
  listRecordsAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  beginSnapshot(scope:StudyScope,snapshot:StudySnapshot):Promise<void>;
  stageSnapshotItems(scope:StudyScope,snapshot:string,entries:unknown):Promise<void>;
  completeSnapshot(scope:StudyScope,snapshot:string,expectedRevision:number):Promise<unknown>;
  appendRecord(scope:StudyScope,record:StudyRecordEnvelope):Promise<{status:'accepted'|'duplicate'|'conflict';durable:boolean;sequence:number}>;
}
export interface ReceiptStorePort{
  append(scope:StudyScope,receipt:MachineWritebackReceipt,grant:string):Promise<unknown>;
  listAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
}
export interface PlanStorePort{
  getCatalog(scope:StudyScope,snapshot:string):Promise<CloudPlanningCatalogV1|null>;
  getCatalogByHash(scope:StudyScope,hash:string):Promise<CloudPlanningCatalogV1|null>;
  getFacts(scope:StudyScope,snapshot:string):Promise<unknown>;
  getState(scope:StudyScope,day:string):Promise<{currentPlan:CloudTaskPlanV1|null}>;
  putCatalog(scope:StudyScope,catalog:unknown):Promise<unknown>;
  putFacts(scope:StudyScope,facts:unknown):Promise<unknown>;
  mutate(scope:StudyScope,mutation:unknown):Promise<unknown>;
  appendExecution(scope:StudyScope,receipt:unknown,grant:string):Promise<unknown>;
  claimExecution(scope:StudyScope,operation:string,grant:string):Promise<unknown>;
  listOperations(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  listExecutions(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  validateTaskRecord(scope:StudyScope,record:StudyRecordEnvelope):Promise<unknown>;
}
export interface LongTermStorePort{getState(scope:StudyScope):Promise<unknown>;mutate(scope:StudyScope,mutation:unknown):Promise<unknown>}
export interface ContentDecisionStorePort{
  list(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  decide(scope:StudyScope,decision:unknown):Promise<unknown>;
  appendReceipt(scope:StudyScope,receipt:unknown,grant:string):Promise<unknown>;
}
export interface AssistanceStorePort{
  supported():Promise<boolean>;readFences(scope:StudyScope):Promise<unknown>;
  listAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  listReceiptsAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<unknown>;
  append(scope:StudyScope,record:AccountAssistanceV1):Promise<unknown>;
  appendReceipt(scope:StudyScope,receipt:AssistanceReceiptV1,grant:string):Promise<unknown>;
}
export interface AiStorePort{
  getSettings(scope:StudyScope):Promise<StudyAISettings>;
  configure(scope:StudyScope,settings:unknown):Promise<unknown>;
  begin(scope:StudyScope,request:unknown):Promise<{status:'accepted'|'completed'|'pending'|'failed';settings:StudyAISettings;result?:unknown;errorCode?:string}>;
  complete(scope:StudyScope,request:string,hash:string,result:unknown,tokens:number):Promise<void>;
  fail(scope:StudyScope,request:string,hash:string,code:string):Promise<void>;
}
export interface ChatProviderPort{stream(request:StudyAIChatRequest,maxTokens:number,signal:AbortSignal):AsyncIterable<StudyAIStreamEvent>}
export type AccountStudyDependencies={
  getMathMappingStore?:()=>Promise<import('../math-study').AccountMathMappingStorePort>;
  getPracticeEvidenceStore?:(service?:PracticeEvidenceServiceWritePort)=>Promise<AccountPracticeEvidenceStorePort>;
  getPracticeEvidenceMapping?:()=>Promise<AccountPracticeEvidenceMappingPort>;
  getPracticeAi?:(scope:StudyScope,revision?:number)=>Promise<import("../math-study").PracticeAiPort>;
  getCourseEvidenceStore?:()=>Promise<CourseEvidenceStorePort>;
  getCourseAi?:(scope:StudyScope,revision?:number)=>Promise<CourseTaskProviderPort>;
  getCourseAiTrace?:()=>RequestTrace;
  fingerprintCourseEvaluation?:(evaluation:Extract<AttemptEvaluation,{status:'resolved'}>)=>Promise<string>;
  getAttemptStore?:()=>Promise<LearningAttemptStorePort>;
  getAccessStore:()=>Promise<AccountAccessPort>;getStudyStore:()=>Promise<StudyStorePort>;getReceiptStore:()=>Promise<ReceiptStorePort>;
  getAssistanceStore?:()=>Promise<AssistanceStorePort>;getLongTermStore?:()=>Promise<LongTermStorePort>;
  getPlanStore:()=>Promise<PlanStorePort>;getAiStore:()=>Promise<AiStorePort>;getContentDecisionStore:()=>Promise<ContentDecisionStorePort>;
  getPlanAi:(scope:StudyScope,revision?:number)=>Promise<{recommend(request:PlanAiRequest,budget:{maxOutputTokens:number}):Promise<PlanAiResult>}>;
  getQuestionAi:(scope:StudyScope,revision?:number)=>Promise<{run(request:QuestionAiRequest,item:StudyItemVersion,budget:{maxOutputTokens:number}):Promise<QuestionAiResult>}>;
  getChatAi?:(scope:StudyScope,revision?:number)=>Promise<ChatProviderPort>;
  getAiModels?:(scope:StudyScope,selection:StudyAIModelSelection,signal?:AbortSignal)=>Promise<string[]>;
  getPlanAiTrace:()=>RequestTrace;getQuestionAiTrace:()=>RequestTrace;planAiAvailable?:()=>boolean;
  parseSnapshot:(raw:unknown)=>Promise<StudySnapshot>;parseItem:(raw:unknown)=>Promise<StudyItemVersion>;now:()=>Date;
};
