import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanInput, mergeFsrsSources } from "../app/plan-input-builder.ts";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { generateDailyPlan } from "../app/daily-plan.ts";

function fsrs(due, overrides = {}) {
  return {
    due,
    stability: 2.3,
    difficulty: 4.7,
    elapsed_days: 0,
    scheduled_days: 2,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    ...overrides,
  };
}

test("fsrsData maps to due reviews with overdue days", () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    fsrsData: {
      "word:alpha": fsrs("2026-08-20T00:00:00.000Z"),
      "word:beta": fsrs("2026-08-25T00:00:00.000Z"),
      "word:gamma": fsrs("2026-08-30T00:00:00.000Z"),
    },
    subjects: [],
  });
  const dueKeys = input.dueReviews.map((review) => review.itemKey);
  assert.ok(dueKeys.includes("word:alpha"));
  assert.ok(dueKeys.includes("word:beta"));
  assert.ok(!dueKeys.includes("word:gamma"));
  assert.equal(input.dueReviews.find((review) => review.itemKey === "word:alpha").overdueDays, 5);
  assert.equal(input.dueReviews.find((review) => review.itemKey === "word:alpha").domain, "ielts");
});

test("the single vocabulary and reading subjects map to the learning pool", () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    subjects: [
      { id: "ielts-vocabulary", name: "IELTS 核心词汇", items: [{ word: "pooling layer", abilityId: "word:pooling-layer" }, { word: "facilitate", abilityId: "word:facilitate" }] },
      { id: "reading-comprehension", name: "阅读理解专项", items: [{ topic: "池化", abilityId: "topic:池化" }] },
    ],
    sourceSubjectIds: ["ielts-vocabulary", "reading-comprehension"],
  });
  const poolKeys = input.pool.map((item) => item.itemKey);
  // 背词科目按组入池（一条=一组）；题目每题一条。
  assert.ok(poolKeys.includes("vocab-group:ielts-vocabulary:0"));
  assert.ok(poolKeys.includes("topic:池化"));
  assert.equal(input.pool.find((item) => item.itemKey === "vocab-group:ielts-vocabulary:0").sourceRef, "source:ielts-vocabulary");
});

test("pool items carry the stable itemId when the subject provides one", () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    subjects: [
      {
        id: "reading-comprehension",
        name: "阅读理解专项",
        items: [
          { topic: "pooling layer", abilityId: "pooling-layer", itemId: "zhx-word-pooling" },
          { topic: "backprop", abilityId: "backprop-ability", itemId: "zhx-course-backprop" },
        ],
      },
    ],
    sourceSubjectIds: ["reading-comprehension"],
  });
  const byKey = Object.fromEntries(input.pool.map((item) => [item.itemKey, item]));
  // itemId passes through from the snapshot subject.
  assert.equal(byKey["practice:zhx-word-pooling"].itemId, "zhx-word-pooling");
  assert.equal(byKey["practice:zhx-course-backprop"].itemId, "zhx-course-backprop");
  // Without itemId the abilityId is the fallback, never undefined.
  assert.ok(input.pool.every((item) => item.itemId !== undefined));
});

test("default constraints apply and user overrides win", () => {
  const input = buildPlanInput({ day: "2026-08-25", subjects: [] });
  assert.equal(input.constraints.dailyMinutes.source, "system");
  assert.equal(input.constraints.loadFactor, 0.9);
  const overridden = buildPlanInput({
    day: "2026-08-25",
    subjects: [],
    constraints: { dailyMinutes: { min: 10, max: 20, source: "user" }, minReviewMinutes: 5, loadFactor: 0.8 },
  });
  assert.equal(overridden.constraints.dailyMinutes.max, 20);
  assert.equal(overridden.constraints.dailyMinutes.source, "user");
  assert.equal(overridden.constraints.loadFactor, 0.8);
});

test("the built input feeds generateDailyPlan deterministically", async () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    fsrsData: { "word:alpha": fsrs("2026-08-20T00:00:00.000Z") },
    subjects: [{ id: "study-loop-sources", name: "知学资料·词汇", items: [{ word: "pooling layer", abilityId: "word:pooling-layer" }] }],
    sourceSubjectIds: ["study-loop-sources"],
  });
  const first = await generateDailyPlan(input);
  const second = await generateDailyPlan(input);
  assert.deepEqual(first, second);
  assert.equal(first.items[0].kind, "overdue");
  assert.ok(first.items.some((item) => item.itemKey === "word:pooling-layer"));
});

