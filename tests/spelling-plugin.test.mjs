import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { evaluateKeypress, spellingStates, isSpellingComplete } from "../app/plugins/spelling-core.ts";

// 拼写练习插件的核心状态机（借鉴 TypeWords：逐字母即时反馈，错误字符
// 必须退格重输，以训练拼写准确性）。

test("typing the correct character advances the accepted input", () => {
  const state = evaluateKeypress({ word: "cat", input: "", wrong: "", wrongCount: 0 }, "c");
  assert.equal(state.input, "c");
  assert.equal(state.wrong, "");
  assert.equal(state.wrongCount, 0);
});

test("a wrong character is held in place and blocks further input until backspace", () => {
  const held = evaluateKeypress({ word: "cat", input: "c", wrong: "", wrongCount: 0 }, "x");
  assert.equal(held.input, "c");
  assert.equal(held.wrong, "x");
  assert.equal(held.wrongCount, 1);

  const blocked = evaluateKeypress({ word: "cat", input: "c", wrong: "x", wrongCount: 1 }, "a");
  assert.equal(blocked.input, "c");
  assert.equal(blocked.wrong, "x");
  assert.equal(blocked.wrongCount, 1);
});

test("backspace clears the held wrong character first, then removes accepted characters", () => {
  const cleared = evaluateKeypress({ word: "cat", input: "c", wrong: "x", wrongCount: 1 }, "Backspace");
  assert.equal(cleared.input, "c");
  assert.equal(cleared.wrong, "");

  const removed = evaluateKeypress({ word: "cat", input: "ca", wrong: "", wrongCount: 0 }, "Backspace");
  assert.equal(removed.input, "c");
});

test("completion requires the full word with no held wrong character", () => {
  assert.equal(isSpellingComplete({ word: "cat", input: "cat", wrong: "", wrongCount: 0 }), true);
  assert.equal(isSpellingComplete({ word: "cat", input: "cat", wrong: "x", wrongCount: 0 }), false);
  assert.equal(isSpellingComplete({ word: "cat", input: "ca", wrong: "", wrongCount: 0 }), false);
});

test("spaces and hyphens are typed like regular characters", () => {
  let state = { word: "trade-off", input: "trade-off", wrong: "", wrongCount: 0 };
  assert.equal(isSpellingComplete(state), true);

  state = { word: "participate in", input: "participate ", wrong: "", wrongCount: 0 };
  const next = evaluateKeypress(state, "i");
  assert.equal(next.input, "participate i");
});

test("spellingStates renders pending, correct and wrong character states", () => {
  const states = spellingStates("word", "wo", "x");
  assert.deepEqual(states, [
    { char: "w", status: "correct" },
    { char: "o", status: "correct" },
    { char: "x", status: "wrong" },
    { char: "d", status: "pending" },
  ]);

  assert.deepEqual(spellingStates("word", "", ""), [
    { char: "w", status: "pending" },
    { char: "o", status: "pending" },
    { char: "r", status: "pending" },
    { char: "d", status: "pending" },
  ]);
});

test("the spelling plugin type routes word items and rejects non-word items", async () => {
  const routing = await import("../app/plugin-routing.ts");
  assert.ok(routing.PLUGIN_TYPES.includes("spelling"));
  assert.equal(routing.pluginLabels.spelling, "拼写练习");

  const wordItem = { word: "considerably", meaning: "相当地", example: "improved considerably", id: "w1" };
  assert.deepEqual(routing.adaptStudyItemForPlugin("spelling", wordItem), wordItem);

  const quizItem = { prompt: "题干", answer: "A", options: ["A", "B"], id: "q1" };
  assert.equal(routing.adaptStudyItemForPlugin("spelling", quizItem), null);
});

test("three-stage speaks each word and offers a speak button on every stage", async () => {
  const [speech, plugin] = await Promise.all([
    readFile(new URL("../app/plugins/speech.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/plugins/plugin-three-stage.tsx", import.meta.url), "utf8"),
  ]);
  assert.ok(speech.includes("speechSynthesis"));
  assert.ok(plugin.includes('speakWord(word)') || plugin.includes('speakWord(String(data.word'), "三阶段应自动朗读词卡");
  const usages = plugin.split("<SpeakButton").length - 1;
  assert.ok(usages === 3, "三个阶段都应有朗读按钮，实际 " + usages.length);
});
