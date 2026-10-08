import type { AttemptMutation, AttemptReceipt, LearningAttempt } from '../../domain/learning-attempt';
import type { StudyItemVersion, StudySnapshot } from '../../domain/sync';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyId, studyDigest } from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../../domain/learning-attempt/index.ts';
export type AccountAttemptReferenceBundle = {
    item: StudyItemVersion;
    snapshot?: StudySnapshot;
    capability: 'complete' | 'item-only';
};
export function createAccountAttemptClient(options: {
    ownerId: string;
    libraryId: string;
    fetcher?: typeof fetch;
}) {
    attemptId(options.ownerId);
    attemptId(options.libraryId);
    const send = async (action: string, body: Record<string, unknown>) => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await (options.fetcher ?? fetch)('/api/account-study', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body, libraryId: options.libraryId, expectedUserId: options.ownerId }) });
            const result = await response.json() as Record<string, unknown>;
            if (!response.ok) {
                const code = result.error === 'unsupported-action' ? 'learning-attempts-unsupported' : String(result.error ?? 'attempt-request-failed');
                throw Object.assign(new Error(code), { status: response.status });
            }
            return result;
        }
        finally {
            clearTimeout(timer);
        }
    };
    return {
        read: async (id: string) => (await send('attempt-read', { attemptId: attemptId(id) })).attempt as LearningAttempt | null,
        list: async (groupId?: string) => (await send('attempt-list', groupId ? { groupId: attemptId(groupId) } : {})).attempts as LearningAttempt[],
        mutate: async (mutation: AttemptMutation) => await send('attempt-mutate', { mutation }) as unknown as AttemptReceipt,
        reference: async (id: string) => (await send('attempt-reference', { attemptId: attemptId(id) })).item as StudyItemVersion,
        async referenceBundle(id: string): Promise<AccountAttemptReferenceBundle> {
            const response = await send('attempt-reference', { attemptId: attemptId(id) }), item = response.item as StudyItemVersion;
            studyId(item?.itemKey, 'item');
            studyDigest(item?.contentHash);
            if (response.snapshot === undefined || response.snapshot === null)
                return { item, capability: 'item-only' };
            const snapshot = response.snapshot as StudySnapshot;
            studyId(snapshot.snapshotId, 'snapshot');
            studyId(snapshot.libraryId, 'library');
            studyDigest(snapshot.snapshotHash);
            if (snapshot.schemaVersion !== 1 || snapshot.libraryId !== options.libraryId || !Array.isArray(snapshot.items))
                throw Error('attempt-reference-scope');
            const keys = new Set<string>();
            for (const member of snapshot.items) {
                studyId(member?.itemKey, 'item');
                studyDigest(member?.contentHash);
                if (keys.has(member.itemKey))
                    throw Error('attempt-reference-membership');
                keys.add(member.itemKey);
            }
            if (!snapshot.items.some(member => member.itemKey === item.itemKey && member.contentHash === item.contentHash))
                throw Error('attempt-reference-membership');
            return { item, snapshot, capability: 'complete' };
        },
    };
}
