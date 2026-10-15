export type FlashcardAnswerView = {
    primary: string;
    full: string;
    compact: boolean;
};

/** Show only an explicitly authored answer; paragraph length is not a relevance signal. */
export function flashcardAnswerView(back: string, original?: unknown): FlashcardAnswerView {
    const complete = { primary: back, full: back, compact: false };
    const source = original && typeof original === 'object' ? original as Record<string, unknown> : {};
    const answer = source.answer, explanation = source.explanation;
    if (typeof answer === 'string' && answer.trim() && typeof explanation === 'string' && explanation.trim()
        && back === [answer, explanation].join('\n\n')) {
        return { primary: answer, full: back, compact: true };
    }

    // Labeled sections are a presentation convention, not a new content contract.
    // Keep the complete original for inspection and for every provenance operation.
    const opening = /^(?:#{1,6}[ \t]+)?(?:关键要点|核心要点|Key points)[ \t]*[:：]?[ \t]*\r?\n/i.exec(back);
    if (!opening) return complete;
    const body = back.slice(opening[0].length);
    const details = /\r?\n(?:#{1,6}[ \t]+)?(?:完整说明|详细说明|Full explanation)[ \t]*[:：]?[ \t]*\r?\n/i.exec(body);
    if (!details) return complete;
    const primary = body.slice(0, details.index).trim();
    // An apparent heading inside an open code/math block must never fold its tail.
    if (!primary || !body.slice(details.index + details[0].length).trim()
        || /```|~~~|\$\$/.test(primary)) return complete;
    return { primary, full: back, compact: true };
}
