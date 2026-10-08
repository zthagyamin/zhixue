import type { FSRSRating, GradePayload } from './contracts';
import type { RecallCriterion } from '../content/index';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseRecallAlignment, recallCoverage } from '../content/index.ts';
/** Validation version, not a new scheduling policy. No persistent schema changes. */
export const RECALL_EVALUATION_VERSION = 'recall-evaluation-v1';
export type RecallEvaluation = {
    status: 'complete' | 'partial' | 'incorrect';
    rating: FSRSRating;
    coverage: ReturnType<typeof recallCoverage> | null;
};
/** Do not resolve contradictory evidence by silently choosing a lower grade. */
export function validateRecallEvaluation(raw: unknown, criteria: readonly RecallCriterion[] = []): RecallEvaluation {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('recall-evaluation-invalid-result');
    const result = raw as GradePayload;
    const verdicts: Record<string, RecallEvaluation['status']> = { correct: 'complete', partial: 'partial', wrong: 'incorrect', incorrect: 'incorrect' };
    const ratings: Record<FSRSRating, RecallEvaluation['status']> = { again: 'incorrect', hard: 'partial', good: 'complete', easy: 'complete' };
    if (result.source === 'self-assess')
        throw Error('recall-evaluation-undetermined');
    const hasVerdict = result.verdict !== undefined, hasRating = result.rating !== undefined;
    if (hasVerdict && (typeof result.verdict !== 'string' || !Object.hasOwn(verdicts, result.verdict)))
        throw Error('recall-evaluation-invalid-verdict');
    if (hasRating && (typeof result.rating !== 'string' || !Object.hasOwn(ratings, result.rating)))
        throw Error('recall-evaluation-invalid-rating');
    if (result.correct !== undefined && result.correct !== null && typeof result.correct !== 'boolean')
        throw Error('recall-evaluation-invalid-correct');
    const status = hasVerdict ? verdicts[result.verdict!] : hasRating ? ratings[result.rating!] :
        result.correct === true ? 'complete' : result.correct === false ? 'incorrect' : undefined;
    if (!status)
        throw Error('recall-evaluation-undetermined');
    if (hasRating && ratings[result.rating!] !== status)
        throw Error('recall-evaluation-conflicting-rating');
    // Existing contract: `correct` means fully correct, so partial + false is valid.
    if (typeof result.correct === 'boolean' && result.correct !== (status === 'complete'))
        throw Error('recall-evaluation-conflicting-correct');
    let coverage: RecallEvaluation['coverage'] = null;
    if (criteria.length) {
        const alignment = parseRecallAlignment(criteria, result.matchedPointIds, result.missedPointIds);
        coverage = recallCoverage(criteria, alignment.matchedPointIds);
        if (status === 'complete' && coverage.missingMandatory.length)
            throw Error('recall-evaluation-missing-mandatory');
    }
    else if (result.matchedPointIds !== undefined || result.missedPointIds !== undefined) {
        // Do not accept invented alignment even when this old item has no rubric.
        parseRecallAlignment([], result.matchedPointIds, result.missedPointIds);
    }
    const rating = result.rating ?? ({ complete: 'good', partial: 'hard', incorrect: 'again' } as const)[status];
    return { status, rating, coverage };
}
export function recallEvaluationNotice(): string {
    return '本次 AI 评价与评分依据不一致，未自动计分。请对照参考要点自评。';
}
/** AI suggestions keep the existing three-value contract; manual FSRS choices are separate. */
export function validateRecallModelEvaluation(raw: unknown, criteria: readonly RecallCriterion[] = []): RecallEvaluation {
    if (raw && typeof raw === 'object' && (raw as {
        rating?: unknown;
    }).rating === 'easy')
        throw Error('recall-evaluation-model-rating');
    return validateRecallEvaluation(raw, criteria);
}
