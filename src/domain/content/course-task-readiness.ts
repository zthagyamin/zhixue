import type { CourseTask } from './course-task-support';
// @ts-expect-error TS5097: standalone Node source contracts.
import { needsConcreteRecallQuestion } from './recall-content.ts';

/** Shared by presentation and formal acceptance. Call on structurally parsed V2. */
export function courseTaskReadiness(task: CourseTask, prompt: string, word = false): string[] {
    const issues: string[] = [];
    const normalized = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (word) issues.push('course-task-word');
    if (task.reviewStatus !== 'verified') issues.push('course-task-unreviewed');
    if (normalized(prompt) !== normalized(task.prompt)) issues.push('course-task-prompt-mismatch');
    if (['conditions', 'application'].includes(task.kind) && !task.conditions.length) issues.push('course-task-missing-conditions');
    if (needsConcreteRecallQuestion({ prompt: normalized(task.prompt) })) issues.push('unfocused-recall-question');
    return issues;
}
