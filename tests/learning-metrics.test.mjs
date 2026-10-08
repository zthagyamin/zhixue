import assert from "node:assert/strict";
import test from "node:test";
import { accuracyByKey, forecastDue, riskRanking } from "../app/learning-metrics.ts";

// 学习效果仪表盘的纯计算核心：到期预测按上海日历日分桶，记忆风险用
// FSRS 遗忘曲线估算，正确率从 v3 practice-attempt 事件聚合。

const NOW = new Date("2026-08-29T12:00:00+08:00");

test("forecast buckets items by Shanghai calendar day with an overdue count", () => {
  const result = forecastDue({
    fsrsData: {
      overdue: { due: "2026-08-28T23:00:00+08:00", stability: 5 },
      today: { due: "2026-08-29T08:00:00+08:00", stability: 5 },
      tomorrow: { due: "2026-08-30T09:00:00+08:00", stability: 5 },
      threeDays: { due: "2026-09-01T09:00:00+08:00", stability: 5 },
      beyond: { due: "2026-09-10T09:00:00+08:00", stability: 5 },
      noDue: { stability: 5 },
    },
    now: NOW,
  });

  assert.equal(result.overdue, 1);
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].count, 1);
  assert.equal(result.days[1].count, 1);
  assert.equal(result.days[3].count, 1);
  assert.equal(result.days.reduce((sum, day) => sum + day.count, 0), 3);
});

test("risk ranking estimates retrievability from the forgetting curve and skips unreviewed items", () => {
  const risks = riskRanking({
    fsrsData: {
      stale: { due: "2026-09-05T00:00:00+08:00", stability: 5, last_review: "2026-07-20T00:00:00+08:00" },
      fresh: { due: "2026-09-20T00:00:00+08:00", stability: 30, last_review: "2026-08-28T00:00:00+08:00" },
      neverReviewed: { due: "2026-08-29T12:00:00+08:00", stability: 5 },
      zeroStability: { due: "2026-09-05T00:00:00+08:00", stability: 0, last_review: "2026-07-20T00:00:00+08:00" },
    },
    now: NOW,
    limit: 5,
  });

  assert.deepEqual(risks.map((risk) => risk.key), ["stale", "fresh"]);
  assert.ok(risks[0].retrievability < 0.9, "40 天前复习、稳定度 5 的项应低于默认请求保留率 0.9");
  assert.ok(risks[1].retrievability > 0.9, "昨天复习、稳定度 30 的项应高于默认请求保留率 0.9");
});

test("risk ranking respects the limit", () => {
  const fsrsData = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `item-${index}`,
      { due: "2026-09-05T00:00:00+08:00", stability: 5, last_review: "2026-08-01T00:00:00+08:00" },
    ]),
  );

  assert.equal(riskRanking({ fsrsData, now: NOW, limit: 3 }).length, 3);
});

test("accuracy aggregates practice-attempt events per item key and ignores baselines", () => {
  const accuracy = accuracyByKey([
    { eventType: "practice-attempt", item: { key: "k1" }, attempt: { correct: true } },
    { eventType: "practice-attempt", item: { key: "k1" }, attempt: { correct: false } },
    { eventType: "practice-attempt", item: { key: "k2" }, attempt: { correct: true } },
    { eventType: "review-baseline", item: { key: "k3" } },
  ]);

  assert.deepEqual(accuracy.k1, { total: 2, correct: 1 });
  assert.deepEqual(accuracy.k2, { total: 1, correct: 1 });
  assert.equal(accuracy.k3, undefined);
});
