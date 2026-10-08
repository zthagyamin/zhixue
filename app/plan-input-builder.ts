import type { CloudFSRSData } from "./cloud-sync-types";
import type { DailyPlanningInput } from './task-plan-types';
import type { PlanInput } from "./daily-plan";
import type { PracticeItem } from "./companion-plan-client";
import type { VocabServe } from "./vocab-pacing";
import type { DynamicStudyItem, DynamicSubject } from "./dynamic-ui-model";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { isCarriedGroup, resolvePlanPractice, studySubjectsWithPractice } from "./plan-runtime.ts";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { stableStudyItemKey } from "./dynamic-ui-model.ts";
// @ts-expect-error TS5097: Node tests require explicit TypeScript extension.
import { isVocabularySubject } from './plugin-routing.ts';

// v0.8: assembles a deterministic PlanInput from browser-local review
// projections and the study-loop source-area subjects.

export type SourceSubject = {
  id: string;
  name: string;
  domain?: string;
  pluginType?: DynamicSubject['pluginType'];
  items: DynamicStudyItem[];
  /** 背词科目按组入池时使用：每组词数（默认 20）。 */
  groupQuota?: number;
  sourceMode?: 'gateway';
  identity?: 'scoped' | 'legacy';
};

export type PlanConstraints = PlanInput["constraints"];
export type PlanDeadline = PlanInput["deadlines"][number];

export type StoredPlanSettings = {
  constraints: PlanConstraints;
  deadlines: PlanDeadline[];
};

export const defaultPlanSettings: StoredPlanSettings = {
  constraints: {
    dailyMinutes: { min: 30, max: 60, source: "system" },
    minReviewMinutes: 15,
    loadFactor: 0.9,
  },
  deadlines: [],
};

/** V2 has no implicit time ceiling; legacy defaults remain legacy-only. */
export function buildTaskPlanningInput(options:DailyPlanningInput):DailyPlanningInput {
  return structuredClone(options);
}

/** Cloud v3 projections are authoritative for due state; local fsrs fills gaps. */
export function mergeFsrsSources(
  local: Record<string, CloudFSRSData> | undefined,
  cloud: Array<{ itemKey: string; fsrs: CloudFSRSData }> | undefined,
): Record<string, CloudFSRSData> {
  const merged = { ...(local ?? {}) };
  for (const item of cloud ?? []) {
    if (item.itemKey && item.fsrs) merged[item.itemKey] = item.fsrs;
  }
  return merged;
}

export type BuildPlanInputOptions = {
  day: string;
  fsrsData?: Record<string, CloudFSRSData>;
  subjects: SourceSubject[];
  sourceSubjectIds?: string[];
  constraints?: Partial<PlanInput["constraints"]>;
  deadlines?: PlanInput["deadlines"];
  duePractice?: PracticeItem[];
  itemStages?: Record<string, number>;
  previousServe?: VocabServe;
  previousServes?: Record<string, VocabServe | undefined>;
};

const DEFAULT_REVIEW_MINUTES = 2;
const DAY_MS = 86_400_000;

export function domainForItemKey(itemKey: string, fallback?: string): PlanInput["dueReviews"][number]["domain"] {
  if (fallback) return fallback;
  if (itemKey.startsWith("python:")) return "python";
  if (itemKey.startsWith("due:") || itemKey.startsWith("practice:")) return "differential-review";
  return "ielts";
}

