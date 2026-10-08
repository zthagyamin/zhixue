import assert from "node:assert/strict";
import test from "node:test";

import { planDiff } from "../app/plan-diff.ts";

function candidate(items) {
  return {
    day: "2026-08-25",
    planHash: "h".repeat(64),
    items: items.map((itemKey) => ({ kind: "study", itemKey, domain: "ielts", estimatedMinutes: 2, reasons: ["当前学习主线"] })),
    totalMinutes: items.length * 2,
    overloaded: false,
    skipped: [],
  };
}

test("plan diff lists added and removed items", () => {
  const before = candidate(["keep", "remove-me"]);
  const after = candidate(["keep", "add-me"]);
  const diff = planDiff(after, before);
  assert.deepEqual(diff.added.map((item) => item.itemKey), ["add-me"]);
  assert.deepEqual(diff.removed.map((item) => item.itemKey), ["remove-me"]);
});

test("plan diff is empty when plans match", () => {
  const same = candidate(["a", "b"]);
  const diff = planDiff(same, same);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("plan diff handles a missing current plan as all-added", () => {
  const after = candidate(["a"]);
  const diff = planDiff(after, null);
  assert.deepEqual(diff.added.map((item) => item.itemKey), ["a"]);
  assert.deepEqual(diff.removed, []);
});
