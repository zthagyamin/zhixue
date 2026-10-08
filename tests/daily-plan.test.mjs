import assert from "node:assert/strict";
import test from "node:test";

import { generateDailyPlan } from "../app/daily-plan.ts";

function baseInput(overrides = {}) {
  return {
    day: "2026-08-25",
    constraints: {
      dailyMinutes: { min: 30, max: 60, source: "system" },
      minReviewMinutes: 15,
      loadFactor: 0.9,
    },
    dueReviews: [],
    deadlines: [],
    pool: [],
    ...overrides,
  };
}

function due(itemKey, overrides = {}) {
  return { itemKey, domain: "ielts", dueAt: "2026-08-25T00:00:00.000Z", stability: 2, difficulty: 5, overdueDays: 0, ...overrides };
}

function poolItem(itemKey, overrides = {}) {
  return { itemKey, domain: "ielts", title: itemKey, estimatedMinutes: 10, sourceRef: `ref:${itemKey}`, approvedAt: "2026-08-24T00:00:00.000Z", ...overrides };
}

test("same input produces the same candidate and plan hash", async () => {
  const input = baseInput({ dueReviews: [due("w1")], pool: [poolItem("p1")] });
  const first = await generateDailyPlan(input);
  const second = await generateDailyPlan(input);
  assert.deepEqual(first, second);
  assert.match(first.planHash, /^[0-9a-f]{64}$/);
});

test("changing any input changes the plan hash", async () => {
  const input = baseInput({ dueReviews: [due("w1")] });
  const base = (await generateDailyPlan(input)).planHash;
  assert.notEqual((await generateDailyPlan(baseInput({ dueReviews: [due("w1", { overdueDays: 2 })] }))).planHash, base);
  assert.notEqual((await generateDailyPlan(baseInput({ day: "2026-08-26", dueReviews: [due("w1")] }))).planHash, base);
});

test("overdue reviews are scheduled before due reviews and study items", async () => {
  const input = baseInput({
    dueReviews: [
      due("due-word", { overdueDays: 0 }),
      due("overdue-word", { overdueDays: 3 }),
    ],
    pool: [poolItem("new-word")],
  });
  const candidate = await generateDailyPlan(input);
  assert.deepEqual(candidate.items.map((item) => item.itemKey), ["overdue-word", "due-word", "new-word"]);
  assert.deepEqual(candidate.items.map((item) => item.kind), ["overdue", "review", "study"]);
});

test("high-risk due reviews are never displaced by study items, even when overloaded", async () => {
  const input = baseInput({
    constraints: { dailyMinutes: { min: 10, max: 20, source: "system" }, minReviewMinutes: 10, loadFactor: 0.9 },
    dueReviews: [due("big-review", { estimatedMinutes: 25 })],
  });
  const candidate = await generateDailyPlan(input);
  assert.ok(candidate.items.some((item) => item.itemKey === "big-review"));
});

test("study items beyond capacity are skipped without marking the plan overloaded", async () => {
  const input = baseInput({
    constraints: { dailyMinutes: { min: 10, max: 30, source: "system" }, minReviewMinutes: 5, loadFactor: 0.5 },
    dueReviews: [due("review-a", { estimatedMinutes: 10 })],
    pool: [poolItem("study-a", { estimatedMinutes: 5 }), poolItem("study-b", { estimatedMinutes: 5 })],
  });
  const candidate = await generateDailyPlan(input);
  assert.equal(candidate.overloaded, false);
  assert.ok(candidate.items.some((item) => item.itemKey === "study-a"));
  assert.deepEqual(candidate.skipped.map((item) => item.itemKey), ["study-b"]);
  assert.equal(candidate.skipped[0].reason, "超出当日负荷");
});

test("required reviews that exceed capacity mark the plan overloaded", async () => {
  const input = baseInput({
    constraints: { dailyMinutes: { min: 10, max: 20, source: "system" }, minReviewMinutes: 10, loadFactor: 0.5 },
    dueReviews: [due("big-review", { estimatedMinutes: 15 })],
  });
  const candidate = await generateDailyPlan(input);
  assert.equal(candidate.overloaded, true);
  assert.ok(candidate.items.some((item) => item.itemKey === "big-review"));
});

test("user-locked daily minutes take effect and differ from system estimate", async () => {
  const system = await generateDailyPlan(baseInput({
    constraints: { dailyMinutes: { min: 30, max: 60, source: "system" }, minReviewMinutes: 10, loadFactor: 0.9 },
    pool: [poolItem("p1", { estimatedMinutes: 40 })],
  }));
  const user = await generateDailyPlan(baseInput({
    constraints: { dailyMinutes: { min: 10, max: 20, source: "user" }, minReviewMinutes: 10, loadFactor: 0.9 },
    pool: [poolItem("p1", { estimatedMinutes: 40 })],
  }));
  assert.ok(system.items.some((item) => item.itemKey === "p1"));
  assert.ok(user.skipped.some((item) => item.itemKey === "p1"));
  assert.notEqual(user.planHash, system.planHash);
});

