// @ts-expect-error TS5097: standalone Node contracts.
import { parsePracticeEvidence, parsePracticeEvidenceMutation, PRACTICE_EVIDENCE_LIMITS } from './parse.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { evidenceEqual, practiceEvidenceFingerprint, validateEvidenceAttempt, validateEvidenceDiagnostic, validateEvidenceSource, validateEvidenceVariant, validatePracticeEvidenceAuthority } from './authority.ts';
import type { PracticeEvidenceAuthority, PracticeEvidenceV1, PracticeEvidenceMutationV1, PracticeEvidenceReceipt } from './model';
export async function applyPracticeEvidenceMutation(current: PracticeEvidenceV1 | null, raw: PracticeEvidenceMutationV1, authority: PracticeEvidenceAuthority): Promise<PracticeEvidenceReceipt> {
    const m = parsePracticeEvidenceMutation(raw), fingerprint = await practiceEvidenceFingerprint(m);
    const record = current === null ? null : parsePracticeEvidence(current);
    validateEvidenceAttempt(m.attemptId, m.binding, authority);
    if (record && (!evidenceEqual(record.binding, m.binding) || record.attemptId !== m.attemptId))
        throw Error('practice-evidence-binding');
    const receipt = (status: PracticeEvidenceReceipt['status']): PracticeEvidenceReceipt => ({ status, durable: false, operationId: m.operationId, revision: record?.revision ?? 0, record });
    const known = record?.operations.find(o => o.operationId === m.operationId);
    if (known)
        return receipt(known.fingerprint === fingerprint ? 'duplicate' : 'conflict');
    if (m.expectedRevision !== (record?.revision ?? 0) || record && record.operations.length >= PRACTICE_EVIDENCE_LIMITS.operations)
        return receipt('conflict');
    if (record) {
        const retargeting = m.kind === 'execution-pointer' && record.execution?.prepared?.attemptId !== m.prepared.attemptId;
        await validatePracticeEvidenceAuthority(record, {
            ...authority,
            preparedChild: authority.currentPreparedChild ?? (retargeting ? undefined : authority.preparedChild)
        });
    }
    const a = authority.attempt, next: PracticeEvidenceV1 = record ? structuredClone(record) : { schemaVersion: 1, attemptId: m.attemptId, binding: m.binding, revision: 0, updatedAt: m.updatedAt, operations: [] };
    if (['code-report', 'code-hint', 'execution-pointer'].includes(m.kind) && a.checkpoint.mode !== 'code' || ['step-input', 'step-diagnostic', 'variant'].includes(m.kind) && a.checkpoint.mode !== 'calculation')
        throw Error('practice-evidence-mode');
    switch (m.kind) {
        case 'execution-pointer':
            next.execution = { ...next.execution, prepared: m.prepared };
            break;
        case 'code-report': {
            if (!a.submitted)
                throw Error('practice-evidence-answer-not-submitted');
            if (a.formal)
                return receipt('conflict');
            const i = m.report.identity;
            if (!i || i.attemptId !== a.attemptId || i.revision !== a.submitted.answerRevision || i.sourceVersion !== a.binding.contentHash || i.testVersion !== a.binding.contentHash)
                throw Error('practice-evidence-report-identity');
            const firstObserved = next.execution?.first === undefined;
            const sameObservation = evidenceEqual(next.execution?.latest, m.report)
                && evidenceEqual(next.execution?.latestOutput, m.output);
            next.execution = {
                ...next.execution, first: next.execution?.first ?? m.report, latest: m.report,
                ...(firstObserved && m.output !== undefined ? { firstOutput: m.output } : {})
            };
            if (m.output === undefined)
                delete next.execution.latestOutput;
            else
                next.execution.latestOutput = m.output;
            // Run and case IDs are page-local and can repeat after refresh. The single
            // current hint remains valid only for the exact same report and full output.
            if (!sameObservation)
                delete next.execution.hint;
            break;
        }
        case 'code-hint':
            if (m.hint.source === 'model' && !evidenceEqual(m.hint, authority.modelHint))
                throw Error('practice-evidence-model-write-port-required');
            next.execution = { ...next.execution, hint: m.hint };
            break;
        case 'step-input': {
            const s = next.calculation?.stepInput;
            if (a.submitted && (!s || s.text !== m.text))
                return receipt('conflict');
            if (!validateEvidenceSource(authority).step)
                throw Error('practice-evidence-source-step');
            if (!s || s.text !== m.text)
                next.calculation = { stepInput: { text: m.text, revision: (s?.revision ?? 0) + 1 } };
            break;
        }
        case 'step-diagnostic': {
            if (!next.calculation)
                throw Error('practice-evidence-step-input-required');
            validateEvidenceDiagnostic(m.diagnostic, next.calculation.stepInput.revision, authority);
            const old = next.calculation.diagnostic;
            if (old && old.status !== 'undetermined' && !evidenceEqual(old, m.diagnostic))
                return receipt('conflict');
            if (a.formal && m.diagnostic.status === 'undetermined' && !evidenceEqual(old, m.diagnostic))
                return receipt('conflict');
            next.calculation.diagnostic = m.diagnostic;
            break;
        }
        case 'variant':
            await validateEvidenceVariant(m.variant, authority);
            if (next.variant && !evidenceEqual(next.variant, m.variant))
                return receipt('conflict');
            next.variant = m.variant;
            break;
    }
    next.revision++;
    next.updatedAt = m.updatedAt;
    next.operations.push({ operationId: m.operationId, fingerprint, revision: next.revision });
    const validated = parsePracticeEvidence(next);
    await validatePracticeEvidenceAuthority(validated, authority);
    return { status: 'accepted', durable: false, operationId: m.operationId, revision: validated.revision, record: validated };
}
