import { useRef } from 'react';
import type { NonWordHostScope, RoundCursorInput } from '../../src/application/nonword-study';
import { reopenNonWordPendingRound } from '../../src/application/nonword-study';
import { createNonWordRoundRuntime } from '../../src/infrastructure/nonword-study';
export type BoundNonWordRound = NonNullable<Awaited<ReturnType<typeof createNonWordRoundRuntime>>>;
/** The cache belongs to this mounted owner/page, never to a global service locator. */
export function useNonWordRoundCache() {
    const instances = useRef(new Map<string, Promise<BoundNonWordRound | null>>());
    return async (scope: NonWordHostScope, initialCursor?: RoundCursorInput) => {
        if (!scope.day || !scope.members?.length || scope.temporary)
            return null;
        const key = JSON.stringify([scope.ownerId, scope.libraryId, scope.day, scope.groupId, scope.roundId, scope.members]);
        let existing = instances.current.get(key);
        if (!existing) {
            existing = createNonWordRoundRuntime({ scope: { ownerId: scope.ownerId, libraryId: scope.libraryId, groupId: JSON.stringify([scope.groupId, scope.roundId]), day: scope.day, cloud: scope.cloud }, attemptGroupId:scope.groupId, members: scope.members, initialCursor });
            instances.current.set(key, existing);
            void existing.catch(() => { instances.current.delete(key); });
        }
        return existing;
    };
}
export function cursorSeed(scope: NonWordHostScope, round: {
    correctKeys: string[];
    wrongKeys: string[];
    awaitingReviewKeys?: string[];
    skippedKeys?: string[];
}, currentItemKey: string): RoundCursorInput {
    const managed = new Set(scope.members?.map(member => member.itemKey)), correctKeys = round.correctKeys.filter(key => managed.has(key));
    const wrongKeys = round.wrongKeys.filter(key => managed.has(key) && !correctKeys.includes(key));
    const awaitingReviewKeys = (round.awaitingReviewKeys ?? []).filter(key => managed.has(key) && !correctKeys.includes(key) && !wrongKeys.includes(key));
    return { currentItemKey, traversal: { correctKeys, wrongKeys, awaitingReviewKeys, skippedKeys: (round.skippedKeys ?? []).filter(key => managed.has(key) && !correctKeys.includes(key) && !wrongKeys.includes(key) && !awaitingReviewKeys.includes(key)) } };
}
export async function restoreSavedPending(get: ReturnType<typeof useNonWordRoundCache>, scope: NonWordHostScope | undefined, restore: () => void) {
    const group = scope ? await get(scope) : null;
    if (group)
        await reopenNonWordPendingRound(group);
    restore();
}
export async function restartSavedRound(get: ReturnType<typeof useNonWordRoundCache>, scope: NonWordHostScope | undefined, restart: () => Promise<void>, remount: () => void) {
    const group = scope ? await get(scope) : null;
    await restart();
    if (group)
        await group.startNewRound({ restartConfirmed: true });
    remount();
}
