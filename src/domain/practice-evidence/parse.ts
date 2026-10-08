// @ts-expect-error TS5097: standalone Node contracts.
import { parseAttemptBinding, attemptId } from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCodeRunReport } from '../code-execution/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseMathVariantMapping } from '../guided-math/index.ts';
import type { PracticeEvidenceV1, PracticeEvidenceMutationV1, PracticeEvidenceHint, PracticeEvidenceDiagnostic, PracticeVariantRecoveryV1, PreparedPracticeEvidenceChild } from './model';
export const PRACTICE_EVIDENCE_LIMITS = { bytes: 128 * 1024, operations: 256, step: 8000, hint: 2000, explanation: 4000, output: 20000 } as const;
/** Reject inherited fields, accessors, sparse arrays, cycles, unsafe keys and non-JSON values. */
export function validatePracticeEvidenceTree(raw: unknown, seen = new Set<object>(), depth = 0): void {
    if (depth > 32)
        throw Error('practice-evidence-depth');
    if (raw === null || typeof raw === 'string' || typeof raw === 'boolean')
        return;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw))
            throw Error('practice-evidence-number');
        return;
    }
    if (!raw || typeof raw !== 'object' || seen.has(raw))
        throw Error('practice-evidence-json');
    seen.add(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
    if (Array.isArray(raw)) {
        if (Object.getPrototypeOf(raw) !== Array.prototype || keys.length !== raw.length + 1 || keys.some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))
            throw Error('practice-evidence-array');
    }
    else if (![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
        throw Error('practice-evidence-prototype');
    for (const key of keys) {
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
            throw Error('practice-evidence-unsafe-key');
        const d = descriptors[key];
        if (!('value' in d) || (!d.enumerable && !(Array.isArray(raw) && key === 'length')))
            throw Error('practice-evidence-property');
        if (key !== 'length' || !Array.isArray(raw))
            validatePracticeEvidenceTree(d.value, seen, depth + 1);
    }
    seen.delete(raw);
}
export function evidenceObject(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || required.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key)))
        throw Error('practice-evidence-fields');
    return raw as Record<string, unknown>;
}
export function evidenceInteger(raw: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)
        throw Error('practice-evidence-integer');
    return raw;
}
function text(raw: unknown, max: number): string { if (typeof raw !== 'string' || raw.length > max)
    throw Error('practice-evidence-text'); return raw; }
function digest(raw: unknown): string { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw))
    throw Error('practice-evidence-hash'); return raw; }
function date(raw: unknown): string { if (typeof raw !== 'string' || raw.length > 64 || !Number.isFinite(Date.parse(raw)))
    throw Error('practice-evidence-date'); return raw; }
