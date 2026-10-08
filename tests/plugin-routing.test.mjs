import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptStudyItemForPlugin,
  compatiblePluginTypes,
  PLUGIN_TYPES,
  pluginLabels,
  normalizePluginOverrides,
  pluginItemKey,
  prunePluginOverrides,
  resolvePluginType,
} from "../app/plugin-routing.ts";

test("exposes recall and calculation as selectable plugin types", () => {
  assert.deepEqual(PLUGIN_TYPES, ["three-stage", "quiz", "recall", "calculation", "code", "flashcard", "spelling", "paper"]);
  assert.equal(pluginLabels.recall, "AI 回忆问答");
  assert.equal(pluginLabels.calculation, "计算题");
});

const word = {
  id: "word-1",
  pluginType: "three-stage",
  word: "variant",
  phonetic: "/ˈveəriənt/",
  meaning: "变体",
  context: "论文语境",
  example: "A variant was evaluated.",
};

test("offers only compatible learning plugins and creates safe flashcards", () => {
  assert.deepEqual(compatiblePluginTypes(word), ["three-stage", "recall", "flashcard", "spelling"]);
  const wordCard = adaptStudyItemForPlugin("flashcard", word);
  assert.match(String(wordCard?.front), /variant/);
  assert.match(String(wordCard?.back), /变体/);

  const quiz = { pluginType: "quiz", prompt: "2 + 2?", options: ["3", "4"], answer: "4", explanation: "加法" };
  assert.deepEqual(compatiblePluginTypes(quiz), ["quiz", "recall", "calculation", "flashcard"]);

  const code = { pluginType: "code", prompt: "实现 add", initialCode: "def add(a, b):", testCode: "assert add(1, 2) == 3", solutionCode: "def add(a, b): return a + b", explanation: "返回两数之和" };
  assert.deepEqual(compatiblePluginTypes(code), ["recall", "code", "flashcard"]);
});

test("resolves item override, subject default, and AI fallback in order", () => {
  assert.equal(resolvePluginType(word, "three-stage", "flashcard", "three-stage"), "flashcard");
  assert.equal(resolvePluginType(word, "three-stage", "ai", "flashcard"), "three-stage");
  assert.equal(resolvePluginType(word, "three-stage", undefined, "flashcard"), "flashcard");
  assert.equal(resolvePluginType(word, "three-stage", undefined, "code"), "three-stage");
});

test("falls back to a source-verification flashcard for metadata-only captures", () => {
  const capture = {
    id: "clip-loss",
    pluginType: "quiz",
    word: "CLIP 对称对比损失",
    sourceNote: "课程笔记/第16讲.md",
    stateRef: "学习记录/第16讲 学习状态.md",
    abilityId: "clip-symmetric-loss",
  };

  assert.deepEqual(compatiblePluginTypes(capture), ["flashcard"]);
  assert.equal(resolvePluginType(capture, "quiz", "ai"), "flashcard");
  const card = adaptStudyItemForPlugin("flashcard", capture);
  assert.equal(card?.front, "CLIP 对称对比损失");
  assert.match(String(card?.back), /课程笔记\/第16讲\.md/);
});

test("keeps overrides isolated by stable subject/item keys and removes invalid stored values", () => {
  assert.equal(pluginItemKey("english", word, 0), "english::word-1");
  assert.deepEqual(normalizePluginOverrides(null), { subject: {}, item: {} });
  assert.deepEqual(normalizePluginOverrides({
    subject: { english: "flashcard", bad: "video" },
    item: { "english::word-1": "ai", bad: "video" },
  }), {
    subject: { english: "flashcard" },
    item: { "english::word-1": "ai" },
  });
});

test("prunes orphaned override keys when subjects disappear, and preserves identity when nothing changes", () => {
  const overrides = {
    subject: { english: "flashcard", gone: "quiz" },
    item: { "english::word-1": "ai", "gone::word-2": "flashcard" },
  };
  const pruned = prunePluginOverrides(overrides, ["english"]);
  assert.deepEqual(pruned, {
    subject: { english: "flashcard" },
    item: { "english::word-1": "ai" },
  });

  const unchanged = { subject: { english: "flashcard" }, item: { "english::word-1": "ai" } };
  assert.equal(prunePluginOverrides(unchanged, ["english"]), unchanged);
});
