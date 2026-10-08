import type { CloudProgress } from "./cloud-sync-types";
import type { PlanCandidate } from "./daily-plan";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { filterPlanSubject } from './plan-runtime.ts';
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
export { selectEffectivePlan, resolvePlanPractice, selectPlannedPractice, isPlanEntryDone, isCarriedGroup } from './plan-runtime.ts';
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { isPluginType, pluginLabels, type PluginType } from "./plugin-routing.ts";

export type DynamicStudyItem = {
  learningSupport?:import('./learning-support').LearningSupport;
  id?: string;
  itemId?: string;
  abilityId?: string;
  word?: string;
  topic?: string;
  prompt?: string;
  pluginType?: PluginType;
  type?: PluginType;
  allowLegacyAliases?: boolean;
  [key: string]: unknown;
};

export type DynamicSubject = {
  id: string;
  name: string;
  pluginType: PluginType;
  domain?: string;
  items: DynamicStudyItem[];
  legacyIds?: string[];
  sourceMode?: 'gateway';
  identity?: 'scoped' | 'legacy';
  eventDomain?: string;
  groupQuota?: number;
};

export type ModuleSummary = {
  id: string;
  name: string;
  pluginType: PluginType;
  domain?: string;
  itemKeys: string[];
  lastSeenAt: string;
  todayCount: number;
  sourceMode?: 'gateway';
};

export type DynamicUiModel = {
  playableSubjects: DynamicSubject[];
  historicalModules: ModuleSummary[];
  currentPlanApplied: boolean;
  isCaughtUp: boolean;
};

export type ModuleProgressSummary = {
  evidenceCount: number;
  knownItemCount: number;
  todayCount: number;
  todayLabel: string;
  completionPercent: number | null;
};

export type ModulePresentation = {
  accent: "lime" | "orange" | "blue" | "sand";
  eyebrow: string;
  icon: string;
};

const SYSTEM_TABS = new Set(["today", "progress", "sources"]);

export function stableStudyItemKey(item: DynamicStudyItem): string | null {
  if(typeof item.accountItemKey==='string'&&item.accountItemKey.length>0)return item.accountItemKey;
  if (!item.word?.trim() && item.itemId?.trim()) return `practice:${item.itemId.trim().replace(/^practice:/, '')}`;
  if (item.abilityId?.trim()) return item.abilityId.trim();
  if (item.word?.trim()) return `word:${item.word.trim()}`;
  if (item.topic?.trim()) return `topic:${item.topic.trim()}`;
  if (item.itemId?.trim()) return item.itemId.trim();
  if (item.id?.trim()) return item.id.trim();
  return null;
}

function legacyWordKey(value: string): string {
  const word = value.includes("::") ? value.slice(value.lastIndexOf("::") + 2) : value.replace(/^word:/, "");
  return `word:${word.trim().toLocaleLowerCase("en-US")}`;
}

export function resolveStudyItemProgressKey(
  item: DynamicStudyItem,
  index: number,
  progress: Pick<CloudProgress, "itemStages" | "fsrsData">,
): string {
  if(typeof item.accountItemKey==='string'&&item.accountItemKey.length>0)return item.accountItemKey;
  const stable = stableStudyItemKey(item);
  const legacy = legacyWordKey(String(item.word || item.id || index));
  if (stable && (progress.itemStages[stable] !== undefined || progress.fsrsData?.[stable] !== undefined)) return stable;
  if (item.allowLegacyAliases !== false && (progress.itemStages[legacy] !== undefined || progress.fsrsData?.[legacy] !== undefined)) return legacy;
  return stable ?? legacy;
}

export function resolveEventAbilityId(
  item: DynamicStudyItem,
  index: number,
  progress: Pick<CloudProgress, "itemStages" | "fsrsData">,
): string {
  return item.abilityId?.trim() || resolveStudyItemProgressKey(item, index, progress);
}

