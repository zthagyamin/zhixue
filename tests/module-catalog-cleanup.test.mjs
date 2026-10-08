import { readServerSource } from './helpers/server-source.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { mergeModuleCatalog } from "../app/dynamic-ui-model.ts";

// 模块目录是历史记录，不是垃圾场：已移除的科目（Codex 捕获、旧来源
// 科目）必须从目录中清退；同名同域的重复科目（历次生成各建一个 id）
// 折叠为一个，itemKeys 并集保留全部历史证据。

const REMOVED = ["approved-snapshots", "study-loop-sources", "study-loop-sources-quiz"];

test("removed subjects are dropped from the catalog even if previously recorded", () => {
  const catalog = REMOVED.map((id, index) => ({
    id,
    name: "旧科目 " + index,
    pluginType: "flashcard",
    domain: "ielts",
    itemKeys: ["k" + index],
    lastSeenAt: "2026-08-28T00:00:00.000Z",
    todayCount: 0,
  }));
  const merged = mergeModuleCatalog(catalog, [], "2026-08-30T00:00:00.000Z", false);
  assert.deepEqual(merged.map((m) => m.id), []);
});

test("removed subjects never re-enter the catalog from today's subjects", () => {
  const merged = mergeModuleCatalog(
    [],
    [{ id: "approved-snapshots", name: "Codex 已批准捕获", pluginType: "flashcard", domain: "mixed", items: [{ abilityId: "a1" }] }],
    "2026-08-30T00:00:00.000Z",
    false,
  );
  assert.deepEqual(merged, []);
});

test("same-name same-domain duplicate subjects fold into one with union item keys", () => {
  const catalog = [
    { id: "paper-points-1", name: "论文核心要点", pluginType: "recall", domain: "paper", itemKeys: ["old:key"], lastSeenAt: "2026-08-27T00:00:00.000Z", todayCount: 0 },
    { id: "paper-points-2", name: "论文核心要点", pluginType: "recall", domain: "paper", itemKeys: ["gen:key2"], lastSeenAt: "2026-08-28T00:00:00.000Z", todayCount: 0 },
  ];
  const merged = mergeModuleCatalog(
    catalog,
    [{ id: "paper-points-3", name: "论文核心要点", pluginType: "recall", domain: "paper", items: [{ abilityId: "new:key3" }] }],
    "2026-08-30T00:00:00.000Z",
    false,
  );

  const points = merged.filter((m) => m.name === "论文核心观点");
  assert.equal(points.length, 1);
  assert.ok(points[0].itemKeys.includes("old:key"));
  assert.ok(points[0].itemKeys.includes("gen:key2"));
  assert.ok(points[0].itemKeys.includes("new:key3"));
});

test("different-name modules are not folded together", () => {
  const catalog = [
    { id: "a", name: "阅读理解专项", pluginType: "quiz", domain: "ielts", itemKeys: [], lastSeenAt: "2026-08-28T00:00:00.000Z", todayCount: 0 },
  ];
  const merged = mergeModuleCatalog(
    catalog,
    [{ id: "b", name: "论文核心观点", pluginType: "recall", domain: "paper", items: [{ abilityId: "x" }] }],
    "2026-08-30T00:00:00.000Z",
    false,
  );

  assert.equal(merged.length, 2);
});

test("companion merges source vocabulary into the single word subject with word-text dedupe", async () => {
  const source = await readServerSource();
  assert.ok(source.includes("existing_words"), "按词形去重应存在");
  assert.ok(source.includes(String.fromCharCode(34) + "ielts-vocabulary" + String.fromCharCode(34)));
  assert.ok(source.includes(String.fromCharCode(34) + "reading-comprehension" + String.fromCharCode(34)));
  assert.ok(!source.includes("study-loop-sources-quiz"), "旧独立科目 id 不应再被构造");
});

test("same-family question subjects fold across invented names", () => {
  const catalog = [
    { id: "gen-1", name: "论文核心要点", pluginType: "recall", domain: "paper", itemKeys: ["old:a"], lastSeenAt: "2026-08-28T00:00:00.000Z", todayCount: 0 },
    { id: "gen-2", name: "核心概念理解", pluginType: "quiz", domain: "ielts", itemKeys: ["old:b"], lastSeenAt: "2026-08-29T00:00:00.000Z", todayCount: 0 },
  ];
  const merged = mergeModuleCatalog(
    catalog,
    [
      { id: "reading-comprehension", name: "阅读理解专项", pluginType: "quiz", domain: "ielts", items: [{ abilityId: "new:b" }] },
      { id: "paper-core-viewpoints", name: "论文核心观点", pluginType: "recall", domain: "paper", items: [{ abilityId: "new:a" }] },
    ],
    "2026-08-30T00:00:00.000Z",
    false,
  );
  const byName = new Map(merged.map((m) => [m.name, m]));
  assert.equal(byName.get("阅读理解专项").itemKeys.includes("old:b") && byName.get("阅读理解专项").itemKeys.includes("new:b"), true);
  assert.equal(byName.get("论文核心观点").itemKeys.includes("old:a") && byName.get("论文核心观点").itemKeys.includes("new:a"), true);
  assert.equal(merged.filter((m) => m.name === "论文核心要点" || m.name === "核心概念理解").length, 0);
});
