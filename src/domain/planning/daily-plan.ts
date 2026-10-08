// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { canonicalizeJson } from "../evidence/index.ts";

// v0.8 deterministic daily-plan generator (spec §5).
// Pure function: identical input (including the explicit `day`) always yields
// the identical candidate, including `planHash`. Projection code never reads
// the current clock.

export type DailyMinutesSource = "system" | "user";

export type PlanInput = {
  day: string; // explicit date, never Date.now()
  constraints: {
    dailyMinutes: { min: number; max: number; source: DailyMinutesSource };
    weeklyRhythm?: { workdayMinutes: number; weekendMinutes: number };
    minReviewMinutes: number;
    loadFactor: number;
  };
  dueReviews: Array<{
    itemKey: string;
    domain: string;
    dueAt: string;
    stability: number;
    difficulty: number;
    overdueDays: number;
    estimatedMinutes?: number;
    practice?: PlanInput['pool'][number]['practice'];
    title?: string;
  }>;
  deadlines: Array<{ date: string; title: string; priority: number; scopeRef?: string }>;
  pool: Array<{
    itemKey: string;
    itemId: string | null;
    domain: string;
    title: string;
    estimatedMinutes: number;
    sourceRef: string;
    approvedAt: string;
    /** 计划条目直达练习：该条目对应的练习方式与内容范围。 */
    practice?: {
      kind: "vocab-group" | "question";
      subjectId: string;
      count: number;
      itemKeys: string[];
      itemIds?: string[];
      groupIndex?: number;
      groupQuota?: number;
      /** 组内含前一日未完成词时为 true（滚入标记）。 */
      carriedFromPreviousDay?: boolean;
    };
  }>;
};

export type PlanItemKind = "review" | "study" | "overdue" | "preview";

export type PlanCandidate = {
  day: string;
  planHash: string;
  inputHash?: string;
  capacityMinutes?: number;
  items: Array<{
    kind: PlanItemKind;
    itemKey: string;
    domain: string;
    estimatedMinutes: number;
    reasons: string[];
    title?: string;
    practice?: PlanInput['pool'][number]['practice'];
  }>;
  totalMinutes: number;
  overloaded: boolean;
  skipped: Array<{ itemKey: string; reason: string }>;
};

const DEFAULT_REVIEW_MINUTES = 2;
const DEADLINE_WINDOW_DAYS = 30;

function parseDay(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) throw new Error("invalid-plan-day");
  return parsed;
}