export function buildPlanInput(options: BuildPlanInputOptions): PlanInput {
  const today = new Date(`${options.day}T00:00:00.000Z`).getTime();
  const subjects = studySubjectsWithPractice(options.subjects.map(subject => ({
    ...subject, pluginType: subject.pluginType ?? (subject.id === 'ielts-vocabulary' ? 'three-stage' : 'flashcard'),
  })), options.duePractice ?? []);
  const dueReviews: PlanInput['dueReviews'] = Object.entries(options.fsrsData ?? {})
    .filter(([key]) => !subjects.some(subject => subject.sourceMode === 'gateway') || subjects.some(subject => subject.items.some(item => stableStudyItemKey(item) === key)))
    .filter(([, fsrs]) => fsrs.due.slice(0, 10) <= options.day)
    .map(([itemKey, fsrs]) => {
      const due = new Date(fsrs.due).getTime();
      const overdueDays = Math.max(0, Math.round((today - due) / DAY_MS));
      const practice = resolvePlanPractice({kind:'review',itemKey,domain:domainForItemKey(itemKey),estimatedMinutes:2,reasons:[]}, subjects);
      const subject = subjects.find(source=>source.id === practice?.subjectId);
      return {
        itemKey,
        domain: domainForItemKey(itemKey, subject?.domain),
        dueAt: fsrs.due,
        stability: fsrs.stability,
        difficulty: fsrs.difficulty,
        overdueDays,
        estimatedMinutes: DEFAULT_REVIEW_MINUTES,
        ...(practice ? {practice} : {}),
      };
    })
    .sort((left, right) => left.itemKey.localeCompare(right.itemKey));

  const sourceIds = options.sourceSubjectIds ? new Set(options.sourceSubjectIds) : null;
  const practiceIds = new Set((options.duePractice ?? []).map(item => `practice:${item.itemId.replace(/^practice:/, '')}`));
  for (const item of options.duePractice ?? []) {
    const itemKey = `practice:${item.itemId.replace(/^practice:/, '')}`;
    if (dueReviews.some(review => review.itemKey === itemKey)) continue;
    const local = options.fsrsData?.[itemKey];
    if (local && local.due.slice(0,10) > options.day) continue;
    const dueAt = item.dueAt || `${options.day}T00:00:00.000Z`;
    const ref = resolvePlanPractice({kind:'review',itemKey,domain:item.domain,estimatedMinutes:2,reasons:[]},subjects);
    dueReviews.push({itemKey,domain:item.domain,dueAt,stability:0,difficulty:5,
      overdueDays:Math.max(0,Math.floor((today-Date.parse(dueAt))/DAY_MS)),
      estimatedMinutes:DEFAULT_REVIEW_MINUTES,title:item.sourceLabel || item.prompt,
      practice:ref ?? {kind:'question',subjectId:'',count:1,itemKeys:[itemKey],itemIds:[item.itemId]},
    });
  }
  const pool = subjects
    .filter((subject) => !sourceIds || sourceIds.has(subject.id))
    .flatMap((subject) => {
      // 背词科目：按组入池（一条=一组），计划条目可直达该组练习。
      if (isVocabularySubject(subject)) {
        const savedQuota = options.subjects.find(source => source.id === subject.id)?.groupQuota;
        const quota = Number.isInteger(savedQuota) && (savedQuota ?? 0) > 0 ? savedQuota! : 20;
        const usable = subject.items.filter((item) => item.word);
        const groups: Array<PlanInput["pool"][number]> = [];
        for (let start = 0; start < usable.length; start += quota) {
          const slice = usable.slice(start, start + quota);
          const groupIndex = Math.floor(start / quota);
          const stages = options.itemStages ?? {};
          if (slice.every(item => (stages[stableStudyItemKey(item) ?? ''] ?? (item.allowLegacyAliases !== false ? stages[`word:${item.word?.trim().toLowerCase()}`] : undefined) ?? 0) >= 3)) continue;
          const previousServe = options.previousServes?.[subject.id] ?? (subject.id === 'ielts-vocabulary' ? options.previousServe : undefined);
          groups.push({
            itemKey: `vocab-group:${subject.id}:${groupIndex}`,
            itemId: null,
            domain: subject.domain || "ielts",
            title: `背词第 ${groupIndex + 1} 组 · ${slice.length} 词`,
            estimatedMinutes: Math.max(5, slice.length),
            sourceRef: `source:${subject.id}`,
            approvedAt: "2026-08-24T00:00:00.000Z",
            practice: {
              kind: "vocab-group",
              subjectId: subject.id,
              count: slice.length,
              groupIndex,
              groupQuota: quota,
              itemKeys: slice.map((item) => stableStudyItemKey(item) ?? `word:${item.word}`).filter(Boolean),
              /** 由 dashboard 在生成时填充：该组是否包含前一日未完成词。 */
              carriedFromPreviousDay: previousServe ? isCarriedGroup(options.day,previousServe,groupIndex,slice,{itemStages:stages}) : false,
            },
          });
        }
        return groups;
      }
      // 题目科目：每题一条，带练习引用。
      return subject.items
        .filter((item) => !item.reviewOnly && (item.word || item.topic || item.prompt || item.front) && !practiceIds.has(stableStudyItemKey(item) ?? ''))
        .map((item) => {
          const title = String(item.word ?? item.topic ?? item.prompt ?? item.front ?? "");
          const itemKey = stableStudyItemKey(item) ?? `word:${title}`;
          return {
            itemKey,
            itemId: item.itemId ?? item.abilityId ?? null,
            domain: domainForItemKey(itemKey, typeof item.domain === 'string' ? item.domain : subject.domain),
            title,
            estimatedMinutes: DEFAULT_REVIEW_MINUTES,
            sourceRef: `source:${subject.id}`,
            approvedAt: "2026-08-24T00:00:00.000Z",
            practice: {
              kind: "question" as const,
              subjectId: subject.id,
              count: 1,
              itemKeys: [itemKey],
              itemIds: item.itemId ? [item.itemId] : undefined,
            },
          };
        });
    })
    .sort((left, right) => left.itemKey.localeCompare(right.itemKey));

  const defaults = {
    dailyMinutes: { min: 30, max: 60, source: "system" as const },
    minReviewMinutes: 15,
    loadFactor: 0.9,
  };
  const constraints = {
    ...defaults,
    ...options.constraints,
    dailyMinutes: {
      ...defaults.dailyMinutes,
      ...(options.constraints?.dailyMinutes ?? {}),
    },
  };

  return {
    day: options.day,
    constraints,
    dueReviews,
    deadlines: options.deadlines ?? [],
    pool,
  };
}
