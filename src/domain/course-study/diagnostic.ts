import type {AttemptEvaluation} from '../learning-attempt';
import type {CourseDiagnostic, CourseEvaluationTrace, CoursePointEvidence, ResolvedCourseTask} from './model';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject, studyText, studyHash, studyDigest, studySize} from '../sync/index.ts';

const alignmentKeys = ['matchedPointIds', 'missedPointIds', 'errorPointIds', 'wrongOptionIds', 'missingOptionIds'] as const;
export function courseIdentifier(raw: unknown, maximum = 64): string {
    studyText(raw, 'course-id', maximum);
    if (/[^a-zA-Z0-9:_.-]/u.test(raw)) throw Error('invalid-course-id');
    return raw;
}
function ids(raw: unknown, maximum: number): string[] {
    if (!Array.isArray(raw) || raw.length > maximum) throw Error('invalid-course-diagnostic-ids');
    const values = Array.from(raw).map(value => courseIdentifier(value));
    if (new Set(values).size !== values.length) throw Error('duplicate-course-diagnostic-id');
    return values;
}
function text(raw: unknown, maximum: number, empty = false): string {
    studyText(raw, 'course-diagnostic-text', maximum, empty);
    return raw;
}
/** Structural only; task and original-answer checks are performed by validate. */
export function parseCourseDiagnostic(raw: unknown): CourseDiagnostic {
    studySize(raw, 65536);
    const value = raw as Record<string, unknown>;
    const unknown = value?.status === 'undetermined';
    const row = studyObject(raw, ['schemaVersion', 'status', 'source', 'feedback', ...alignmentKeys, 'pointEvidence', ...(unknown ? ['reason'] : [])]);
    if (row.schemaVersion !== 1 || typeof row.status !== 'string'
        || !['correct', 'partial', 'incorrect', 'undetermined'].includes(row.status)
        || typeof row.source !== 'string' || !(unknown ? ['model', 'deterministic', 'self-assess', 'none'] : ['model', 'deterministic', 'self-assess']).includes(row.source))
        throw Error('invalid-course-diagnostic-status');
    const alignments = Object.fromEntries(alignmentKeys.map(key => [key, ids(row[key], key.includes('Option') ? 32 : 24)]));
    const partition = ['matchedPointIds', 'missedPointIds', 'errorPointIds'].flatMap(key => alignments[key]);
    if (new Set(partition).size !== partition.length) throw Error('overlapping-course-point-partition');
    if (alignments.wrongOptionIds.some(id => alignments.missingOptionIds.includes(id))) throw Error('overlapping-course-option-gaps');
    if (!Array.isArray(row.pointEvidence) || row.pointEvidence.length > 24) throw Error('invalid-course-point-evidence');
    const evidenceIds = new Set<string>();
    const pointEvidence: CoursePointEvidence[] = Array.from(row.pointEvidence).map(entry => {
        const evidence = studyObject(entry, ['pointId', 'sourceId', 'sourceQuote', 'answerQuote', 'reason']);
        const pointId = courseIdentifier(evidence.pointId);
        if (evidenceIds.has(pointId) || !partition.includes(pointId)) throw Error('invalid-course-evidence-point');
        evidenceIds.add(pointId);
        return {pointId, sourceId: courseIdentifier(evidence.sourceId), sourceQuote: text(evidence.sourceQuote, 1000),
            answerQuote: text(evidence.answerQuote, 1000, alignments.missedPointIds.includes(pointId)), reason: text(evidence.reason, 1000)};
    });
    if (unknown) {
        if (typeof row.reason !== 'string' || !['unavailable', 'offline', 'cancelled', 'source-insufficient', 'source-conflict', 'uncertain', 'invalid-result'].includes(row.reason)
            || alignmentKeys.some(key => alignments[key].length) || pointEvidence.length) throw Error('invalid-course-unknown-diagnostic');
    } else if (row.source === 'self-assess') {
        if (alignmentKeys.some(key => alignments[key].length) || pointEvidence.length) throw Error('self-assessment-has-course-alignment');
    }
    return {...row, ...alignments, feedback: text(row.feedback, 4000), pointEvidence} as CourseDiagnostic;
}
export function parseCourseEvaluationTrace(raw: unknown): CourseEvaluationTrace | null {
    if (raw === null) return null;
    const row = studyObject(raw, ['modelId', 'promptVersion', 'ruleVersion', 'requestId'], ['provider']);
    return {modelId: text(row.modelId, 200), promptVersion: text(row.promptVersion, 120), ruleVersion: text(row.ruleVersion, 120),
        requestId: courseIdentifier(row.requestId, 120), ...(row.provider === undefined ? {} : {provider: text(row.provider, 200)})};
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every(id => b.includes(id));
}
export function validateCourseDiagnostic(raw: unknown, task: ResolvedCourseTask, answer: string): CourseDiagnostic {
    const diagnostic = parseCourseDiagnostic(raw);
    studyText(answer, 'course-original-answer', 32000, true);
    if (diagnostic.status === 'undetermined' || diagnostic.source === 'self-assess') return diagnostic;
    if (diagnostic.source === 'deterministic') {
        if (task.mode !== 'quiz') throw Error('deterministic-course-recall-forbidden');
        const computed = deterministicCourseDiagnostic(task, answer);
        if (diagnostic.status !== computed.status || !sameSet(diagnostic.wrongOptionIds, computed.wrongOptionIds)
            || !sameSet(diagnostic.missingOptionIds, computed.missingOptionIds)
            || diagnostic.matchedPointIds.length || diagnostic.missedPointIds.length || diagnostic.errorPointIds.length
            || diagnostic.pointEvidence.length) throw Error('inconsistent-course-quiz-diagnostic');
        return diagnostic;
    }
    if (task.mode !== 'recall' || diagnostic.wrongOptionIds.length || diagnostic.missingOptionIds.length)
        throw Error('model-course-quiz-forbidden');
    const partition = [...diagnostic.matchedPointIds, ...diagnostic.missedPointIds, ...diagnostic.errorPointIds];
    if (!sameSet(partition, task.criteria.map(point => point.id))) throw Error('invalid-course-point-partition');
    const covered = new Set(diagnostic.pointEvidence.map(row => row.pointId));
    if ([...diagnostic.matchedPointIds, ...diagnostic.errorPointIds].some(id => !covered.has(id)))
        throw Error('missing-course-point-evidence');
    for (const evidence of diagnostic.pointEvidence) {
        const point = task.criteria.find(row => row.id === evidence.pointId);
        const source = task.sources.find(row => row.sourceId === evidence.sourceId);
        if (!point?.sourceIds.includes(evidence.sourceId) || !source?.excerpt.includes(evidence.sourceQuote)
            || !answer.includes(evidence.answerQuote)) throw Error('invalid-course-quote-binding');
    }
    const gaps = diagnostic.errorPointIds.length + diagnostic.missedPointIds.length;
    const mandatoryMissing = task.criteria.some(point => point.mandatory && diagnostic.missedPointIds.includes(point.id));
    if (diagnostic.status === 'correct' && (diagnostic.errorPointIds.length || mandatoryMissing)
        || diagnostic.status === 'partial' && (!diagnostic.matchedPointIds.length || !gaps)
        || diagnostic.status === 'incorrect' && !gaps) throw Error('inconsistent-course-diagnostic-status');
    return diagnostic;
}
export function deterministicCourseDiagnostic(task: ResolvedCourseTask, answerJSON: string): CourseDiagnostic {
    if (task.mode !== 'quiz' || !task.options || !task.correctOptionIds || !task.selection) throw Error('course-quiz-task-required');
    studyText(answerJSON, 'course-quiz-answer', 32000);
    let raw: unknown;
    try { raw = JSON.parse(answerJSON); } catch { throw Error('invalid-course-quiz-answer'); }
    const selected = ids(raw, 32), known = new Set(task.options.map(option => option.optionId));
    if (selected.some(id => !known.has(id)) || task.selection === 'single' && selected.length > 1)
        throw Error('invalid-course-quiz-selection');
    const wrongOptionIds = task.options.filter(option => selected.includes(option.optionId) && !task.correctOptionIds!.includes(option.optionId)).map(option => option.optionId);
    const missingOptionIds = task.correctOptionIds.filter(id => !selected.includes(id));
    const matched = selected.some(id => task.correctOptionIds!.includes(id));
    const status = !wrongOptionIds.length && !missingOptionIds.length ? 'correct' : matched && !wrongOptionIds.length ? 'partial' : 'incorrect';
    const explanations = task.options.filter(option => wrongOptionIds.includes(option.optionId) || missingOptionIds.includes(option.optionId)).map(option => option.explanation);
    return {schemaVersion: 1, status, source: 'deterministic', feedback: explanations.length ? explanations.join('\n').slice(0, 4000) : '原选项核对正确。',
        matchedPointIds: [], missedPointIds: [], errorPointIds: [], wrongOptionIds, missingOptionIds, pointEvidence: []};
}
export function courseDiagnosticOutcome(diagnostic: CourseDiagnostic): {
    status: CourseDiagnostic['status']; source: 'model' | 'deterministic' | 'self-assess';
    explanation: string; rating?: 'good' | 'hard' | 'again';
} {
    if (diagnostic.status === 'undetermined') return {status: 'undetermined', source: 'model', explanation: diagnostic.feedback};
    return {status: diagnostic.status, source: diagnostic.source, explanation: diagnostic.feedback,
        rating: {correct: 'good', partial: 'hard', incorrect: 'again'}[diagnostic.status] as 'good' | 'hard' | 'again'};
}
export function attemptEvaluationForDiagnostic(diagnostic: CourseDiagnostic, contentHash: string): AttemptEvaluation {
    studyDigest(contentHash);
    if (diagnostic.status === 'undetermined') return {status: 'pending', reason: diagnostic.reason === 'offline' ? 'offline' :
        ['source-insufficient', 'source-conflict'].includes(diagnostic.reason) ? 'no-reference' : 'invalid', feedback: diagnostic.feedback};
    const outcome = courseDiagnosticOutcome(diagnostic);
    return {status: 'resolved', rating: outcome.rating!, correct: diagnostic.status === 'correct', outcome: diagnostic.status,
        source: diagnostic.source, feedback: diagnostic.feedback, evaluationHash: '', referenceHash: contentHash};
}
export function courseDiagnosticHash(diagnostic: CourseDiagnostic, trace: CourseEvaluationTrace | null): Promise<string> {
    return studyHash({diagnostic, trace});
}
