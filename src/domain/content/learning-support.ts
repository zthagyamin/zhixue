export type RecallCriterion = {
    id: string;
    text: string;
    weight?: number;
    mandatory?: boolean;
};
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseCourseRecallSupport, type CourseRecallSupport } from './course-task-support.ts';
export type RecallSupportV1 = {
    schemaVersion: 1;
    type: 'recall';
    criteria?: RecallCriterion[];
    hints?: [
        string,
        string,
        string
    ];
};
export type RecallSupport = RecallSupportV1 | CourseRecallSupport;
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseCalculationSupport, type CalculationSupport } from './calculation-support.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseFlashcardSupport, type FlashcardSupport } from './flashcard-support.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseSpellingSupport, type SpellingSupport } from './spelling-support.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseQuizSupport, type QuizSupport } from './quiz-support.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseCodeLearningSupportV1, type CodeLearningSupportV1 } from './code-learning-support.ts';
export type LearningSupport = RecallSupport | CalculationSupport | FlashcardSupport | SpellingSupport | QuizSupport | CodeLearningSupportV1;
function object(value: unknown, keys: string[]) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('invalid-learning-support'); return value as Record<string, unknown>; }
// eslint-disable-next-line no-control-regex -- reject unsafe controls in source metadata.
function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new Error('invalid-learning-support-text'); return value; }
export function parseLearningSupport(raw: unknown, mode: string): LearningSupport {
    if (mode === 'quiz')
        return parseQuizSupport(raw);
    if (mode === 'code')
        return parseCodeLearningSupportV1(raw);
    if (mode === 'spelling')
        return parseSpellingSupport(raw);
    if (mode === 'calculation')
        return parseCalculationSupport(raw);
    if (mode === 'flashcard')
        return parseFlashcardSupport(raw);
    if (mode === 'recall' && raw && typeof raw === 'object' && (raw as {schemaVersion?: unknown}).schemaVersion === 2)
        return parseCourseRecallSupport(raw);
    const value = object(raw, ['schemaVersion', 'type', 'criteria', 'hints']);
    if (value.schemaVersion !== 1 || value.type !== 'recall' || mode !== 'recall')
        throw new Error('unsupported-learning-support-version');
    if (!Object.hasOwn(value, 'criteria') && !Object.hasOwn(value, 'hints'))
        throw new Error('empty-learning-support');
    if (value.criteria !== undefined) {
        if (!Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 24)
            throw new Error('invalid-recall-criteria');
        const ids = new Set<string>();
        for (const rawPoint of value.criteria) {
            const point = object(rawPoint, ['id', 'text', 'weight', 'mandatory']), id = text(point.id, 64);
            if (!/^[a-zA-Z0-9:_.-]+$/.test(id) || ids.has(id))
                throw new Error('invalid-recall-criterion-id');
            ids.add(id);
            text(point.text, 1500);
            if (point.weight !== undefined && (typeof point.weight !== 'number' || !Number.isInteger(point.weight) || point.weight <= 0 || point.weight > 1000))
                throw new Error('invalid-recall-weight');
            if (point.mandatory !== undefined && typeof point.mandatory !== 'boolean')
                throw new Error('invalid-recall-mandatory');
        }
    }
    if (value.hints !== undefined) {
        if (!Array.isArray(value.hints) || value.hints.length !== 3)
            throw new Error('invalid-recall-hints');
        value.hints.forEach(hint => text(hint, 2000));
    }
    return structuredClone(value) as LearningSupport;
}
export function recallCoverage(criteria: readonly RecallCriterion[], matchedIds: readonly string[]) {
    const matched = new Set(matchedIds), total = criteria.reduce((sum, point) => sum + (point.weight ?? 1), 0), hit = criteria.filter(point => matched.has(point.id));
    const weight = hit.reduce((sum, point) => sum + (point.weight ?? 1), 0);
    return { matched: hit.map(point => point.id), missed: criteria.filter(point => !matched.has(point.id)).map(point => point.id), missingMandatory: criteria.filter(point => point.mandatory && !matched.has(point.id)).map(point => point.id), percent: total ? Math.round(weight / total * 100) : null };
}
export function capRecallRating(rating: 'again' | 'hard' | 'good' | 'easy', level: number) { return level >= 3 ? 'again' : level >= 2 && ['good', 'easy'].includes(rating) ? 'hard' : rating; }
/** AI must partition the source IDs exactly; prose is never matched heuristically. */
export function parseRecallAlignment(criteria: readonly RecallCriterion[], matched: unknown, missed: unknown) {
    const valid = new Set(criteria.map(point => point.id));
    if (!Array.isArray(matched) || !Array.isArray(missed) || [...matched, ...missed].some(id => typeof id !== 'string' || !valid.has(id)) || new Set([...matched, ...missed]).size !== matched.length + missed.length || matched.length + missed.length !== criteria.length)
        throw new Error('invalid-recall-alignment');
    return { matchedPointIds: [...matched] as string[], missedPointIds: [...missed] as string[] };
}
