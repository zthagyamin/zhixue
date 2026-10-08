import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function extractFunction(file, name) {
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile("component.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let targetNode;
  function visit(node) {
    if (targetNode) return;
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) {
      targetNode = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!targetNode) throw new Error(`Function ${name} not found`);
  const code = ts.transpileModule(`exports.fn = function ${targetNode.getText(source).replace(/^function\s+([^(]+)/, '')};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = {};
  new Function("exports", code)(out);
  return out.fn;
}

const formatFocusDurationMeta = extractFunction(
  new URL("../app/dashboard-focus-hero.tsx", import.meta.url),
  "formatFocusDurationMeta"
);

test("UX-05: focus hero clearly separates lead group estimate from total remaining duration", () => {
  // 1. Two tasks: 5 minutes lead, 18 minutes total remaining
  const twoTasksText = formatFocusDurationMeta({
    groups: 2,
    minutes: 18,
    leadMinutes: 5,
    blocked: 0,
  });
  assert.match(twoTasksText, /本组预计 5 分钟/);
  assert.match(twoTasksText, /当前待完成任务合计预计 18 分钟/);
  assert.doesNotMatch(twoTasksText, /整组预计 18 分钟/);
  assert.doesNotMatch(twoTasksText, /本组预计 18 分钟/);

  // 2. Single task: 5 minutes lead, 5 minutes total
  const singleTaskText = formatFocusDurationMeta({
    groups: 1,
    minutes: 5,
    leadMinutes: 5,
    blocked: 0,
  });
  assert.match(singleTaskText, /本组预计 5 分钟/);
  assert.doesNotMatch(singleTaskText, /当前待完成任务合计预计/);

  // 3. Missing single task estimate, total 18 minutes known
  const missingLeadText = formatFocusDurationMeta({
    groups: 2,
    minutes: 18,
    leadMinutes: null,
    blocked: 0,
  });
  assert.doesNotMatch(missingLeadText, /本组预计/);
  assert.match(missingLeadText, /当前待完成任务合计预计 18 分钟/);

  // 4. Missing all estimates
  const unknownEstimatesText = formatFocusDurationMeta({
    groups: 2,
    minutes: null,
    leadMinutes: null,
    blocked: 0,
  });
  assert.match(unknownEstimatesText, /按自己的节奏完成/);

  // 5. Blocked tasks notice
  const blockedTasksText = formatFocusDurationMeta({
    groups: 2,
    minutes: 18,
    leadMinutes: 5,
    blocked: 1,
  });
  assert.match(blockedTasksText, /1 组资料需要核对/);
});