export function normalizeDynamicSubjects(value: unknown): DynamicSubject[] {
  if (!Array.isArray(value)) return [];
  const subjects: DynamicSubject[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || !name || seenIds.has(id) || !isPluginType(raw.pluginType) || !Array.isArray(raw.items)) continue;
    const items = raw.items.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = { ...(entry as DynamicStudyItem) };
      if (raw.sourceMode === 'gateway') item.allowLegacyAliases = raw.identity === 'legacy';
      if (item.pluginType !== undefined && !isPluginType(item.pluginType)) delete item.pluginType;
      if (item.type !== undefined && !isPluginType(item.type)) delete item.type;
      if (!stableStudyItemKey(item)) item.itemId = `${id}:item-${index + 1}`;
      return [item];
    });
    seenIds.add(id);
    subjects.push({
      id,
      name,
      pluginType: raw.pluginType,
      ...(raw.sourceMode === 'gateway' ? {sourceMode:'gateway' as const,identity:raw.identity === 'legacy' ? 'legacy' as const : 'scoped' as const} : {}),
      ...(typeof raw.eventDomain === 'string' ? {eventDomain:raw.eventDomain} : {}),
      ...(typeof raw.groupQuota === 'number' ? {groupQuota:raw.groupQuota} : {}),
      legacyIds: Array.isArray(raw.legacyIds) ? raw.legacyIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [],
      ...(typeof raw.domain === "string" && raw.domain.trim() ? { domain: raw.domain.trim().slice(0, 80) } : {}),
      items,
    });
  }
  const canonical = new Map<string,DynamicSubject>();
  for(const raw of subjects) {
    const subject=canonicalQuestionModule(raw);
    const previous=canonical.get(subject.id);
    const legacyIds=[...new Set([subject.id,raw.id,...(raw.legacyIds??[])])];
    if(!previous) canonical.set(subject.id,{...subject,legacyIds});
    else {
      const keys=new Set(previous.items.map(item=>item.itemId || stableStudyItemKey(item)));
      previous.items.push(...subject.items.filter(item=>{const key=item.itemId || stableStudyItemKey(item); if(keys.has(key)) return false; keys.add(key); return true;}));
      previous.legacyIds=[...new Set([...(previous.legacyIds??[]),...legacyIds])];
    }
  }
  return [...canonical.values()];
}

// 已移除的科目不再进入目录；历史目录里残留的条目在下次合并时清退。
const REMOVED_SUBJECT_IDS = new Set(["approved-snapshots", "study-loop-sources", "study-loop-sources-quiz"]);

function canonicalQuestionModule<T extends {id:string;name:string;pluginType:PluginType;domain?:string;sourceMode?:string}>(module:T): T {
  if (module.sourceMode === 'gateway') return module;
  const legacyReading = !module.domain && ['核心概念理解','阅读理解专项'].includes(module.name);
  const legacyPaper = !module.domain && ['论文核心要点','论文核心观点'].includes(module.name);
  if(module.pluginType==='quiz' && (['ielts','paper'].includes(module.domain??'') || module.id==='reading-comprehension' || legacyReading)) return {...module,id:'reading-comprehension',name:'阅读理解专项',domain:'ielts'};
  if(module.pluginType==='recall' && (module.domain==='paper' || module.id==='paper-core-viewpoints' || legacyPaper)) return {...module,id:'paper-core-viewpoints',name:'论文核心观点',domain:'paper'};
  return module;
}

export function mergeModuleCatalog(
  catalog: ModuleSummary[],
  subjects: DynamicSubject[],
  seenAt: string,
  demoMode: boolean,
): ModuleSummary[] {
  if (demoMode) return catalog;
  const currentIds = new Set(subjects.filter((subject) => subject.items.length > 0).map((subject) => subject.id));
  const merged = new Map(catalog.map((module) => [module.id, { ...module, itemKeys: [...module.itemKeys], todayCount: 0 }]));
  for (const removed of REMOVED_SUBJECT_IDS) merged.delete(removed);

  for (const subject of subjects) {
    if (REMOVED_SUBJECT_IDS.has(subject.id)) continue;
    const previous = merged.get(subject.id);
    if (subject.items.length === 0 && !previous) continue;
    if (subject.items.length === 0) continue;
    const keys = subject.items.map(stableStudyItemKey).filter((key): key is string => Boolean(key));
    // 同名同域的旧目录条目折叠进当前科目（历次生成各建一个 id 的重复卡）。
    for (const [entryId, entry] of merged) {
      if (subject.sourceMode !== 'gateway' && entry.sourceMode !== 'gateway' && entryId !== subject.id && entry.name === subject.name && (entry.domain ?? "") === (subject.domain ?? "")) {
        keys.push(...entry.itemKeys);
        merged.delete(entryId);
      }
    }
    const combined = [...(previous?.itemKeys ?? []), ...keys];
    merged.set(subject.id, {
      id: subject.id,
      name: subject.name,
      pluginType: subject.pluginType,
      ...(subject.sourceMode ? {sourceMode:subject.sourceMode} : {}),
      ...(subject.domain ? { domain: subject.domain } : {}),
      itemKeys: [...new Set(combined)],
      lastSeenAt: seenAt,
      todayCount: subject.items.length,
    });
  }

  // 收尾折叠：目录里剩余的同族重复条目并成一条（并集 itemKeys，
  // lastSeenAt 取最新），保证历史重复卡随时间收敛。题组（quiz/recall）
  // 按"题型×领域"折叠——历次内容生成会为同族题目发明不同科目名。
  const foldKey = (module: ModuleSummary) => {
    if (module.sourceMode === 'gateway') return `gateway:${module.id}`;
    if (module.id === "reading-comprehension" || module.id === "paper-core-viewpoints") return module.id;
    return module.name + "::" + (module.domain ?? "");
  };
  const folded = new Map<string, ModuleSummary>();
  for (const raw of [...merged.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))) {
    const entry = canonicalQuestionModule(raw);
    const key = foldKey(entry);
    const kept = folded.get(key);
    if (!kept) {
      folded.set(key, { ...entry, itemKeys: [...entry.itemKeys] });
      continue;
    }
    kept.itemKeys = [...new Set([...kept.itemKeys, ...entry.itemKeys])];
    kept.todayCount += entry.todayCount;
  }

  return [...folded.values()].sort((left, right) => {
    const leftCurrent = currentIds.has(left.id) ? 1 : 0;
    const rightCurrent = currentIds.has(right.id) ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    return right.lastSeenAt.localeCompare(left.lastSeenAt) || left.name.localeCompare(right.name, "zh-CN");
  });
}

