import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// I2：判题必须走带会话头的 Companion 客户端（context.gradeCalculation），
// 裸 fetch 没有 X-Study-Loop-Session 必然 401。
test("calculation plugin grades through the authenticated practice context", async () => {
  const source = await readFile(new URL("../app/plugin-calculation.tsx", import.meta.url), "utf8");
  assert.match(source, /@zhixue\/plugin-calculation/);
  assert.match(source, /gradeCalculation/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});

test("calculation plugin requires the authenticated grade call from context", async () => {
  const source = await readFile(new URL("../app/plugin-calculation.tsx", import.meta.url), "utf8");
  assert.match(source, /context/);
  assert.match(source, /上下文未提供判题方法|gradeCalculation/);
});

test("practice session forwards a gradeCalculation context to plugins", async () => {
  const source = await readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8");
  assert.match(source, /gradeCalculation/);
  assert.match(source, /context/);
});

test("registry context type declares the authenticated gradeCalculation hook", async () => {
  const source = await readFile(new URL("../app/plugins/registry.tsx", import.meta.url), "utf8");
  assert.match(source, /gradeCalculation/);
});

test("recall grading is forwarded through the authenticated practice context", async () => {
  const session = await readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8");
  const registry = await readFile(new URL("../app/plugins/registry.tsx", import.meta.url), "utf8");
  assert.match(session, /gradeRecall/);
  assert.match(registry, /gradeRecall/);
});
