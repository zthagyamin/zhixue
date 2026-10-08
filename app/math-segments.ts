// 学习 Vault 的复习要点与讲解大量使用 LaTeX（$\gamma$、$$公式$$）。把文
// 本切成纯文本 / 行内公式 / 块级公式三段，交由 KaTeX 渲染；不含成对定
// 界符的内容必须原样保留（含未配对的美元符号，如价格文本）。

export type MathSegment = { type: "text" | "inline" | "block"; value: string };

export function splitMathSegments(input: string): MathSegment[] {
  const text = String(input ?? "");
  const segments: MathSegment[] = [];
  let buffer = "";
  let index = 0;

  const flushText = () => {
    if (buffer) segments.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (index < text.length) {
    const blockStart = text.indexOf("$$", index);
    const singleStart = text.indexOf("$", index);
    const bracketStart = text.indexOf("\\(", index);
    const next = Math.min(
      blockStart === -1 ? Infinity : blockStart,
      singleStart === -1 ? Infinity : singleStart,
      bracketStart === -1 ? Infinity : bracketStart,
    );
    if (!Number.isFinite(next)) {
      buffer += text.slice(index);
      break;
    }

    buffer += text.slice(index, next);

    if (next === blockStart) {
      const end = text.indexOf("$$", blockStart + 2);
      if (end === -1) {
        buffer += text.slice(next);
        break;
      }
      flushText();
      segments.push({ type: "block", value: text.slice(blockStart + 2, end).trim() });
      index = end + 2;
      continue;
    }

    if (next === bracketStart) {
      const end = text.indexOf("\\)", bracketStart + 2);
      if (end === -1) {
        buffer += text.slice(next);
        break;
      }
      flushText();
      segments.push({ type: "inline", value: text.slice(bracketStart + 2, end).trim() });
      index = end + 2;
      continue;
    }

    const end = text.indexOf("$", singleStart + 1);
    if (end === -1) {
      buffer += text.slice(next);
      break;
    }
    flushText();
    segments.push({ type: "inline", value: text.slice(singleStart + 1, end).trim() });
    index = end + 1;
  }

  flushText();
  return segments.length > 0 ? segments : [{ type: "text", value: "" }];
}
