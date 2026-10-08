// @ts-expect-error TS5097: standalone Node contracts.
import {parseCodeLearningSupportV1} from './code-learning-support.ts';

/** Execution prerequisites only; sandbox results remain authoritative. */
export function hasExecutableCodeMaterial(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const data = raw as Record<string, unknown>;
    if (typeof data.initialCode !== 'string' || !data.initialCode.trim()) return false;
    const support = data.learningSupport;
    if (support && typeof support === 'object' && (support as Record<string, unknown>).type === 'code') {
        try {
            parseCodeLearningSupportV1(support);
            return true;
        } catch {
            return false;
        }
    }
    return typeof data.testCode === 'string' && Boolean(data.testCode.trim());
}
