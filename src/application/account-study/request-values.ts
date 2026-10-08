// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyObject, studyId, studyCount } from '../../domain/sync/index.ts';
export function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    try {
        return studyObject(value, required, optional);
    }
    catch {
        throw new ApiFailure(400, 'invalid-request-fields');
    }
}
export function id(value: unknown, label: string): string {
    try {
        studyId(value, label);
        return value;
    }
    catch {
        throw new ApiFailure(400, `invalid-${label}`);
    }
}
export function count(value: unknown, label: string, min = 0): number {
    try {
        studyCount(value, label, min);
        return value;
    }
    catch {
        throw new ApiFailure(400, `invalid-${label}`);
    }
}
export function queryCount(value: string | undefined, label: string, fallback: number): number {
    if (value === undefined)
        return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value))
        throw new ApiFailure(400, `invalid-${label}`);
    return count(Number(value), label);
}
export async function validated<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    }
    catch {
        throw new ApiFailure(400, 'invalid-study-payload');
    }
}
