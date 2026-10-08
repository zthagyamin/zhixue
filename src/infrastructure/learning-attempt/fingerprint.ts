// @ts-expect-error TS5097: standalone Node contracts.
import { canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
export async function attemptFingerprint(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalAttemptJson(value)));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
export async function evaluationFingerprint(value: {
    status: 'resolved';
    rating: string;
    correct: boolean;
    outcome: string;
    source: string;
    feedback: string;
    referenceHash: string;
}): Promise<string> {
    return attemptFingerprint({ status: value.status, rating: value.rating, correct: value.correct, outcome: value.outcome, source: value.source, feedback: value.feedback, referenceHash: value.referenceHash });
}
