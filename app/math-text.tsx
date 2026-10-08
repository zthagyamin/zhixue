"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { splitMathSegments } from "./math-segments";

// 把含 LaTeX 的学习文本渲染为公式 + 文本混合内容。渲染失败时退回原文，
// 绝不吞掉内容。
export function MathText({ text, className }: { text: string; className?: string }) {
  const segments = splitMathSegments(text);
  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === "text") return <span key={index}>{segment.value}</span>;
        let html = "";
        try {
          html = katex.renderToString(segment.value, {
            displayMode: segment.type === "block",
            throwOnError: false,
            output: "html",
          });
        } catch {
          return <span key={index}>{segment.value}</span>;
        }
        return <span key={index} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </span>
  );
}
