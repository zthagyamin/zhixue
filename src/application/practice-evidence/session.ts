// @ts-expect-error TS5097: standalone Node contracts.
import { parsePracticeEvidence, parsePracticeEvidenceMutation, evidenceEqual, validatePracticeEvidenceAuthority } from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../../domain/learning-attempt/index.ts';
import type { PracticeEvidenceAuthority, PracticeEvidenceMutationV1, PracticeEvidenceV1 } from '../../domain/practice-evidence';
import type { PracticeEvidenceAttemptPort, PracticeEvidenceScope, PracticeEvidenceServiceWritePort, PracticeEvidenceStorePort } from './ports';
export async function resolvePracticeEvidenceAuthority(scope: PracticeEvidenceScope, attempts: PracticeEvidenceAttemptPort, recordOrMutation: PracticeEvidenceV1 | PracticeEvidenceMutationV1, service?: PracticeEvidenceServiceWritePort, current?: PracticeEvidenceV1 | null): Promise<PracticeEvidenceAuthority> {
    const a = await attempts.readAttempt(recordOrMutation.attemptId), b = recordOrMutation.binding;
    if (!a || a.attemptId !== recordOrMutation.attemptId || b.ownerId !== scope.ownerId || b.libraryId !== scope.libraryId || !evidenceEqual(a.binding, b))
        throw Error('practice-evidence-scope-binding');
    const needsSource = 'kind' in recordOrMutation ? ['step-input', 'step-diagnostic', 'variant'].includes(recordOrMutation.kind) : Boolean(recordOrMutation.calculation || recordOrMutation.variant);
    const authority: PracticeEvidenceAuthority = { attempt: a };
    const hasVariant = 'kind' in recordOrMutation
        ? recordOrMutation.kind === 'variant' || Boolean(current?.variant)
        : Boolean(recordOrMutation.variant);
    if (hasVariant && a.parentAttemptId)
        authority.parentAttempt = (await attempts.readAttempt(a.parentAttemptId)) ?? undefined;
    if (current && (current.attemptId !== recordOrMutation.attemptId || !evidenceEqual(current.binding,b)))
        throw Error('practice-evidence-current-binding');
    if (current?.execution?.prepared)
        authority.currentPreparedChild = (await attempts.readAttempt(current.execution.prepared.attemptId)) ?? undefined;
    if (needsSource) {
        const source = await attempts.resolveSource?.(a);
        if (!source)
            throw Error('practice-evidence-source-unavailable');
        authority.source = source;
    }
    const prepared = 'kind' in recordOrMutation
        ? recordOrMutation.kind === 'execution-pointer' ? recordOrMutation.prepared : current?.execution?.prepared
        : recordOrMutation.execution?.prepared;
    if (prepared)
        authority.preparedChild = prepared.attemptId === current?.execution?.prepared?.attemptId
            ? authority.currentPreparedChild
            : (await attempts.readAttempt(prepared.attemptId)) ?? undefined;
    if ('kind' in recordOrMutation && recordOrMutation.kind === 'step-diagnostic' && recordOrMutation.diagnostic.source === 'model') {
        const approved = authority.source && await service?.resolveModelDiagnostic?.({ attempt: a, source: authority.source, diagnostic: recordOrMutation.diagnostic });
        if (!approved || !evidenceEqual(approved, recordOrMutation.diagnostic))
            throw Error('practice-evidence-model-write-port-required');
        authority.modelDiagnostic = approved;
    }
    if ('kind' in recordOrMutation && recordOrMutation.kind === 'code-hint' && recordOrMutation.hint.source === 'model') {
        const approved = await service?.resolveModelHint?.({ attempt: a, hint: recordOrMutation.hint });
        if (!approved || !evidenceEqual(approved, recordOrMutation.hint))
            throw Error('practice-evidence-model-write-port-required');
        authority.modelHint = approved;
    }
    return authority;
}
type Options = {
    scope: PracticeEvidenceScope;
    attempts: PracticeEvidenceAttemptPort;
    store: PracticeEvidenceStorePort;
    service?: PracticeEvidenceServiceWritePort;
};
function createSession(options: Options, trusted: boolean) {
    const { scope, attempts, store } = options;
    attemptId(scope.ownerId);
    attemptId(scope.libraryId);
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => { const task = tail.then(work); tail = task.catch(() => undefined); return task; };
    const read = async (id: string) => {
        attemptId(id);
        const a = await attempts.readAttempt(id);
        if (!a || a.binding.ownerId !== scope.ownerId || a.binding.libraryId !== scope.libraryId)
            throw Error('practice-evidence-scope-binding');
        const raw = await store.read(id), record = raw === null ? null : parsePracticeEvidence(raw);
        if (record)
            await validatePracticeEvidenceAuthority(record, await resolvePracticeEvidenceAuthority(scope, attempts, record));
        return record;
    };
    return {
        open: (id: string) => serial(() => read(id)),
        read: (id: string) => serial(() => read(id)),
        mutate: (raw: PracticeEvidenceMutationV1) => serial(async () => {
            const m = parsePracticeEvidenceMutation(raw);
            if (!trusted && (m.kind === 'step-diagnostic' && m.diagnostic.source === 'model' || m.kind === 'code-hint' && m.hint.source === 'model'))
                throw Error('practice-evidence-trusted-service-required');
            // Re-resolve original scope/source at the real repository write boundary too.
            const current = await store.read(m.attemptId);
            await resolvePracticeEvidenceAuthority(scope, attempts, m, trusted ? options.service : undefined, current);
            return store.mutate(m);
        })
    };
}
export const createPracticeEvidenceSession = (options: Options) => createSession(options, false);
/** The repository must also be composed with its service resolver; this is not a bypass. */
export const createTrustedPracticeEvidenceWriter = (options: Options) => createSession(options, true);
