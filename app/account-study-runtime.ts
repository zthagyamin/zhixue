import type {AccountStudyLoaded} from './account-study-client';
import type {StudyBundle,StudyItemVersion} from './account-study-content';
import type {CloudPlanningCatalogV1,CloudTaskPlanV1} from './account-study-planning';
import type {PlanningCatalog,TaskPlanV2} from './task-plan-types';
import type {PlanCandidate} from './daily-plan';
// @ts-expect-error TS5097: Node contract tests use explicit TypeScript extensions.
import {practicePlanForTask} from './task-plan-runtime.ts';
// @ts-expect-error TS5097: Node contract tests use explicit TypeScript extensions.
import {toEngineTaskPlan,toEnginePlanningCatalog} from './account-study-planning.ts';

export type AccountPlanState={day:string;revision:number;currentPlan:CloudTaskPlanV1|null;approvedPlan:CloudTaskPlanV1|null;approvedOperationId:string|null;decision:string};
export type AccountPlanSource={plan:TaskPlanV2;catalog:PlanningCatalog;cloud:CloudTaskPlanV1;cloudCatalog:CloudPlanningCatalogV1;bundle:StudyBundle};
export type TaskModuleScope={plan:TaskPlanV2;catalog:PlanningCatalog;subjectId:string;taskId?:string;groupTaskIds?:string[];adapter:PlanCandidate;accountSource?:AccountPlanSource};

/** IDs and hashes identify the displayed content; matching prose is only a legacy fallback. */
export function resolveAccountStudyItem(loaded:Pick<AccountStudyLoaded,'bundle'|'bundles'>,raw:unknown):{bundle:StudyBundle;item:StudyItemVersion} {
  const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  const snapshotId=typeof value.accountSnapshotId==='string'?value.accountSnapshotId:undefined;
  const key=typeof value.accountItemKey==='string'?value.accountItemKey:undefined;
  const id=typeof value.itemId==='string'?value.itemId:typeof value.id==='string'?value.id:undefined;
  const hash=typeof value.fingerprint==='string'?value.fingerprint:typeof value.contentHash==='string'?value.contentHash:undefined;
  const bundles=[...new Map([loaded.bundle,...loaded.bundles].filter(b=>b.snapshot.libraryId===loaded.bundle.snapshot.libraryId).map(b=>[b.snapshot.snapshotId,b])).values()];
  const pool=snapshotId?bundles.filter(b=>b.snapshot.snapshotId===snapshotId):bundles;
  if(!pool.length)throw new Error('本题快照尚未同步，请刷新账号题库后重试。');
  const identity=(item:StudyItemVersion)=>key!==undefined?item.itemKey===key:id!==undefined?(item.itemKey===id||item.kind==='practice'&&item.practice.itemId===id):
    typeof value.word==='string'&&item.kind==='word'?item.word.word===value.word:typeof value.prompt==='string'&&(item.kind==='practice'?item.practice.prompt===value.prompt:item.word.word===value.prompt);
  const identified=pool.flatMap(bundle=>bundle.items.filter(identity).map(item=>({bundle,item})));
  if(!identified.length)throw new Error('本题未同步到账号题库，请刷新资料后重试。');
  const matches=identified.filter(({item})=>hash===undefined||item.contentHash===hash);
  if(!matches.length)throw new Error('本题版本已变化，请退出当前题目并刷新账号题库。');
  const current=matches.filter(x=>x.bundle.snapshot.snapshotId===loaded.bundle.snapshot.snapshotId);
  const candidates=current.length?current:matches;
  const identities=new Set(candidates.map(({item})=>`${item.itemKey}\u0000${item.contentHash}`));
  if(identities.size!==1)throw new Error('匹配到多道题目，请从具体题目入口重新打开。');
  return [...candidates].sort((a,b)=>b.bundle.snapshot.revision-a.bundle.snapshot.revision)[0];
}

export async function prepareAccountPlanSource(loaded:AccountStudyLoaded,state:AccountPlanState,day:string):Promise<AccountPlanSource|null> {
  if(state.day!==day)throw new Error('账号计划日期不一致，请刷新。');
  if(!state.approvedPlan||!state.approvedOperationId)return null;
  const cloud=state.approvedPlan,cloudCatalog=loaded.catalogs.find(c=>c.catalogHash===cloud.catalogHash);
  if(cloud.day!==day||!cloudCatalog||cloudCatalog.libraryId!==loaded.bundle.snapshot.libraryId)throw new Error('计划依赖的账号目录尚未同步完整。');
  const bundle=loaded.bundles.find(b=>b.snapshot.snapshotId===cloudCatalog.snapshotId&&b.snapshot.libraryId===cloudCatalog.libraryId);
  if(!bundle)throw new Error('计划依赖的题库快照尚未同步完整。');
  const [plan,catalog]=await Promise.all([toEngineTaskPlan(cloud,cloudCatalog),toEnginePlanningCatalog(cloudCatalog)]);
  return {plan,catalog,cloud,cloudCatalog,bundle};
}

/** Plan display and direct module entry share the same task membership. */
export function resolveModuleTaskScope(input:{day:string;subjectId:string;active:TaskModuleScope|null;accountMode:boolean;
  approved:{plan:TaskPlanV2;catalog:PlanningCatalog}|null;local:{plan:TaskPlanV2;catalog:PlanningCatalog}|null;freeStudy:boolean}):TaskModuleScope|null {
  if(input.freeStudy)return null;
  const active=input.active;
  if(active?.plan.day===input.day&&active.subjectId===input.subjectId)return active;
  const source=input.accountMode?input.approved:input.local;
  if(!source||source.plan.day!==input.day)return null;
  const tasks=source.plan.tasks.filter(t=>t.subjectId===input.subjectId&&t.action.kind==='practice');
  if(!tasks.length)return null;
  const adapters=tasks.filter(t=>!t.blockedReason).map(t=>practicePlanForTask(source.plan,t.taskId,source.catalog));
  const adapter:PlanCandidate={day:source.plan.day,planHash:source.plan.planHash,inputHash:source.plan.inputHash,
    items:adapters.flatMap(a=>a.items),totalMinutes:0,overloaded:false,skipped:[]};
  return {...source,subjectId:input.subjectId,adapter};
}

/** Frozen plan content belongs only to a matching task, not the whole library. */
export function resolveAccountModuleSource(input:{day:string;subjectId:string;active:TaskModuleScope|null;
  approved:AccountPlanSource|null;freeStudy:boolean}):AccountPlanSource|null {
  const scope=resolveModuleTaskScope({...input,accountMode:true,local:null});
  return scope ? scope.accountSource??input.approved : null;
}

export function accountAiFailureMessage(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if(/cloud-ai-(disabled|unconfigured)/.test(message))return '账号云端 AI 尚未启用，请在今日账号计划的 AI 设置中配置。';
  if(/cloud-ai-unavailable|study-service-unavailable/.test(message))return '网站云端 AI 暂不可用，请稍后重试。';
  if(/budget|limit|quota/.test(message))return '账号 AI 今日额度或并发额度已用完，请稍后重试。';
  if(/cloud-ai-provider|timeout|fetch/i.test(message))return 'AI 服务连接失败，请稍后重试。';
  if(/[\u4e00-\u9fff]/.test(message))return message;
  return 'AI 判定暂不可用，请稍后重试。';
}
