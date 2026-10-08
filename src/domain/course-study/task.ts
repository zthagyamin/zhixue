import type {StudyItemVersion} from '../sync';
import type {NativeCourseItem} from './native-source';
import type {CourseRecallSupport, QuizSupportV2, CourseRemediation} from '../content';
import type {CourseDiagnostic, ResolvedCourseTask} from './model';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseLearningSupport, courseTaskReadiness} from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash} from '../sync/index.ts';

export type CourseSupportV2 = CourseRecallSupport | QuizSupportV2;
export type CourseSourceItem = StudyItemVersion | NativeCourseItem;
/** Original snapshot only: no legacy fallback and no presentation override. */
export function resolveCourseSupportV2(item: CourseSourceItem): CourseSupportV2 {
    if (item.schemaVersion !== 2 || item.kind !== 'practice' || item.eventKind === 'word'
        || !['recall', 'quiz'].includes(item.practice.questionType)) throw Error('unsupported-course-item');
    if (['answer', 'explanation', 'reviewPoint', 'options'].some(key => Object.hasOwn(item.practice, key)))
        throw Error('duplicate-course-reference');
    const parsed = parseLearningSupport(item.learningSupport, item.practice.questionType);
    if (parsed.schemaVersion !== 2 || !['recall', 'quiz'].includes(parsed.type) || !('task' in parsed))
        throw Error('unsupported-course-support');
    const support = parsed as CourseSupportV2;
    const issues = courseTaskReadiness(support.task, item.practice.prompt);
    if (issues.length) throw Error(issues[0]);
    return support;
}
export function resolveCourseTask(item: CourseSourceItem, taskId?: string): ResolvedCourseTask {
    const support = resolveCourseSupportV2(item), parent = support.task;
    const child = taskId && taskId !== parent.taskId ? parent.remediations.find(row => row.taskId === taskId) : null;
    if (taskId && taskId !== parent.taskId && !child) throw Error('course-task-not-found');
    const task = child ?? parent;
    if (child) {
        const issues = courseTaskReadiness({...parent, ...child}, child.prompt);
        if (issues.length) throw Error(issues[0]);
    }
    return structuredClone({schemaVersion: 1, taskId: task.taskId, mode: child ? 'recall' : support.type,
        kind: task.kind, prompt: task.prompt, scope: task.scope, conditions: task.conditions,
        sources: parent.sources, criteria: child ? child.criteria : support.criteria,
        answer: child ? child.answer : support.criteria.map(point => point.text).join('\n'),
        ...(!child && support.type === 'quiz' ? {options: support.options, selection: support.selection,
            correctOptionIds: support.correctOptionIds} : {})}) as ResolvedCourseTask;
}
export function courseTaskHash(task: ResolvedCourseTask): Promise<string> { return studyHash(task); }

/** Pick one authored mapping in criterion/option author order; no runtime invention. */
export function chooseCourseRemediation(support: CourseSupportV2, diagnostic: CourseDiagnostic): CourseRemediation | null {
    if (support.task.reviewStatus !== 'verified' || diagnostic.status === 'undetermined'
        || !['model', 'deterministic'].includes(diagnostic.source) || diagnostic.status === 'correct') return null;
    const gaps = new Set([...diagnostic.missedPointIds, ...diagnostic.errorPointIds]);
    const priorities = [
        ...support.criteria.filter(point => point.mandatory && diagnostic.missedPointIds.includes(point.id)),
        ...support.criteria.filter(point => diagnostic.errorPointIds.includes(point.id)),
        ...support.criteria.filter(point => gaps.has(point.id)),
    ];
    for (const point of priorities) {
        const child = support.task.remediations.find(row => row.targetPointIds.includes(point.id));
        if (child) return structuredClone(child);
    }
    if (support.type === 'quiz') {
        for (const option of support.options) {
            const child = support.task.remediations.find(row =>
                diagnostic.wrongOptionIds.includes(option.optionId) && row.wrongOptionIds.includes(option.optionId)
                || diagnostic.missingOptionIds.includes(option.optionId) && row.missingOptionIds.includes(option.optionId));
            if (child) return structuredClone(child);
        }
    }
    return null;
}
