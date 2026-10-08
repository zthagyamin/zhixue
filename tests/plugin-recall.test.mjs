import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("recall plugin submits an answer for AI grading and keeps offline self-assessment", async () => {
  const source = await readFile(new URL("../app/plugin-recall.tsx", import.meta.url), "utf8");
  assert.match(source, /@zhixue\/plugin-recall/);
  assert.match(source, /gradeRecall/);
  assert.match(source, /提交并核对/);
  assert.match(source, /想好了/);
  assert.match(source, /忘记了，查看要点/);
  assert.match(source, /hasSavedFeedback/);
  assert.match(source, /continueAfterFeedback/);
  assert.match(source, /AI 判定/);
  assert.match(source, /记得|good/);
  assert.match(source, /不记得|again/);
});

test("recall plugin renders structured AI feedback fields", async () => {
  const source = await readFile(new URL("../app/plugin-recall.tsx", import.meta.url), "utf8");
  assert.match(source, /confidence/);
  assert.match(source, /matchedPoints/);
  assert.match(source, /missedPoints/);
  assert.match(source, /部分记得|hard/);
});
