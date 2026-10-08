import type { PracticeMode } from './practice-modes';
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
/** Source and display adapters share supplied vocabulary meaning; no generated answers. */
export function wordRecallContent(word: {
    word?: unknown;
    meaning?: unknown;
    context?: unknown;
    example?: unknown;
}): {
    prompt: string;
    explanation: string;
} | null {
    if (!text(word.word) || !text(word.meaning))
        return null;
    return { prompt: `请闭卷解释：${text(word.word)}`, explanation: [word.meaning, word.context, word.example].map(text).filter(Boolean).join('\n\n') };
}
/** Normalize old source shapes only. An explicit empty displayed back stays invalid. */
export function assessmentContentShape(mode: PracticeMode, data: Record<string, unknown>): Record<string, unknown> {
    const word = wordRecallContent(data);
    if (mode === 'recall' && !text(data.prompt) && word)
        return { ...data, ...word };
    if (mode === 'flashcard') {
        if (Object.hasOwn(data, 'back'))
            return { ...data, front: data.front ?? data.prompt };
        if (word)
            return { ...data, front: data.front ?? data.word, back: word.explanation };
        return { ...data, front: data.front ?? data.prompt, back: [data.answer, data.explanation, data.reviewPoint].find(value => text(value) !== '') };
    }
    return data;
}
