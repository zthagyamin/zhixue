export const QUIZ_TRAPS = { concept_substitution: '偷换概念', reverse_causality: '因果倒置', overgeneralization: '以偏概全', out_of_scope: '过度推论', superficial_similarity: '字面相似' } as const;
export type QuizOption = {
    optionId: string;
    text: string;
    trapType?: keyof typeof QUIZ_TRAPS;
    trapExplanation?: string;
};
// @ts-expect-error TS5097: standalone Node contract tests.
import { courseObject, courseText, courseReferences, parseCourseTask, type CourseTask, type CourseCriterion } from './course-task-support.ts';
export type QuizSupportV1 = {
    schemaVersion: 1;
    type: 'quiz';
    selection: 'single' | 'multiple';
    options: QuizOption[];
    correctOptionIds: string[];
    criteria?: never;
    hints?: never;
};
export type QuizSupportV2 = Omit<QuizSupportV1, 'schemaVersion' | 'options' | 'criteria'> & {
    schemaVersion: 2;
    options: (QuizOption & { explanation: string; sourceIds: string[] })[];
    criteria: CourseCriterion[];
    task: CourseTask;
};
export type QuizSupport = QuizSupportV1 | QuizSupportV2;
function closed(raw: unknown, keys: string[]) { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key)))
    throw Error('invalid-quiz-support'); return raw as Record<string, unknown>; }
function text(raw: unknown, max: number) { if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\p{Cc}]/u.test(raw))
    throw Error('invalid-quiz-text'); return raw; }
export function parseQuizSupport(raw: unknown): QuizSupport {
    if (raw && typeof raw === 'object' && (raw as {schemaVersion?: unknown}).schemaVersion === 2)
        return parseCourseQuizSupport(raw);
    const value = closed(raw, ['schemaVersion', 'type', 'selection', 'options', 'correctOptionIds']);
    if (value.schemaVersion !== 1 || value.type !== 'quiz' || typeof value.selection !== 'string' || !['single', 'multiple'].includes(value.selection))
        throw Error('unsupported-quiz-support');
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 32)
        throw Error('invalid-quiz-options');
    const ids = new Set<string>();
    for (const rawOption of value.options) {
        const option = closed(rawOption, ['optionId', 'text', 'trapType', 'trapExplanation']), id = text(option.optionId, 64);
        if (!/^[a-zA-Z0-9:_.-]+$/.test(id) || ids.has(id))
            throw Error('invalid-quiz-option-id');
        ids.add(id);
        text(option.text, 8000);
        if (option.trapType !== undefined && (typeof option.trapType !== 'string' || !Object.hasOwn(QUIZ_TRAPS, option.trapType)))
            throw Error('invalid-quiz-trap');
        if (option.trapExplanation !== undefined)
            text(option.trapExplanation, 2000);
    }
    const answers = value.correctOptionIds;
    if (!Array.isArray(answers) || !answers.length || answers.length > 32 || answers.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(answers).size !== answers.length || value.selection === 'single' && answers.length !== 1)
        throw Error('invalid-quiz-answer-ids');
    return structuredClone(value) as QuizSupport;
}
function parseCourseQuizSupport(raw: unknown): QuizSupportV2 {
    const row = courseObject(raw, ['schemaVersion', 'type', 'selection', 'options', 'correctOptionIds', 'criteria', 'task']);
    if (row.type !== 'quiz' || !Array.isArray(row.options)) throw Error('unsupported-course-quiz-support');
    const options = row.options.map(entry => courseObject(entry, ['optionId', 'text', 'explanation', 'sourceIds'], ['trapType', 'trapExplanation']));
    const base = parseQuizSupport({ schemaVersion: 1, type: row.type, selection: row.selection,
        correctOptionIds: row.correctOptionIds, options: options.map(option => ({ optionId: option.optionId, text: option.text,
            ...(Object.hasOwn(option, 'trapType') ? { trapType: option.trapType } : {}),
            ...(Object.hasOwn(option, 'trapExplanation') ? { trapExplanation: option.trapExplanation } : {}) })) });
    const { task } = parseCourseTask(row.task, row.criteria, base.options.map(option => option.optionId));
    const sourceIds = new Set(task.sources.map(source => source.sourceId)), texts = new Set<string>();
    for (const option of options) {
        courseText(option.explanation, 2000);
        courseReferences(option.sourceIds, sourceIds, 12);
        const normalized = String(option.text).normalize('NFC').replace(/\s+/gu, ' ').trim();
        if (texts.has(normalized)) throw Error('duplicate-course-quiz-text');
        texts.add(normalized);
    }
    return structuredClone(row) as QuizSupportV2;
}
export function gradeQuizSelection(support: QuizSupport, selected: readonly string[]): boolean { return selected.length === support.correctOptionIds.length && new Set(selected).size === selected.length && selected.every(id => support.correctOptionIds.includes(id)); }
export type StemHighlight = {
    start: number;
    end: number;
};
export function mergeStemHighlight(existing: readonly StemHighlight[], range: StemHighlight, length: number): StemHighlight[] {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > length || range.start >= range.end)
        return [...existing];
    const sorted = [...existing, range].sort((a, b) => a.start - b.start), out: StemHighlight[] = [];
    for (const item of sorted) {
        const last = out.at(-1);
        if (last && item.start <= last.end)
            last.end = Math.max(last.end, item.end);
        else
            out.push({ ...item });
    }
    return out.slice(0, 64);
}
