import type {PlanHistoryEntry,CurrentPlanPayload,PlanDocumentPayload,MutationResult} from '../src/domain/planning';
import type {NativeCourseTransport} from '../src/application/course-study';
import type {NativeMathTransport} from '../src/domain/math-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {createNativeMathClient} from '../src/infrastructure/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createNativeCourseClient} from '../src/infrastructure/course-study/index.ts';
export type {PlanHistoryEntry,CurrentPlanPayload,PlanDocumentPayload,MutationResult} from '../src/domain/planning';
import type { PlanCandidate } from "./daily-plan";
import type { PlanDocument, TaskPlanV2, SuggestionRequest, SuggestionResponse, TaskEventV1, PlanningContext, PlanningEvidencePage } from './task-plan-types';
// @ts-expect-error TS5097: Node's contract tests use explicit TypeScript extensions.
import { isTaskPlan, parseTaskPlan, supportsTaskPlanning, validPlanDay } from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validateTaskEvent} from './task-event-v1.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parsePlanningContext,parsePlanningEvidencePage} from './planning-context.ts';

export type TaskEventPage={events:TaskEventV1[];nextCursor:string|null;snapshotHash:string};
export type TaskEventReceipt={status:'accepted'|'duplicate';eventId:string;durable:true};

export type ConstraintMode = "auto" | "temporary" | "locked";
export type ConstraintValues = {
  dailyMinutes: { min: number; max: number };
  weeklyRhythm?: { workdayMinutes: number; weekendMinutes: number } | { activeDays: number[]; restDays: number[] };
  loadFactor?: number;
  minimumReviewMinutes?: number;
};
export type CompanionDeadline = { date: string; title: string; priority: number; scopeRef?: string };
export type ConstraintDocument = {
  schemaVersion?: number;
  mode: ConstraintMode;
  system: ConstraintValues;
  override?: Partial<ConstraintValues> | null;
  temporaryUntil?: string | null;
  deadlines: CompanionDeadline[];
  estimatedAt?: string;
  explanation: string;
  effective: ConstraintValues;
};
export type ChangeCandidate = { changeId: string; kind: string; path: string; oldPath?: string; contentHash: string };
export type ChangeProjection = { scannedAt?: string | null; pendingCount: number; changes: ChangeCandidate[]; error?: string | null };
export type ChangeDecision = "approved" | "rejected" | "later";
export type ChangeDecisionPayload = { changeId?: string; decision?: ChangeDecision; message?: string };
export type PendingCapture = {
  captureId: string;
  itemId: string;
  domain: string;
  sourceNote: string;
  stateRef: string;
  abilityId: string;
  pluginType: string;
  planRevision: number;
  evidence: "explicit" | "speculative";
  summary?: string | null;
  capturedAt: string;
  processedAt?: string | null;
  routeStatus?: string | null;
  routeRevision?: number | null;
};
export type CapturePayload = { pendingCaptures: PendingCapture[] };
export type SourcesInitPayload = { root: string; dirs: Record<string, string> };
export type PracticeItem = {
  learningSupport?:import('./learning-support').LearningSupport;
  contentHash?:string;
  accountItemKey?:string;
  itemId: string;
  abilityId: string;
  domain: string;
  sourceNote: string;
  stateRef: string;
  questionType: "quiz" | "recall" | "calculation" | "code" | "three-stage" | "flashcard";
  prompt: string;
  options?: string[];
  answer?: number | string;
  explanation?: string;
  reviewPoint?: string;
  fingerprint: string;
  sourceLabel: string;
  dueAt?: string;
  initialCode?: string;
  testCode?: string;
  solutionCode?: string;
};

export type PracticeGrade = {
  matchedPointIds?:string[];
  missedPointIds?:string[];
  correct: boolean | null;
  verdict: string;
  explanation?: string;
  rating?: "again" | "hard" | "good" | "easy";
  source?: "ai" | "self-assess" | string;
  confidence?: number;
  feedback?: string;
  matchedPoints?: string[];
  missedPoints?: string[];
  aiFallback?: boolean;
};

type ResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;

export type CompanionPlanClient = {
  nativeCourse?: NativeCourseTransport;
  nativeMath?: NativeMathTransport;
  getCurrentPlan: () => Promise<CurrentPlanPayload>;
  getPlanDocument: () => Promise<PlanDocumentPayload>;
  getPlanningContext: () => Promise<PlanningContext>;
  getPlanningEvidence: (sourceHash:string,planRevision:number,after?:string) => Promise<PlanningEvidencePage>;
  suggestPlan: (request:SuggestionRequest) => Promise<SuggestionResponse>;
  appendTaskEvent: (event:TaskEventV1) => Promise<TaskEventReceipt>;
  getTaskEvents: (after?:string) => Promise<TaskEventPage>;
  applyTaskPlan: (candidate:TaskPlanV2,expectedRevision:number,operator?:string) => Promise<MutationResult<TaskPlanV2>>;
  getConstraints: () => Promise<ConstraintDocument>;
  saveConstraints: (document: ConstraintDocument) => Promise<ConstraintDocument>;
  getChanges: () => Promise<ChangeProjection>;
  scanChanges: () => Promise<ChangeProjection>;
  decideChange: (changeId: string, decision: ChangeDecision, operator?: string) => Promise<ChangeDecisionPayload>;
  applyPlan: (candidate: PlanCandidate, expectedRevision: number, operator?: string) => Promise<MutationResult>;
  /** AI 计划编排：仅重排，不增删条目。 */
  aiReorderPlan?: <T extends { itemKey: string }>(items: T[]) => Promise<T[]>;
  rejectPlan: (candidateHash: string, reason?: string, operator?: string) => Promise<MutationResult>;
  restorePlan: (target: number, expectedRevision: number, operator?: string) => Promise<MutationResult>;
  getCaptures: () => Promise<CapturePayload>;
  initSources: () => Promise<SourcesInitPayload>;
  getPractice: () => Promise<{ items: PracticeItem[] }>;
  gradePractice: (item: PracticeItem, answer: unknown) => Promise<PracticeGrade>;
  variantPractice: (item: PracticeItem, attempt: number) => Promise<{ item: PracticeItem }>;
};

function errorMessage(payload: unknown, fallback: string): string {
  return typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string"
    ? payload.message
    : fallback;
}

