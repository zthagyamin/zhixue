'use client';
import { Fragment, type ReactNode } from 'react';
/** Supplied source text only. No HTML execution and no discarded malformed fences. */
export function LearningText({ text, className = '', renderMath }: {
    text: string;
    className?: string;
    renderMath?: (text: string) => ReactNode;
}) {
    const pieces = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
    return <div className={`nonword-text ${className}`.trim()}>{pieces.map((piece, index) => {
            const code = /^```([^\n]*)\n([\s\S]*?)```$/.exec(piece);
            return code ? <pre key={index} className="nonword-code"><code>{code[2]}</code></pre> : <Fragment key={index}>{renderMath ? renderMath(piece) : piece}</Fragment>;
        })}</div>;
}
/** An actual prose excerpt; protected source spans never become shortened math/code input. */
function feedbackExcerpt(text: string): string | null {
    const protectedSpans = /(```[\s\S]*?(?:```|$)|\$\$[\s\S]*?(?:\$\$|$)|\\\[[\s\S]*?(?:\\\]|$)|\\\([\s\S]*?(?:\\\)|$)|\$[^$\n]*(?:\$|$)|`[^`\n]*(?:`|$))/g;
    const prose = text.split(protectedSpans).filter((_, index) => index % 2 === 0);
    const paragraph = prose.flatMap(piece => piece.split(/\n\s*\n/)).map(piece => piece.trim()).find(piece => piece.length >= 40 && /\p{L}/u.test(piece));
    if (!paragraph)
        return null;
    const characters = Array.from(paragraph), prefix = characters.slice(0, 240).join('');
    if (characters.length <= 240)
        return prefix;
    const stops = [...prefix.matchAll(/[。！？]|[.!?](?:\s|$)/g)], last = stops.at(-1)?.index;
    return (last !== undefined && last >= 80 ? prefix.slice(0, last + 1) : prefix) + '…';
}
/** Readable explanation first, with the immutable full source available on demand. */
export function LearningFeedback({ text, className = '', renderMath, fullLabel = '查看完整解释' }: {
    text: string;
    className?: string;
    renderMath?: (text: string) => ReactNode;
    fullLabel?: string;
}) {
    const long = text.length > 320 || text.split('\n').length > 6;
    const excerpt = long ? feedbackExcerpt(text) : null;
    // Formula/code-only feedback has no honest short prose summary: keep its substance visible.
    if (!excerpt)
        return <LearningText text={text} className={className} renderMath={renderMath}/>;
    return <div className={className}>
      <div className="nonword-text" aria-label="解释摘录">{excerpt}</div>
      <details><summary>{fullLabel}</summary><LearningText text={text} renderMath={renderMath}/></details>
    </div>;
}
