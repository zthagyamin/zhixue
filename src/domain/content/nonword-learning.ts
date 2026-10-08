// @ts-expect-error TS5097: standalone Node contracts.
import { parseQuizSupport } from './quiz-support.ts';
/** Classify the original material, never the user's current presentation override. */
export function isNonWordOriginal(mode: string, raw: unknown): boolean {
    if (!['recall', 'quiz', 'code', 'calculation', 'flashcard'].includes(mode))
        return false;
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (data.kind === 'word' || data.eventKind === 'word')
        return false;
    if (['three-stage', 'spelling'].includes(String(data.pluginType ?? data.type ?? '')))
        return false;
    if (typeof data.word === 'string' && data.word.trim() || data.word && typeof data.word === 'object')
        return false;
    return true;
}
export type QuizMaterial = {
    selection: 'single' | 'multiple';
    options: {
        id: string;
        text: string;
        explanation?: string;
    }[];
    correctIds: string[];
};
export type SelectionEvaluation = {
    status: 'correct' | 'partial' | 'incorrect';
    matched: string[];
    missing: string[];
    wrong: string[];
};
export type NonWordQuizState = {
    selection: string[];
    first: {
        selection: string[];
        result: SelectionEvaluation;
    } | null;
    phase: 'answer' | 'feedback' | 'retry' | 'retry-feedback';
    retry: SelectionEvaluation | null;
};
export type QuizAction = {
    type: 'choose';
    id: string;
} | {
    type: 'submit' | 'retry' | 'submit-retry' | 'back-feedback';
};
/** Presentation adapter only: source IDs and content hashes stay unchanged. */
export function quizMaterial(raw: unknown): QuizMaterial {
    const data = raw as {
        learningSupport?: unknown;
        options?: unknown;
        answer?: unknown;
    };
    if (data?.learningSupport) {
        const support = parseQuizSupport(data.learningSupport);
        return { selection: support.selection, options: support.options.map(option => ({ id: option.optionId, text: option.text,
            ...(support.schemaVersion === 2 && 'explanation' in option ? { explanation: option.explanation } : option.trapExplanation ? { explanation: option.trapExplanation } : {}) })), correctIds: [...support.correctOptionIds] };
    }
    if (!Array.isArray(data?.options) || data.options.length < 2 || data.options.some(value => typeof value !== 'string'))
        throw Error('invalid-choice-material');
    const options = data.options as string[];
    const matching = options.flatMap((text, index) => text === data.answer ? [index] : []);
    if (matching.length !== 1)
        throw Error('ambiguous-choice-reference');
    return { selection: 'single', options: options.map((text, index) => ({ id: `option-${index}`, text })), correctIds: [`option-${matching[0]}`] };
}
export function evaluateSelection(material: QuizMaterial, selection: readonly string[]): SelectionEvaluation {
    const chosen = new Set(selection), correct = new Set(material.correctIds);
    const matched = material.correctIds.filter(id => chosen.has(id));
    const missing = material.correctIds.filter(id => !chosen.has(id));
    const wrong = [...chosen].filter(id => !correct.has(id));
    return { status: !missing.length && !wrong.length ? 'correct' : matched.length && !wrong.length ? 'partial' : 'incorrect', matched, missing, wrong };
}
/** First evidence is immutable; retry is a child interaction without a second grade. */
export function transitionQuiz(state: NonWordQuizState, action: QuizAction, material: QuizMaterial): NonWordQuizState {
    if (action.type === 'choose') {
        if (!['answer', 'retry'].includes(state.phase) || !material.options.some(option => option.id === action.id))
            return state;
        const selection = state.selection.includes(action.id) ? state.selection.filter(id => id !== action.id) : material.selection === 'single' ? [action.id] : [...state.selection, action.id];
        return { ...state, selection };
    }
    if (action.type === 'submit') {
        if (state.first || state.phase !== 'answer' || !state.selection.length)
            return state;
        return { ...state, phase: 'feedback', first: { selection: [...state.selection], result: evaluateSelection(material, state.selection) } };
    }
    if (action.type === 'retry')
        return state.first ? { ...state, phase: 'retry', selection: [], retry: null } : state;
    if (action.type === 'submit-retry')
        return state.phase === 'retry' && state.selection.length ? { ...state, phase: 'retry-feedback', retry: evaluateSelection(material, state.selection) } : state;
    if (action.type === 'back-feedback')
        return state.first ? { ...state, phase: 'feedback', selection: [...state.first.selection] } : state;
    return state;
}
