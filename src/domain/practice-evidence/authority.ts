// @ts-expect-error TS5097: standalone Node contracts.
import { canonicalAttemptJson, parseAttemptBinding } from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCalculationSupport } from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createMappedMathVariant } from '../guided-math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { gradeCalculationStep } from '../math-step/index.ts';
import type { PracticeEvidenceAuthority, PracticeEvidenceDiagnostic, PracticeEvidenceV1, PracticeVariantRecoveryV1 } from './model';
export const evidenceEqual = (a: unknown, b: unknown): boolean => canonicalAttemptJson(a) === canonicalAttemptJson(b);
export async function practiceEvidenceFingerprint(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalAttemptJson(value)));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export function validateEvidenceAttempt(id: string, binding: unknown, authority: PracticeEvidenceAuthority): void {
    const a = authority.attempt;
    if (!a || a.schemaVersion !== 1 || a.attemptId !== id || !evidenceEqual(parseAttemptBinding(a.binding), binding))
        throw Error('practice-evidence-attempt-binding');
    if (!Number.isSafeInteger(a.answerRevision) || a.answerRevision < 0 || a.submitted && a.submitted.answerRevision !== a.answerRevision)
        throw Error('practice-evidence-answer-revision');
}
export function validateEvidenceSource(authority: PracticeEvidenceAuthority) {
    if (!authority.source || !evidenceEqual(parseAttemptBinding(authority.source.binding), authority.attempt.binding))
        throw Error('practice-evidence-source-binding');
    const support = parseCalculationSupport(authority.source.calculation);
    if (support.schemaVersion !== 2)
        throw Error('practice-evidence-source-version');
    return support;
}
export function validateEvidenceDiagnostic(d: PracticeEvidenceDiagnostic, stepRevision: number, authority: PracticeEvidenceAuthority): void {
    const support = validateEvidenceSource(authority), a = authority.attempt;
    if (!a.submitted)
        throw Error('practice-evidence-answer-not-submitted');
    if (d.answerRevision !== a.submitted.answerRevision || d.stepRevision !== stepRevision || d.sourceVersion !== a.binding.contentHash || d.stepId !== support.step?.stepId)
        throw Error('practice-evidence-diagnostic-source-identity');
    if (d.source === 'model' && !evidenceEqual(d, authority.modelDiagnostic))
        throw Error('practice-evidence-model-write-port-required');
    if (d.source === 'deterministic' && support.step?.mode === 'semantic' && d.status !== 'undetermined')
        throw Error('practice-evidence-diagnostic-mode');
}
export async function validateEvidenceVariant(v: PracticeVariantRecoveryV1, authority: PracticeEvidenceAuthority): Promise<void> {
    const support = validateEvidenceSource(authority), a = authority.attempt;
    if (a.checkpoint.purpose !== 'remediation' || !a.parentAttemptId || a.parentAttemptId === a.attemptId)
        throw Error('practice-evidence-variant-remediation-required');
    const parent = authority.parentAttempt;
    if (!parent || parent.schemaVersion !== 1 || parent.attemptId !== a.parentAttemptId
        || parent.checkpoint.mode !== 'calculation' || !parent.submitted
        || !Number.isSafeInteger(parent.answerRevision) || parent.answerRevision < 0
        || parent.submitted.answerRevision !== parent.answerRevision || parent.submitted.answer !== parent.answer
        || !evidenceEqual(parseAttemptBinding(parent.binding), a.binding))
        throw Error('practice-evidence-variant-parent-authority');
    if (v.parentItemKey !== a.binding.itemKey || v.parentContentHash !== a.binding.contentHash)
        throw Error('practice-evidence-variant-parent');
    const mapped = await createMappedMathVariant({ parent: { parentItemKey: v.parentItemKey, parentContentHash: v.parentContentHash, hashKind: v.hashKind }, support, mapping: authority.source?.mapping, seed: v.seed });
    if (mapped.status !== 'available' || mapped.mappingId !== v.mappingId || mapped.variant.templateId !== v.templateId || mapped.variant.variantHash !== v.variantHash || !evidenceEqual(mapped.variant.parameters, v.parameters))
        throw Error('practice-evidence-variant-source');
}
/** Complete hydration identity validation, without granting a fresh model write. */
export async function validatePracticeEvidenceAuthority(record: PracticeEvidenceV1, authority: PracticeEvidenceAuthority): Promise<void> {
    validateEvidenceAttempt(record.attemptId, record.binding, authority);
    const a = authority.attempt, e = record.execution;
    if (e && a.checkpoint.mode !== 'code' || (record.calculation || record.variant) && a.checkpoint.mode !== 'calculation')
        throw Error('practice-evidence-mode');
    for (const report of [e?.first, e?.latest])
        if (report) {
            const i = report.identity;
            if (!a.submitted || !i || i.attemptId !== a.attemptId || i.revision !== a.submitted.answerRevision || i.sourceVersion !== a.binding.contentHash || i.testVersion !== a.binding.contentHash)
                throw Error('practice-evidence-report-identity');
        }
    if (e?.prepared) {
        const child = authority.preparedChild;
        if (!child || child.schemaVersion !== 1 || child.attemptId !== e.prepared.attemptId || child.parentAttemptId !== a.attemptId || !child.submitted || !evidenceEqual(child.binding, a.binding) || child.checkpoint.mode !== 'code')
            throw Error('practice-evidence-child-pointer');
    }
    if (e?.hint) {
        const reports = [e.first, e.latest].filter(r => r?.runId === e.hint?.runId);
        if (!reports.length || e.hint.caseId !== undefined && !reports.some(r => r?.firstFailure?.caseId === e.hint?.caseId))
            throw Error('practice-evidence-hint-identity');
    }
    if (record.calculation) {
        const support = validateEvidenceSource(authority);
        if (!support.step)
            throw Error('practice-evidence-source-step');
        if (record.calculation.diagnostic) {
            const d = record.calculation.diagnostic;
            validateEvidenceDiagnostic(d, record.calculation.stepInput.revision, { ...authority, modelDiagnostic: d });
            if (d.source === 'deterministic' && d.status !== gradeCalculationStep(record.calculation.stepInput.text, support).status)
                throw Error('practice-evidence-diagnostic-result');
        }
    }
    if (record.variant)
        await validateEvidenceVariant(record.variant, authority);
}