function filteredSubjectsForPlan(subjects: DynamicSubject[], plan: PlanCandidate): DynamicSubject[] {
  return subjects
    .map((subject) => ({ ...subject, items: filterPlanSubject(subject, plan, subjects) }))
    .filter((subject) => subject.items.length > 0);
}

export function buildDynamicUiModel(input: {
  subjects: DynamicSubject[];
  day: string;
  plan: PlanCandidate | null;
  catalog: ModuleSummary[];
  demoMode: boolean;
}): DynamicUiModel {
  const current = normalizeDynamicSubjects(input.subjects).filter((subject) => subject.items.length > 0);
  const planned = input.plan?.day === input.day ? filteredSubjectsForPlan(current, input.plan) : null;
  const playableSubjects = planned ?? current;
  const todayCounts = new Map(playableSubjects.map((subject) => [subject.id, subject.items.length]));
  const liveCatalog = mergeModuleCatalog(input.catalog, current, `${input.day}T00:00:00.000Z`, input.demoMode)
    .map((module) => ({ ...module, todayCount: todayCounts.get(module.id) ?? 0 }));

  return {
    playableSubjects,
    historicalModules: input.demoMode
      ? current.map((subject) => ({
          id: subject.id,
          name: subject.name,
          pluginType: subject.pluginType,
          ...(subject.domain ? { domain: subject.domain } : {}),
          itemKeys: subject.items.map(stableStudyItemKey).filter((key): key is string => Boolean(key)),
          lastSeenAt: `${input.day}T00:00:00.000Z`,
          todayCount: todayCounts.get(subject.id) ?? 0,
        }))
      : liveCatalog,
    currentPlanApplied: planned !== null,
    isCaughtUp: playableSubjects.length === 0,
  };
}

export function resolveDynamicTab(tab: string, playableSubjectIds: string[]): string {
  return SYSTEM_TABS.has(tab) || playableSubjectIds.includes(tab) ? tab : "today";
}

export function moduleProgressSummary(
  module: ModuleSummary,
  progress: Pick<CloudProgress, "itemStages">,
  todaySubject?: DynamicSubject,
): ModuleProgressSummary {
  const stages = module.itemKeys.map((key) => Math.max(
    progress.itemStages[key] ?? 0,
    progress.itemStages[key.startsWith("word:") ? key : `word:${key}`] ?? 0,
  ));
  const evidenceCount = stages.filter((stage) => stage > 0).length;
  const todayCount = todaySubject?.items.length ?? 0;
  const canComplete = todaySubject?.pluginType === "three-stage" && todaySubject.items.length > 0;
  const currentKeys = todaySubject?.items.map(stableStudyItemKey).filter((key): key is string => Boolean(key)) ?? [];
  const completedStages = currentKeys.reduce((sum, key) => sum + Math.min(3, Math.max(
    progress.itemStages[key] ?? 0,
    progress.itemStages[key.startsWith("word:") ? key : `word:${key}`] ?? 0,
  )), 0);

  return {
    evidenceCount,
    knownItemCount: module.itemKeys.length,
    todayCount,
    todayLabel: todayCount > 0 ? `今日 ${todayCount} 项` : "今日无任务",
    completionPercent: canComplete ? Math.round((completedStages / (currentKeys.length * 3)) * 100) : null,
  };
}

export function modulePresentation(subject: Pick<DynamicSubject, "name" | "pluginType" | "domain">): ModulePresentation {
  const trimmedName = subject.name.trim();
  const first = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(trimmedName)][0]?.segment || "学"
    : Array.from(trimmedName)[0] || "学";
  if (subject.domain === "paper") return { accent: "blue", eyebrow: pluginLabels[subject.pluginType], icon: first };
  if (subject.pluginType === "three-stage") return { accent: "lime", eyebrow: pluginLabels[subject.pluginType], icon: first };
  if (subject.pluginType === "code" || subject.pluginType === "calculation") {
    return { accent: "orange", eyebrow: pluginLabels[subject.pluginType], icon: first };
  }
  if (["quiz", "recall", "flashcard"].includes(subject.pluginType) && subject.domain && subject.domain !== "custom") {
    return { accent: subject.pluginType === "recall" ? "blue" : "lime", eyebrow: pluginLabels[subject.pluginType], icon: first };
  }
  return { accent: "sand", eyebrow: "学习内容", icon: first };
}