test("python and due domains are inferred from item keys", () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    fsrsData: {
      "python:loops": fsrs("2026-08-24T00:00:00.000Z"),
      "due:review-1": fsrs("2026-08-24T00:00:00.000Z"),
    },
    subjects: [],
  });
  const domains = Object.fromEntries(input.dueReviews.map((review) => [review.itemKey, review.domain]));
  assert.equal(domains["python:loops"], "python");
  assert.equal(domains["due:review-1"], "differential-review");
});

test("deadlines pass through into the plan input", () => {
  const deadlines = [
    { date: "2026-08-27", title: "考试", priority: 5, scopeRef: "exam-1" },
  ];
  const input = buildPlanInput({ day: "2026-08-25", subjects: [], deadlines });
  assert.deepEqual(input.deadlines, deadlines);
  const without = buildPlanInput({ day: "2026-08-25", subjects: [] });
  assert.deepEqual(without.deadlines, []);
});

test("cloud projections override local fsrs and local fills gaps", () => {
  const merged = mergeFsrsSources(
    { "word:local": fsrs("2026-08-24T00:00:00.000Z"), "word:both": fsrs("2026-08-24T00:00:00.000Z") },
    [
      { itemKey: "word:both", fsrs: fsrs("2026-08-22T00:00:00.000Z") },
      { itemKey: "word:cloud-only", fsrs: fsrs("2026-08-21T00:00:00.000Z") },
    ],
  );
  assert.equal(merged["word:both"].due, "2026-08-22T00:00:00.000Z");
  assert.equal(merged["word:local"].due, "2026-08-24T00:00:00.000Z");
  assert.equal(merged["word:cloud-only"].due, "2026-08-21T00:00:00.000Z");
  assert.deepEqual(mergeFsrsSources(undefined, undefined), {});
});

test("pool items carry their declared domain instead of prefix guessing", () => {
  const input = buildPlanInput({
    day: "2026-08-25",
    subjects: [
      {
        id: "results",
        name: "学习结果",
        items: [
          { word: "归一化", abilityId: "norm-purpose", itemId: "cs231n-l6-norm", domain: "course" },
          { word: "pooling", abilityId: "word:pooling", itemId: "zhx-word-pooling", domain: "ielts" },
        ],
      },
    ],
    sourceSubjectIds: ["results"],
  });
  const byKey = Object.fromEntries(input.pool.map((i) => [i.itemKey, i]));
  assert.equal(byKey["norm-purpose"].domain, "course");
  assert.equal(byKey["word:pooling"].domain, "ielts");
});

test("vocabulary subjects enter the pool as one group-level practice item", () => {
  const words = Array.from({ length: 45 }, (_, index) => ({ word: "w" + index, abilityId: "word:w" + index }));
  const input = buildPlanInput({
    day: "2026-08-30",
    subjects: [
      { id: "ielts-vocabulary", name: "IELTS 核心词汇", items: words },
      { id: "reading-comprehension", name: "阅读理解专项", items: [{ topic: "[AlexNet] 主旨", abilityId: "topic:main-idea" }, { topic: "[AlexNet] ReLU", abilityId: "topic:relu" }] },
    ],
    sourceSubjectIds: ["ielts-vocabulary", "reading-comprehension"],
  });

  // 词汇：一条组级条目（45 词 → 3 组），引用分组方式与每组词数
  const vocabGroup = input.pool.filter((item) => item.itemKey.startsWith("vocab-group:"));
  assert.equal(vocabGroup.length, 3);
  assert.equal(vocabGroup[0].itemKey, "vocab-group:ielts-vocabulary:0");
  assert.equal(vocabGroup[0].practice.kind, "vocab-group");
  assert.equal(vocabGroup[0].practice.count, 20);
  assert.ok(Array.isArray(vocabGroup[0].practice.itemKeys));

  // 阅读题：每题一条，可直接练习
  const reading = input.pool.filter((item) => item.itemKey.startsWith("topic:"));
  assert.equal(reading.length, 2);
  assert.equal(reading[0].practice.kind, "question");
});
