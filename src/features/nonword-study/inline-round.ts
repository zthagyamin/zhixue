import type { NonWordHostScope, NonWordRoundState, RoundSourceMember } from '../../application/nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { validNonWordRoundMembers } from '../../application/nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { completesSubjectItemAfterAttempt } from '../../domain/planning/index.ts';
type InlineItem = {
    itemId: string;
    questionType: string;
    contentHash?: string;
    word?: unknown;
    eventKind?: string;
    pluginType?: string;
};
export type InlineNonWordRoundBinding = {
    key: string;
    scope: NonWordHostScope;
    itemIds: string[];
};
/** Only a verified, wholly non-vocabulary source set can own this sequential cursor. */
export function bindInlineNonWordRound<T extends InlineItem>(items: T[], scopeFor: ((item: T) => NonWordHostScope | undefined) | undefined, temporary = false): InlineNonWordRoundBinding | null {
    if (temporary || !scopeFor || !items.length)
        return null;
    const scopes = items.map(item => completesSubjectItemAfterAttempt(item) ? scopeFor(item) : undefined);
    const first = scopes[0];
    if (!first || first.temporary || scopes.some(scope => !scope || scope.temporary))
        return null;
    // Compatibility with the dashboard's existing explicit [day,"inline",task] identity.
    let day = first.day;
    if (!day) {
        try {
            const identity: unknown = JSON.parse(first.roundId);
            if (Array.isArray(identity) && identity[1] === 'inline' && typeof identity[0] === 'string')
                day = identity[0];
        }
        catch { /* Old unbound callers retain their existing behavior. */ }
    }
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day))
        return null;
    const common = (scope: NonWordHostScope) => JSON.stringify([scope.workspaceId, scope.ownerId, scope.libraryId, scope.groupId, scope.roundId, scope.cloud]);
    if (scopes.some(scope => common(scope!) !== common(first) || scope!.day && scope!.day !== day))
        return null;
    const members: RoundSourceMember[] = scopes.map((scope, index) => ({ itemKey: scope!.itemKey, snapshotId: scope!.snapshotId, contentHash: scope!.contentHash, kind: 'practice', mode: items[index].questionType }));
    if (items.some((item, index) => item.contentHash !== members[index].contentHash))
        return null;
    try {
        validNonWordRoundMembers(members);
    }
    catch {
        return null;
    }
    const scope = { ...first, day, members }, itemIds = items.map(item => item.itemId);
    if (new Set(itemIds).size !== itemIds.length)
        return null;
    return { scope, itemIds, key: JSON.stringify([common(first), day, members, itemIds]) };
}
/** Project only the cursor belonging to this immutable source set; pending has no grade. */
export function projectInlineNonWordRound(binding: InlineNonWordRoundBinding, state: NonWordRoundState) {
    if (JSON.stringify(state.members) !== JSON.stringify(binding.scope.members))
        throw Error('题组来源版本不一致，原作答已保留。');
    const index = state.currentItemKey === null ? null : state.members.findIndex(member => member.itemKey === state.currentItemKey);
    if (index === -1)
        throw Error('题组当前位置无法核对，原作答已保留。');
    const correct = state.traversal.correctKeys.length, wrong = state.traversal.wrongKeys.length;
    return { index, summary: { answered: correct + wrong, correct, wrong }, awaiting: state.traversal.awaitingReviewKeys.length, skipped: state.traversal.skippedKeys.length };
}
