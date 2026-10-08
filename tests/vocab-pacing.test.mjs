import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOCAB_QUOTA,
  firstIncompleteGroup,
  resolveServedGroup,
  splitGroupBounds,
} from "../app/vocab-pacing.ts";

// 词库分组与每日配额（默认 20 词/组、20 词/天）：当天固定服务同一组，
// 跨天自动推进到第一个未完成组；用户可手动选组或改配额（自由化）。

test("splitGroupBounds slices the library into quota-sized groups", () => {
  const bounds = splitGroupBounds(131, 20);
  assert.equal(bounds.length, 7);
  assert.deepEqual(bounds[0], { start: 0, end: 20 });
  assert.deepEqual(bounds[6], { start: 120, end: 131 });
  assert.equal(DEFAULT_VOCAB_QUOTA, 20);
});

test("quota larger than the library yields a single group; non-positive quota falls back to default", () => {
  assert.deepEqual(splitGroupBounds(12, 50), [{ start: 0, end: 12 }]);
  assert.deepEqual(splitGroupBounds(131, 0), splitGroupBounds(131, DEFAULT_VOCAB_QUOTA));
});

test("firstIncompleteGroup picks the first group containing an unfinished word", () => {
  const bounds = splitGroupBounds(60, 20);
  const completed = new Set(Array.from({ length: 20 }, (_, i) => i).concat([20, 21])); // 第一组全部完成、第二组部分完成
  assert.equal(firstIncompleteGroup(bounds, (index) => completed.has(index)), 1);
});

test("an all-complete library resolves to the last group", () => {
  const bounds = splitGroupBounds(40, 20);
  assert.equal(firstIncompleteGroup(bounds, () => true), 1);
});

test("the served group is fixed for the same Shanghai day and rolls over the next day", () => {
  const saved = { dayKey: "2026-08-30", group: 2 };
  assert.equal(resolveServedGroup({ todayKey: "2026-08-30", saved, firstIncomplete: 4, override: null, groupCount: 7 }), 2);
  assert.equal(resolveServedGroup({ todayKey: "2026-08-31", saved, firstIncomplete: 4, override: null, groupCount: 7 }), 4);
});

test("a manual group override wins over both the saved day state and auto advance", () => {
  const saved = { dayKey: "2026-08-30", group: 0 };
  assert.equal(resolveServedGroup({ todayKey: "2026-08-30", saved, firstIncomplete: 0, override: 5, groupCount: 7 }), 5);
  // 越界的选择收敛到合法区间。
  assert.equal(resolveServedGroup({ todayKey: "2026-08-30", saved, firstIncomplete: 0, override: 99, groupCount: 7 }), 6);
  assert.equal(resolveServedGroup({ todayKey: "2026-08-30", saved, firstIncomplete: 0, override: -3, groupCount: 7 }), 0);
});
