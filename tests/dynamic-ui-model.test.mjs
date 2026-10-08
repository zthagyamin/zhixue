import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDynamicUiModel,
  mergeModuleCatalog,
  modulePresentation,
  moduleProgressSummary,
  normalizeDynamicSubjects,
  resolveEventAbilityId,
  resolveStudyItemProgressKey,
  resolveDynamicTab,
  stableStudyItemKey,
} from "../app/dynamic-ui-model.ts";

const pythonEmpty = { id: "python", name: "Python", pluginType: "quiz", domain: "python", items: [] };
const paper = {
  id: "paper-core-viewpoints",
  name: "论文复习",
  pluginType: "recall",
  domain: "paper",
  items: [{ id: "paper-q1", abilityId: "paper:clip-loss", prompt: "解释 CLIP 对称损失" }],
};

test("zero-item Python disappears while paper review becomes playable", () => {
  const model = buildDynamicUiModel({ subjects: [pythonEmpty, paper], day: "2026-08-29", plan: null, catalog: [], demoMode: false });
  assert.deepEqual(model.playableSubjects.map((subject) => subject.id), ["paper-core-viewpoints"]);
  assert.equal(model.isCaughtUp, false);
});

test("all zero-item subjects produce the caught-up state", () => {
  const model = buildDynamicUiModel({ subjects: [pythonEmpty], day: "2026-08-29", plan: null, catalog: [], demoMode: false });
  assert.equal(model.isCaughtUp, true);
  assert.deepEqual(model.playableSubjects, []);
});

test("an unseen empty subject never pollutes module history", () => {
  assert.deepEqual(mergeModuleCatalog([], [pythonEmpty], "2026-08-29T00:00:00.000Z", false), []);
});

test("historical Python remains in progress when today has no Python work", () => {
  const model = buildDynamicUiModel({
    subjects: [pythonEmpty, paper], day: "2026-08-29", plan: null, demoMode: false,
    catalog: [{ id: "python", name: "Python", pluginType: "quiz", domain: "python", itemKeys: ["python:loops"], lastSeenAt: "2026-08-28T10:00:00.000Z", todayCount: 0 }],
  });
  assert.deepEqual(model.historicalModules.map((module) => module.id), ["paper-core-viewpoints", "python"]);
  assert.equal(model.historicalModules.find((module) => module.id === "python")?.todayCount, 0);
});

test("today plan narrows items and never exposes unrelated content when a key is unmapped", () => {
  const subject = { ...paper, items: [{ abilityId: "paper:a", prompt: "A" }, { abilityId: "paper:b", prompt: "B" }] };
  const plan = (itemKey) => ({ day: "2026-08-29", planHash: itemKey, totalMinutes: 2, overloaded: false, skipped: [], items: [{ kind: "study", itemKey, domain: "paper", estimatedMinutes: 2, reasons: [] }] });
  const mapped = buildDynamicUiModel({ subjects: [subject], day: "2026-08-29", catalog: [], demoMode: false, plan: plan("paper:b") });
  assert.equal(mapped.currentPlanApplied, true);
  assert.deepEqual(mapped.playableSubjects[0].items.map(stableStudyItemKey), ["paper:b"]);
  const unmapped = buildDynamicUiModel({ subjects: [subject], day: "2026-08-29", catalog: [], demoMode: false, plan: plan("paper:missing") });
  assert.equal(unmapped.currentPlanApplied, true);
  assert.deepEqual(unmapped.playableSubjects, []);
  assert.equal(mapped.historicalModules.find((module) => module.id === "paper-core-viewpoints")?.todayCount, 1);
});

test("unplanned current modules remain historical but have no today task", () => {
  const words = { id: "words", name: "词汇", pluginType: "three-stage", items: [{ abilityId: "word:a", word: "A" }] };
  const plan = { day: "2026-08-29", planHash: "paper", totalMinutes: 2, overloaded: false, skipped: [], items: [{ kind: "study", itemKey: "paper:clip-loss", domain: "paper", estimatedMinutes: 2, reasons: [] }] };
  const model = buildDynamicUiModel({ subjects: [words, paper], day: "2026-08-29", catalog: [], demoMode: false, plan });
  assert.equal(model.historicalModules.find((module) => module.id === "words")?.todayCount, 0);
  assert.equal(model.historicalModules.find((module) => module.id === "paper-core-viewpoints")?.todayCount, 1);
});