function prepared(raw: unknown): PreparedPracticeEvidenceChild { const r = evidenceObject(raw, ['instanceId', 'attemptId']); return { instanceId: attemptId(r.instanceId), attemptId: attemptId(r.attemptId) }; }
export function parsePracticeEvidenceHint(raw: unknown): PracticeEvidenceHint {
    const r = evidenceObject(raw, ['runId', 'text', 'source'], ['caseId']);
    if (!['preset', 'model'].includes(r.source as string))
        throw Error('practice-evidence-hint-source');
    return { runId: evidenceInteger(r.runId, 1), text: text(r.text, PRACTICE_EVIDENCE_LIMITS.hint), source: r.source as 'preset', ...(r.caseId === undefined ? {} : { caseId: attemptId(r.caseId) }) };
}
export function parsePracticeEvidenceDiagnostic(raw: unknown): PracticeEvidenceDiagnostic {
    const r = evidenceObject(raw, ['answerRevision', 'stepRevision', 'stepId', 'sourceVersion', 'status', 'source', 'explanation']);
    if (!['correct', 'incorrect', 'undetermined'].includes(r.status as string) || !['deterministic', 'model', 'none'].includes(r.source as string) || r.source === 'none' && r.status !== 'undetermined')
        throw Error('practice-evidence-diagnostic');
    return { answerRevision: evidenceInteger(r.answerRevision), stepRevision: evidenceInteger(r.stepRevision, 1), stepId: attemptId(r.stepId), sourceVersion: digest(r.sourceVersion), status: r.status as 'correct', source: r.source as 'deterministic', explanation: text(r.explanation, PRACTICE_EVIDENCE_LIMITS.explanation) };
}
export function parsePracticeVariantRecovery(raw: unknown): PracticeVariantRecoveryV1 {
    const r = evidenceObject(raw, ['schemaVersion', 'mappingId', 'parentItemKey', 'parentContentHash', 'hashKind', 'templateVersion', 'templateId', 'seed', 'parameters', 'variantHash']);
    const { seed, variantHash, ...mapping } = r;
    const approved = parseMathVariantMapping({ ...mapping, sourceConditions: [] });
    return { schemaVersion: 1, mappingId: approved.mappingId, parentItemKey: approved.parentItemKey, parentContentHash: approved.parentContentHash, hashKind: approved.hashKind, templateVersion: 1, templateId: approved.templateId, parameters: approved.parameters, seed: evidenceInteger(seed, 0, 0xffffffff), variantHash: digest(variantHash) };
}
function variant(raw: unknown): PracticeVariantRecoveryV1 {
    const parsed = parsePracticeVariantRecovery(raw);
    return { schemaVersion: 1, mappingId: parsed.mappingId, parentItemKey: parsed.parentItemKey, parentContentHash: parsed.parentContentHash, hashKind: parsed.hashKind, templateVersion: 1, templateId: parsed.templateId, seed: parsed.seed, parameters: parsed.parameters, variantHash: parsed.variantHash };
}
function bounded(raw: unknown): void {
    validatePracticeEvidenceTree(raw);
    if (new TextEncoder().encode(JSON.stringify(raw)).length > PRACTICE_EVIDENCE_LIMITS.bytes)
        throw Error('practice-evidence-size');
}
export function parsePracticeEvidenceMutation(raw: unknown): PracticeEvidenceMutationV1 {
    bounded(raw);
    const base = ['schemaVersion', 'operationId', 'attemptId', 'binding', 'expectedRevision', 'updatedAt', 'kind'];
    const fields: Record<string, string> = { 'execution-pointer': 'prepared', 'code-report': 'report', 'code-hint': 'hint', 'step-input': 'text', 'step-diagnostic': 'diagnostic', variant: 'variant' };
    const kind = (raw as Record<string, unknown>)?.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(fields, kind))
        throw Error('practice-evidence-kind');
    const r = evidenceObject(raw, [...base, fields[kind]], kind === 'code-report' ? ['output'] : []);
    if (r.schemaVersion !== 1)
        throw Error('practice-evidence-unsupported-version');
    const b = { schemaVersion: 1 as const, operationId: attemptId(r.operationId), attemptId: attemptId(r.attemptId), binding: parseAttemptBinding(r.binding), expectedRevision: evidenceInteger(r.expectedRevision), updatedAt: date(r.updatedAt) };
    switch (kind) {
        case 'execution-pointer': return { ...b, kind, prepared: prepared(r.prepared) };
        case 'code-report': return { ...b, kind, report: parseCodeRunReport(r.report), ...(r.output === undefined ? {} : { output: text(r.output, PRACTICE_EVIDENCE_LIMITS.output) }) };
        case 'code-hint': return { ...b, kind, hint: parsePracticeEvidenceHint(r.hint) };
        case 'step-input': return { ...b, kind, text: text(r.text, PRACTICE_EVIDENCE_LIMITS.step) };
        case 'step-diagnostic': return { ...b, kind, diagnostic: parsePracticeEvidenceDiagnostic(r.diagnostic) };
        default: return { ...b, kind: 'variant', variant: variant(r.variant) };
    }
}
export function parsePracticeEvidence(raw: unknown): PracticeEvidenceV1 {
    bounded(raw);
    const r = evidenceObject(raw, ['schemaVersion', 'attemptId', 'binding', 'revision', 'updatedAt', 'operations'], ['execution', 'calculation', 'variant']);
    if (r.schemaVersion !== 1)
        throw Error('practice-evidence-unsupported-version');
    const revision = evidenceInteger(r.revision, 1);
    if (!Array.isArray(r.operations) || r.operations.length < 1 || r.operations.length > PRACTICE_EVIDENCE_LIMITS.operations)
        throw Error('practice-evidence-operations');
    const ids = new Set(), revisions = new Set();
    const operations = r.operations.map(raw => {
        const o = evidenceObject(raw, ['operationId', 'fingerprint', 'revision']);
        const op = { operationId: attemptId(o.operationId), fingerprint: digest(o.fingerprint), revision: evidenceInteger(o.revision, 1, revision) };
        if (ids.has(op.operationId) || revisions.has(op.revision))
            throw Error('practice-evidence-duplicate-receipt');
        ids.add(op.operationId);
        revisions.add(op.revision);
        return op;
    });
    if (operations.length !== revision || operations.some((o, i) => o.revision !== i + 1))
        throw Error('practice-evidence-receipt-order');
    const result: PracticeEvidenceV1 = { schemaVersion: 1, attemptId: attemptId(r.attemptId), binding: parseAttemptBinding(r.binding), revision, updatedAt: date(r.updatedAt), operations };
    if (r.execution !== undefined) {
        const e = evidenceObject(r.execution, [], ['first', 'latest', 'firstOutput', 'latestOutput', 'prepared', 'hint']);
        if (!Object.keys(e).length || (e.first === undefined) !== (e.latest === undefined)
            || e.firstOutput !== undefined && e.first === undefined || e.latestOutput !== undefined && e.latest === undefined)
            throw Error('practice-evidence-execution');
        result.execution = {
            ...(e.first === undefined ? {} : { first: parseCodeRunReport(e.first), latest: parseCodeRunReport(e.latest) }),
            ...(e.firstOutput === undefined ? {} : { firstOutput: text(e.firstOutput, PRACTICE_EVIDENCE_LIMITS.output) }),
            ...(e.latestOutput === undefined ? {} : { latestOutput: text(e.latestOutput, PRACTICE_EVIDENCE_LIMITS.output) }),
            ...(e.prepared === undefined ? {} : { prepared: prepared(e.prepared) }),
            ...(e.hint === undefined ? {} : { hint: parsePracticeEvidenceHint(e.hint) })
        };
    }
    if (r.calculation !== undefined) {
        const c = evidenceObject(r.calculation, ['stepInput'], ['diagnostic']), s = evidenceObject(c.stepInput, ['text', 'revision']);
        result.calculation = { stepInput: { text: text(s.text, PRACTICE_EVIDENCE_LIMITS.step), revision: evidenceInteger(s.revision, 1, revision) }, ...(c.diagnostic === undefined ? {} : { diagnostic: parsePracticeEvidenceDiagnostic(c.diagnostic) }) };
        if (result.calculation.diagnostic && result.calculation.diagnostic.stepRevision !== result.calculation.stepInput.revision)
            throw Error('practice-evidence-step-revision');
    }
    if (r.variant !== undefined)
        result.variant = variant(r.variant);
    if (!result.execution && !result.calculation && !result.variant)
        throw Error('practice-evidence-empty');
    return result;
}
