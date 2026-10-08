import type { CourseEvidenceMutation } from '../../domain/course-study';
import type { CourseEvidenceCloudPort } from '../../application/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCourseEvidenceMutation } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { assertCourseScope, validateCourseAggregate, validateCourseReceipt } from './validation.ts';

export function createAccountCourseEvidenceClient(options: { ownerId: string; libraryId: string; fetcher?: typeof fetch }): CourseEvidenceCloudPort {
    attemptId(options.ownerId); attemptId(options.libraryId);
    const scope = { userId: options.ownerId, libraryId: options.libraryId };
    const send = async (action: string, body: Record<string, unknown>) => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await (options.fetcher ?? fetch)('/api/account-study', { method: 'POST', credentials: 'same-origin', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body, libraryId: options.libraryId, expectedUserId: options.ownerId }) });
            const result = await response.json() as Record<string, unknown>;
            if (!response.ok) {
                const code = result.error === 'unsupported-action' || result.error === 'unsupported-course-evidence'
                    ? 'course-evidence-unsupported' : String(result.error ?? 'course-evidence-request-failed');
                throw Object.assign(Error(code), { status: response.status });
            }
            return result;
        } finally { clearTimeout(timer); }
    };
    return {
        async read(id: string) {
            const result = await send('course-evidence-read', { attemptId: attemptId(id) });
            if (result.evidence === null) return null;
            const evidence = await validateCourseAggregate(scope, result.evidence);
            if (evidence.attemptId !== id) throw Error('course-evidence-record-binding');
            return evidence;
        },
        async mutate(raw: CourseEvidenceMutation) {
            const mutation = parseCourseEvidenceMutation(raw); assertCourseScope(scope, mutation);
            return validateCourseReceipt(scope, await send('course-evidence-mutate', { mutation }), mutation);
        },
    };
}