test("runtime subject normalization drops malformed subjects and repairs item identity", () => {
  const normalized = normalizeDynamicSubjects([
    null,
    { id: "", name: "坏数据", pluginType: "quiz", items: [] },
    { id: "paper", name: "论文复习", pluginType: "recall", domain: "paper", items: [{ prompt: "解释残差连接" }, null] },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].items.length, 1);
  assert.equal(normalized[0].items[0].itemId, "paper:item-1");
});

test("one compatible progress key drives all three-stage reads and writes", () => {
  const item = { word: "pooling layer", abilityId: "pooling-layer" };
  assert.equal(resolveStudyItemProgressKey(item, 0, { itemStages: {}, fsrsData: {} }), "pooling-layer");
  assert.equal(resolveStudyItemProgressKey(item, 0, { itemStages: { "word:pooling layer": 2 }, fsrsData: {} }), "word:pooling layer");
});

test("event identity for a vocabulary item never falls back to its display position", () => {
  const item = { id: "item-1-2", word: "prohibitively" };
  assert.equal(resolveEventAbilityId(item, 1, { itemStages: {}, fsrsData: {} }), "word:prohibitively");
});

test("catalog updates a renamed module and preserves stable historical item keys", () => {
  const previous = [{ id: "paper", name: "旧论文名", pluginType: "recall", domain: "course", itemKeys: ["paper:a"], lastSeenAt: "2026-08-28T00:00:00.000Z", todayCount: 0 }];
  const next = mergeModuleCatalog(previous, [{ id: "paper", name: "论文复习", pluginType: "recall", domain: "course", items: [{ abilityId: "paper:b" }] }], "2026-08-29T00:00:00.000Z", false);
  assert.equal(next[0].name, "论文复习");
  assert.deepEqual(next[0].itemKeys, ["paper:a", "paper:b"]);
});

test("demo modules never enter personal history", () => {
  assert.deepEqual(mergeModuleCatalog([], [paper], "2026-08-29T00:00:00.000Z", true), []);
});

test("invalid subject tab returns to today while system tabs remain", () => {
  assert.equal(resolveDynamicTab("python", ["paper-review"]), "today");
  assert.equal(resolveDynamicTab("progress", ["paper-review"]), "progress");
});

test("historical module reports evidence without inventing a completion rate", () => {
  const summary = moduleProgressSummary(
    { id: "python", name: "Python", pluginType: "quiz", domain: "python", itemKeys: ["python:a", "python:b"], lastSeenAt: "2026-08-28T00:00:00.000Z", todayCount: 0 },
    { itemStages: { "python:a": 2 } },
  );
  assert.deepEqual(summary, { evidenceCount: 1, knownItemCount: 2, todayCount: 0, todayLabel: "今日无任务", completionPercent: null });
});

test("three-stage current module has a real completion percentage", () => {
  const subject = { id: "words", name: "词汇", pluginType: "three-stage", items: [{ abilityId: "word:a" }, { abilityId: "word:b" }] };
  const summary = moduleProgressSummary(
    { id: "words", name: "词汇", pluginType: "three-stage", itemKeys: ["word:a", "word:b"], lastSeenAt: "2026-08-29T00:00:00.000Z", todayCount: 2 },
    { itemStages: { "word:a": 3, "word:b": 1 } },
    subject,
  );
  assert.equal(summary.completionPercent, 67);
});

test("module presentation keeps paper distinct and unknown domains neutral", () => {
  assert.deepEqual(modulePresentation({ name: "论文复习", pluginType: "recall", domain: "paper" }), { accent: "blue", eyebrow: "AI 回忆问答", icon: "论" });
  assert.deepEqual(modulePresentation({ name: "量子信息", pluginType: "flashcard", domain: "custom" }), { accent: "sand", eyebrow: "学习内容", icon: "量" });
});

test("module icon keeps an emoji grapheme intact", () => {
  assert.equal(modulePresentation({ name: "👨‍💻 编程", pluginType: "code", domain: "custom" }).icon, "👨‍💻");
});