function isWeekend(day: string): boolean {
  const weekday = parseDay(day).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function effectiveMaxMinutes(input: PlanInput): number {
  const rhythm = input.constraints.weeklyRhythm;
  if (rhythm !== undefined) {
    return isWeekend(input.day) ? rhythm.weekendMinutes : rhythm.workdayMinutes;
  }
  return input.constraints.dailyMinutes.max;
}

type DeadlineItem = Pick<PlanInput["pool"][number], "itemKey" | "domain" | "sourceRef">;

export function deadlineScore(
  item: DeadlineItem,
  deadlines: PlanInput["deadlines"],
  day: string,
): { score: number; reason?: string } {
  const baseDay = parseDay(day).getTime();
  let best: { score: number; reason?: string } = { score: 0 };
  for (const deadline of deadlines) {
    if (!Number.isInteger(deadline.priority) || deadline.priority < 1 || deadline.priority > 5) continue;
    const days = Math.round((parseDay(deadline.date).getTime() - baseDay) / 86_400_000);
    if (days < 0 || days > DEADLINE_WINDOW_DAYS) continue;
    const scope = deadline.scopeRef?.trim() ?? "";
    const matches = !scope
      || scope === item.domain
      || scope === item.sourceRef
      || scope === item.itemKey
      || item.itemKey.startsWith(scope);
    if (!matches) continue;
    const score = deadline.priority * 100 + (DEADLINE_WINDOW_DAYS - days);
    if (score > best.score) {
      const scopeLabel = scope ? `范围 ${scope}` : "全局";
      best = { score, reason: `临近截止：${deadline.title}（${scopeLabel}，${days} 天）` };
    }
  }
  return best;
}

function dueReviewMinutes(review: PlanInput["dueReviews"][number]): number {
  return review.estimatedMinutes ?? DEFAULT_REVIEW_MINUTES;
}

function buildHashInput(input: PlanInput): unknown {
  return {
    day: input.day,
    constraints: {
      dailyMinutes: input.constraints.dailyMinutes,
      weeklyRhythm: input.constraints.weeklyRhythm,
      minReviewMinutes: input.constraints.minReviewMinutes,
      loadFactor: String(input.constraints.loadFactor),
    },
    dueReviews: input.dueReviews
      .map((review) => [review.itemKey, review.domain, review.dueAt, review.overdueDays, dueReviewMinutes(review)])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    deadlines: input.deadlines
      .map((deadline) => [deadline.date, deadline.title, deadline.priority, deadline.scopeRef ?? ""])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    pool: input.pool
      .map((item) => [item.itemKey, item.domain, item.sourceRef, item.estimatedMinutes, item.approvedAt])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generateDailyPlan(input: PlanInput): Promise<PlanCandidate> {
  const capacity = effectiveMaxMinutes(input) * input.constraints.loadFactor;
  // Required reviews: overdue first, then due-by-today, ordered by urgency.
  const required: PlanCandidate["items"] = input.dueReviews
    .filter((review) => review.overdueDays > 0 || review.dueAt.slice(0, 10) <= input.day)
    .map((review) => ({
      kind: review.overdueDays > 0 ? ("overdue" as const) : ("review" as const),
      itemKey: review.itemKey,
      domain: review.domain,
      estimatedMinutes: dueReviewMinutes(review),
      ...(review.practice ? {practice: review.practice} : {}),
      ...(review.title ? {title: review.title} : {}),
      reasons: [
        review.overdueDays > 0 ? `已逾期 ${review.overdueDays} 天` : "FSRS 到期复习",
      ],
    }))
    .sort((left, right) => {
      const urgency = (item: PlanCandidate["items"][number]) =>
        item.kind === "overdue" ? 0 : 1;
      if (urgency(left) !== urgency(right)) return urgency(left) - urgency(right);
      return left.itemKey.localeCompare(right.itemKey);
    });

  // Optional study items from the approved pool; near-deadline urgency moves
  // them earlier within their class.
  const optional: PlanCandidate["items"] = input.pool
    .map((item) => {
      const deadline = deadlineScore(item, input.deadlines, input.day);
      return {
        item: {
          kind: "study" as const,
          itemKey: item.itemKey,
          domain: item.domain,
          estimatedMinutes: item.estimatedMinutes,
          title: item.title,
          reasons: ["当前学习主线", ...(deadline.reason ? [deadline.reason] : [])],
          ...(item.practice ? { practice: item.practice } : {}),
        },
        deadlineScore: deadline.score,
      };
    })
    .sort((left, right) => {
      if (left.deadlineScore !== right.deadlineScore) return right.deadlineScore - left.deadlineScore;
      const carried = Number(Boolean(right.item.practice?.carriedFromPreviousDay)) - Number(Boolean(left.item.practice?.carriedFromPreviousDay));
      return carried || left.item.itemKey.localeCompare(right.item.itemKey, 'en', {numeric:true});
    })
    .map((entry) => entry.item);

  // Required reviews always enter; study items fill remaining capacity.
  const items = [...required];
  const skipped: PlanCandidate["skipped"] = [];
  let totalMinutes = required.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  for (const item of optional) {
    if (items.some((existing) => existing.itemKey === item.itemKey)) {
      const existing = items.find((existing) => existing.itemKey === item.itemKey)!;
      existing.practice ??= item.practice;
      continue;
    }
    if (totalMinutes + item.estimatedMinutes <= capacity) {
      items.push(item);
      totalMinutes += item.estimatedMinutes;
    } else {
      skipped.push({ itemKey: item.itemKey, reason: "超出当日负荷" });
    }
  }

  const inputHash = await sha256Hex(canonicalizeJson(buildHashInput(input)));
  return revisePlanCandidate({
    day: input.day,
    planHash: inputHash,
    inputHash,
    items,
    totalMinutes,
    overloaded: totalMinutes > capacity,
    capacityMinutes: capacity,
    skipped,
  }, items);
}

/** Preserve the deterministic input fingerprint; edited content gets its own identity. */
export async function revisePlanCandidate(candidate: PlanCandidate, items: PlanCandidate['items']): Promise<PlanCandidate> {
  const totalMinutes=items.reduce((sum,item)=>sum+item.estimatedMinutes,0);
  const inputHash=candidate.inputHash ?? candidate.planHash;
  const planHash=await sha256Hex(canonicalizeJson({day:candidate.day,inputHash,items,totalMinutes,capacityMinutes:String(candidate.capacityMinutes??'unknown')}));
  return {...candidate,inputHash,planHash,items,totalMinutes,overloaded:candidate.capacityMinutes===undefined ? candidate.overloaded && items.length>0 : totalMinutes>candidate.capacityMinutes};
}

export async function applyPlanGenerationMode(candidate: PlanCandidate, mode: 'ai'|'deterministic', reorder?: (items: PlanCandidate['items'])=>Promise<PlanCandidate['items']>): Promise<{candidate:PlanCandidate;message:string}> {
  if(mode==='deterministic') return {candidate,message:''};
  try {
    if(!reorder) throw new Error('请先连接并重启 Companion，配置 DeepSeek Key。');
    if(candidate.items.length===0) return {candidate,message:'今日无可编排条目，保留确定性计划。'};
    const result=await reorder(candidate.items);
    const byKey=new Map(candidate.items.map(item=>[item.itemKey,item]));
    if(!Array.isArray(result) || result.length!==candidate.items.length || new Set(result.map(item=>item?.itemKey)).size!==result.length || result.some(item=>!byKey.has(item?.itemKey))) throw new Error('AI 返回的排序不是原条目的完整排列。');
    const items=result.map(item=>byKey.get(item.itemKey)!);
    return {candidate:await revisePlanCandidate(candidate,items),message:'已按 AI 建议排序（条目集合仍由确定性引擎决定）。'};
  } catch(error) {
    return {candidate,message:`${error instanceof Error ? error.message : 'AI 编排失败。'} 已回退确定性调度。`};
  }
}