test("weekly rhythm changes weekend capacity", async () => {
  const weekend = await generateDailyPlan(baseInput({
    day: "2026-08-30", // Sunday
    constraints: {
      dailyMinutes: { min: 30, max: 60, source: "system" },
      weeklyRhythm: { workdayMinutes: 60, weekendMinutes: 30 },
      minReviewMinutes: 5,
      loadFactor: 0.9,
    },
    pool: [poolItem("p1", { estimatedMinutes: 40 })],
  }));
  const workday = await generateDailyPlan(baseInput({
    day: "2026-08-31", // Monday
    constraints: {
      dailyMinutes: { min: 30, max: 60, source: "system" },
      weeklyRhythm: { workdayMinutes: 60, weekendMinutes: 30 },
      minReviewMinutes: 5,
      loadFactor: 0.9,
    },
    pool: [poolItem("p1", { estimatedMinutes: 40 })],
  }));
  assert.ok(weekend.skipped.some((item) => item.itemKey === "p1"));
  assert.ok(workday.items.some((item) => item.itemKey === "p1"));
  assert.notEqual(weekend.planHash, workday.planHash);
});

test("a near deadline explains priority and moves study items earlier within their class", async () => {
  const without = await generateDailyPlan(baseInput({ pool: [poolItem("p1")] }));
  const withDeadline = await generateDailyPlan(baseInput({
    day: "2026-08-25",
    deadlines: [{ date: "2026-08-27", title: "考试", priority: 5 }],
    pool: [poolItem("p1")],
  }));
  assert.ok(withDeadline.items[0].reasons.some((reason) => reason.includes("临近截止")));
  assert.notEqual(withDeadline.planHash, without.planHash);
});

test("scoped deadline promotes only the matching domain", async () => {
  const candidate = await generateDailyPlan(baseInput({
    deadlines: [{ date: "2026-08-27", title: "Python 课程截止", priority: 5, scopeRef: "python" }],
    pool: [
      poolItem("english-item", { domain: "ielts", sourceRef: "source:english" }),
      poolItem("python-item", { domain: "python", sourceRef: "source:python" }),
    ],
  }));
  const python = candidate.items.find((item) => item.itemKey === "python-item");
  const english = candidate.items.find((item) => item.itemKey === "english-item");
  assert.ok(python.reasons.some((reason) => reason.includes("Python 课程截止")));
  assert.ok(!english.reasons.some((reason) => reason.includes("截止")));
  assert.deepEqual(candidate.items.filter((item) => item.kind === "study").map((item) => item.itemKey), ["python-item", "english-item"]);
});

test("deadline scope matches source, exact key, and item-key prefix", async () => {
  const candidate = await generateDailyPlan(baseInput({
    deadlines: [
      { date: "2026-08-28", title: "来源任务", priority: 3, scopeRef: "source:paper" },
      { date: "2026-08-27", title: "单项任务", priority: 4, scopeRef: "word:exact" },
      { date: "2026-08-26", title: "Python 前缀任务", priority: 5, scopeRef: "python:" },
    ],
    pool: [
      poolItem("word:from-paper", { sourceRef: "source:paper" }),
      poolItem("word:exact"),
      poolItem("python:loops", { domain: "python" }),
      poolItem("unmatched"),
    ],
  }));
  assert.ok(candidate.items.find((item) => item.itemKey === "word:from-paper").reasons.some((reason) => reason.includes("来源任务")));
  assert.ok(candidate.items.find((item) => item.itemKey === "word:exact").reasons.some((reason) => reason.includes("单项任务")));
  assert.ok(candidate.items.find((item) => item.itemKey === "python:loops").reasons.some((reason) => reason.includes("Python 前缀任务")));
  assert.ok(!candidate.items.find((item) => item.itemKey === "unmatched").reasons.some((reason) => reason.includes("截止")));
});

test("changing only deadline scope changes the canonical plan hash", async () => {
  const pool = [poolItem("python:item", { domain: "python" })];
  const global = await generateDailyPlan(baseInput({ deadlines: [{ date: "2026-08-27", title: "考试", priority: 5 }], pool }));
  const scoped = await generateDailyPlan(baseInput({ deadlines: [{ date: "2026-08-27", title: "考试", priority: 5, scopeRef: "python" }], pool }));
  assert.notEqual(global.planHash, scoped.planHash);
});

test("empty input yields an empty candidate with a stable hash", async () => {
  const candidate = await generateDailyPlan(baseInput());
  assert.deepEqual(candidate.items, []);
  assert.deepEqual(candidate.skipped, []);
  assert.equal(candidate.overloaded, false);
  assert.equal(candidate.totalMinutes, 0);
  assert.match(candidate.planHash, /^[0-9a-f]{64}$/);
});