export function createCompanionPlanClient(options: {
  fetcher?: FetchLike;
  baseUrl: string;
  sessionToken: string;
  capabilities?: string[];
}): CompanionPlanClient {
  const fetcher = options.fetcher ?? (fetch as unknown as FetchLike);
  const url = (path: string) => `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const headers = (json = false): Record<string, string> => ({
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-Study-Loop-Session": options.sessionToken,
  });
  const get = async <T>(path: string, timeoutMs=3000): Promise<T> => {
    const response = await fetcher(url(path), { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json();
    if (!response.ok) throw new Error(errorMessage(payload, "Companion 请求失败。"));
    return payload as T;
  };
  const post = async <T>(path: string, body: unknown, timeoutMs=5000): Promise<{ response: ResponseLike; payload: T }> => {
    const response = await fetcher(url(path), {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { response, payload: await response.json() as T };
  };
  const mutation = async <T extends PlanDocument = PlanCandidate>(path: string, body: unknown): Promise<MutationResult<T>> => {
    const { response, payload } = await post<{ revision?: PlanHistoryEntry<T>; message?: string; status?: string }>(path, body);
    if (response.status === 409) return { status: "stale", message: payload.message };
    if (!response.ok) throw new Error(payload.message || "计划操作失败。");
    return { status: "ok", revision: payload.revision, message: payload.message };
  };
  const readDocument = (candidate:PlanDocument|null|undefined):PlanDocument|null => {
    if (!candidate) return null;
    return 'schemaVersion' in candidate ? parseTaskPlan(candidate) : candidate;
  };
  const getPlanDocument = async ():Promise<PlanDocumentPayload> => {
    const result=await get<PlanDocumentPayload>('/v1/plan/current');
    return {...result,candidate:readDocument(result.candidate),
      history:result.history.map(entry=>({...entry,...(entry.after === undefined ? {} : {after:readDocument(entry.after)})}))};
  };

  return {
    nativeCourse: createNativeCourseClient({...options, fetcher}),
    nativeMath: createNativeMathClient({...options, fetcher}),
    getPlanDocument,
    getPlanningContext:async()=>parsePlanningContext(await get('/v1/plan/context',50000)),
    getPlanningEvidence:async(sourceHash,planRevision,after)=>{
      if (!supportsTaskPlanning(options.capabilities)) throw new Error('请先更新并重启 Companion，以核对完整学习证据。');
      const query=`sourceHash=${encodeURIComponent(sourceHash)}&planRevision=${planRevision}`+(after===undefined?'':`&after=${encodeURIComponent(after)}`);
      return parsePlanningEvidencePage(await get('/v1/plan/evidence?'+query,50000));
    },
    appendTaskEvent:async value=>{
      if (!supportsTaskPlanning(options.capabilities)) throw new Error('请先更新并重启 Companion，以启用任务记录。');
      const event=await validateTaskEvent(value);
      const {response,payload}=await post<TaskEventReceipt>('/v1/tasks/events',{event});
      if (!response.ok) throw new Error(errorMessage(payload,'任务记录写回失败。'));
      if (!payload || !['accepted','duplicate'].includes(payload.status) || payload.eventId!==event.eventId || payload.durable!==true) throw new Error('invalid-task-event-receipt');
      return payload;
    },
    getTaskEvents:async after=>{
      if (!supportsTaskPlanning(options.capabilities)) throw new Error('请先更新并重启 Companion，以启用任务记录。');
      const page=await get<TaskEventPage>('/v1/tasks/events'+(after===undefined?'':`?after=${encodeURIComponent(after)}`));
      if (!page || !Array.isArray(page.events) || page.events.length>100 || (page.nextCursor!==null && (typeof page.nextCursor!=='string' || !page.nextCursor || !page.events.length))
        || typeof page.snapshotHash!=='string' || !/^[a-f0-9]{64}$/.test(page.snapshotHash)) throw new Error('invalid-task-event-page');
      return {...page,events:await Promise.all(page.events.map(validateTaskEvent))};
    },
    suggestPlan: async request => {
      if (!supportsTaskPlanning(options.capabilities)) throw new Error('请先更新并重启 Companion，以启用任务型计划。');
      const {response,payload}=await post<SuggestionResponse>('/v1/plan/suggest',request,50000);
      if (!response.ok) throw new Error(errorMessage(payload,'AI 建议请求失败。'));
      const valid=payload && validPlanDay(payload.day) && typeof payload.sourceHash==='string' && /^[a-f0-9]{64}$/.test(payload.sourceHash)
        && Number.isSafeInteger(payload.draftVersion) && payload.draftVersion>=0 && ['ai','fallback'].includes(payload.mode)
        && typeof payload.message==='string' && Array.isArray(payload.selections)
        && payload.selections.every(selection=>selection && Array.isArray(selection.unitIds) && selection.unitIds.length>0
          && selection.unitIds.every(id=>typeof id==='string' && id.trim()) && typeof selection.reason==='string');
      if (!valid) throw new Error('invalid-suggestion-response');
      const ids=payload.selections.flatMap(selection=>selection.unitIds);
      if (ids.length>3 || new Set(ids).size!==ids.length) throw new Error('invalid-suggestion-response');
      return payload;
    },
    getCurrentPlan: async () => {
      const result=await getPlanDocument();
      if (isTaskPlan(result.candidate) || result.history.some(entry=>isTaskPlan(entry.after))) throw new Error('V2 计划需要使用任务型计划入口。');
      return result as CurrentPlanPayload;
    },
    applyTaskPlan: async (candidate,expectedRevision,operator='local') => {
      if (!supportsTaskPlanning(options.capabilities)) throw new Error('需要升级 Companion 以支持任务型计划。');
      const allocation=candidate.longTermAllocation;
      if(allocation?.practiceBudgetGroups!==undefined&&!options.capabilities?.includes('practice-budget-v1')){
        const health=await get<{capabilities?:unknown}>('/v1/health');
        if(!Array.isArray(health.capabilities)||!health.capabilities.includes('practice-budget-v1'))throw new Error('请更新并重启 Companion，再保存共享练习预算；当前安排和记录已保留。');
      }
      if(allocation&&(allocation.reviewTarget!==undefined||allocation.budgetMinutes!==undefined)&&!options.capabilities?.includes('daily-plan-policy-v1')){
        const health=await get<{capabilities?:unknown}>('/v1/health');
        if(!Array.isArray(health.capabilities)||!health.capabilities.includes('daily-plan-policy-v1'))throw new Error('请更新并重启 Companion，再保存包含每日复习目标的新计划；当前安排和记录已保留。');
      }
      const result=await mutation<TaskPlanV2>('/v1/plan/apply',{candidate:parseTaskPlan(candidate),expectedRevision,operator});
      if (result.revision?.after) result.revision.after=parseTaskPlan(result.revision.after);
      return result;
    },
    getConstraints: () => get<ConstraintDocument>("/v1/constraints"),
    saveConstraints: async (document) => {
      const { response, payload } = await post<ConstraintDocument & { message?: string }>("/v1/constraints", { constraints: document });
      if (!response.ok) throw new Error(errorMessage(payload, "学习约束保存失败。"));
      return payload;
    },
    getChanges: () => get<ChangeProjection>("/v1/changes"),
    scanChanges: async () => {
      const { response, payload } = await post<ChangeProjection & { message?: string }>("/v1/changes/scan", {});
      if (!response.ok) throw new Error(errorMessage(payload, "资料扫描失败。"));
      return payload;
    },
    decideChange: async (changeId, decision, operator = "local") => {
      const { response, payload } = await post<ChangeDecisionPayload>("/v1/changes/decide", { changeId, decision, operator });
      if (!response.ok) throw new Error(errorMessage(payload, "资料审批失败。"));
      return payload;
    },
    applyPlan: async (candidate, expectedRevision, operator = "local") => {
      if (isTaskPlan(candidate)) throw new Error('V2 计划必须通过任务型计划入口保存。');
      return mutation("/v1/plan/apply", { candidate, expectedRevision, operator });
    },
    /** AI 计划编排：确定性条目集合不变，仅返回优先级重排结果。 */
    aiReorderPlan: async <T extends { itemKey: string }>(items: T[]) => {
      const { response, payload } = await post<{ items?: T[]; message?: string }>("/v1/plan/ai-reorder", { items });
      if (!response.ok || !payload.items) throw new Error(payload.message || "AI 编排失败。");
      return payload.items;
    },
    rejectPlan: (candidateHash, reason = "", operator = "local") => mutation("/v1/plan/reject", { candidateHash, reason, operator }),
    restorePlan: (target, expectedRevision, operator = "local") => mutation("/v1/plan/restore", { target, expectedRevision, operator }),
    getCaptures: () => get<CapturePayload>("/v1/capture"),
    getPractice: () => get<{ items: PracticeItem[] }>("/v1/practice"),
    gradePractice: async (item, answer) => {
      const { response, payload } = await post<PracticeGrade & { message?: string }>("/v1/practice/grade", { item, answer });
      if (!response.ok) throw new Error(errorMessage(payload, "判题失败。"));
      return payload;
    },
    variantPractice: async (item, attempt) => {
      const { response, payload } = await post<{ item: PracticeItem } & { message?: string }>("/v1/practice/variant", { item, attempt });
      if (!response.ok) throw new Error(errorMessage(payload, "变式生成失败。"));
      return payload;
    },
    initSources: async () => {
      const { response, payload } = await post<SourcesInitPayload & { message?: string }>("/v1/sources/init", {});
      if (!response.ok) throw new Error(errorMessage(payload, "资源目录初始化失败。"));
      return payload;
    },
  };
}
