// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay} from '../src/domain/planning/index.ts';
// 学习效果仪表盘的纯计算核心（主旨三：一切为了高效学习）。从既有
// FSRS 状态（ts-fsrs Card 的序列化形态）与 v3 practice-attempt 事件推导
// 到期预测、记忆风险与正确率，不改变任何调度权威。

import { forgetting_curve, FSRS6_DEFAULT_DECAY } from "ts-fsrs";

type FSRSDataLike = {
  due?: string;
  stability?: number;
  last_review?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function shanghaiDayKey(date: Date): string {
  return studyDay(date.toISOString());
}

function shanghaiDayStart(date: Date): number {
  if(!Number.isFinite(date.valueOf()))return NaN;
  const [year, month, day] = shanghaiDayKey(date).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export type DueForecastDay = { dayOffset: number; dateLabel: string; count: number };

export type DueForecast = {
  overdue: number;
  days: DueForecastDay[];
};

// 未来 N 天到期预测：overdue 是今天之前的欠账；days[0] 是今天。
export function forecastDue({
  fsrsData,
  now,
  days = 7,
}: {
  fsrsData: Record<string, FSRSDataLike>;
  now: Date;
  days?: number;
}): DueForecast {
  const todayStart = shanghaiDayStart(now);
  let overdue = 0;
  const buckets = Array.from({ length: days }, () => 0);

  for (const entry of Object.values(fsrsData)) {
    if (!entry?.due) continue;
    const dueDay = shanghaiDayStart(new Date(entry.due));
    if (Number.isNaN(dueDay)) continue;
    const dayOffset = Math.round((dueDay - todayStart) / DAY_MS);
    if (dayOffset < 0) {
      overdue += 1;
    } else if (dayOffset < days) {
      buckets[dayOffset] += 1;
    }
  }

  return {
    overdue,
    days: buckets.map((count, dayOffset) => {
      const date = new Date(todayStart + dayOffset * DAY_MS);
      const [, month, day] = shanghaiDayKey(date).split("-");
      return { dayOffset, dateLabel: `${Number(month)}/${Number(day)}`, count };
    }),
  };
}

export type ItemRisk = { key: string; retrievability: number };

// 记忆风险排行：保留率 = FSRS 遗忘曲线(衰减, 距上次复习天数, 稳定度)，
// 升序排列（保留率最低 = 最危险）。没有复习记录或稳定度的项不参与。
export function riskRanking({
  fsrsData,
  now,
  limit = 5,
}: {
  fsrsData: Record<string, FSRSDataLike>;
  now: Date;
  limit?: number;
}): ItemRisk[] {
  const nowMs = now.getTime();
  const risks: ItemRisk[] = [];

  for (const [key, entry] of Object.entries(fsrsData)) {
    if (!entry?.last_review || !entry.stability || entry.stability <= 0) continue;
    const lastReview = new Date(entry.last_review).getTime();
    if (Number.isNaN(lastReview)) continue;
    const elapsedDays = Math.max(0, (nowMs - lastReview) / DAY_MS);
    const retrievability = forgetting_curve(FSRS6_DEFAULT_DECAY, elapsedDays, entry.stability);
    if (!Number.isFinite(retrievability)) continue;
    risks.push({ key, retrievability });
  }

  return risks
    .sort((a, b) => a.retrievability - b.retrievability)
    .slice(0, Math.max(0, limit));
}

export type ItemAccuracy = { total: number; correct: number };

// 按 item key 聚合作答正确率；review-baseline 等无 attempt 的事件跳过。
export function accuracyByKey(
  events: readonly {
    eventType?: string;
    item?: { key?: string };
    attempt?: { correct?: boolean };
  }[],
): Record<string, ItemAccuracy> {
  const accuracy: Record<string, ItemAccuracy> = {};

  for (const event of events) {
    if (event?.eventType !== "practice-attempt") continue;
    const key = event.item?.key;
    if (!key) continue;
    const current = accuracy[key] || { total: 0, correct: 0 };
    current.total += 1;
    if (event.attempt?.correct) current.correct += 1;
    accuracy[key] = current;
  }

  return accuracy;
}
