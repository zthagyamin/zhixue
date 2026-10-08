import assert from "node:assert/strict";
import test from "node:test";
import { splitMathSegments } from "../app/math-segments.ts";

// 学习 Vault 的复习要点与讲解大量使用 LaTeX（$\gamma$、$$公式$$）。网站
// 过去直接按纯文本渲染，公式原样暴露。解析器把文本切成纯文本 / 行内公
// 式 / 块级公式三段，供 KaTeX 组件渲染；不含定界符的普通文本必须原样。

test("plain text without delimiters stays a single text segment", () => {
  assert.deepEqual(splitMathSegments("归一化解决每层信号失控"), [
    { type: "text", value: "归一化解决每层信号失控" },
  ]);
});

test("inline $...$ segments are extracted", () => {
  assert.deepEqual(splitMathSegments("缩放参数 $\\gamma$ 与平移参数 $\\beta$"), [
    { type: "text", value: "缩放参数 " },
    { type: "inline", value: "\\gamma" },
    { type: "text", value: " 与平移参数 " },
    { type: "inline", value: "\\beta" },
  ]);
});

test("block $$...$$ segments are extracted with surrounding text", () => {
  assert.deepEqual(splitMathSegments("损失定义：$$L = -\\log p$$ 其中 p 为概率"), [
    { type: "text", value: "损失定义：" },
    { type: "block", value: "L = -\\log p" },
    { type: "text", value: " 其中 p 为概率" },
  ]);
});

test("a lone unpaired dollar sign stays plain text", () => {
  assert.deepEqual(splitMathSegments("这个功能价值 5 美元 $ 和更多"), [
    { type: "text", value: "这个功能价值 5 美元 $ 和更多" },
  ]);
});

test("block segments win over inline when $$ appears first", () => {
  const segments = splitMathSegments("$$a + b$$");
  assert.deepEqual(segments, [{ type: "block", value: "a + b" }]);
});

test("empty and non-string input degrade to empty text", () => {
  assert.deepEqual(splitMathSegments(""), [{ type: "text", value: "" }]);
});
