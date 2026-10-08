// @ts-expect-error TS5097: standalone Node contracts.
import { studyObject, studyCount, studyDigest, studyId } from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../learning-attempt/index.ts';
export type CourseGradeRequest = {
    schemaVersion: 1;
    attemptId: string;
    taskId: string;
    taskHash: string;
    answerRevision: number;
    evidenceRevision: number;
};
/** Only source/attempt identity. Reference and answer are read from authoritative layers. */
export function parseCourseGradeRequest(raw: unknown): CourseGradeRequest {
    const row = studyObject(raw, ['schemaVersion', 'attemptId', 'taskId', 'taskHash', 'answerRevision', 'evidenceRevision']);
    if (row.schemaVersion !== 1) throw Error('unsupported-course-grade-version');
    attemptId(row.attemptId);
    studyId(row.taskId, 'course-task');
    if (String(row.taskId).length > 64 || /[^a-zA-Z0-9:_.-]/u.test(String(row.taskId))) throw Error('invalid-course-task-id');
    studyDigest(row.taskHash);
    studyCount(row.answerRevision, 'course-answer-revision');
    studyCount(row.evidenceRevision, 'course-evidence-revision', 1);
    return structuredClone(row) as CourseGradeRequest;
}
export function courseEvaluationTrace(modelId: string) {
    return { modelId: modelId.trim(), promptVersion: 'course-task-json-v1', ruleVersion: 'course-diagnostic-v1' };
}
