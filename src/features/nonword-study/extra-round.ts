import type { NonWordHostScope, NonWordRoundState, RoundSourceMember } from '../../application/nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { validNonWordRoundMembers } from '../../application/nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { isNonWordOriginal } from '../../domain/content/index.ts';
type Entry = {
    data: unknown;
    sourceMode: string;
    mode: string;
    scope?: NonWordHostScope;
};
export type ExtraNonWordRoundBinding = {
    key: string;
    scope: NonWordHostScope;
};
/** A separate auxiliary cursor; the individual attempts remain temporary. */
export function bindExtraNonWordRound(scopeKey: string, entries: readonly Entry[], recoveryDay?: string): ExtraNonWordRoundBinding | null {
    const first = entries[0]?.scope, day = recoveryDay ?? first?.day;
    if (!scopeKey || !first || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day))
        return null;
    const identity = (scope: NonWordHostScope) => JSON.stringify([scope.workspaceId, scope.ownerId, scope.libraryId, scope.groupId, scope.roundId, scope.cloud]);
    if (entries.some(entry => !entry.scope || !isNonWordOriginal(entry.sourceMode, entry.data) || identity(entry.scope) !== identity(first) || entry.scope.day && entry.scope.day !== day))
        return null;
    const members: RoundSourceMember[] = entries.map(entry => ({ itemKey: entry.scope!.itemKey, snapshotId: entry.scope!.snapshotId, contentHash: entry.scope!.contentHash, kind: 'practice', mode: entry.mode }));
    if (entries.some((entry, index) => !entry.data || typeof entry.data !== 'object' || (entry.data as {
        contentHash?: unknown;
    }).contentHash !== members[index].contentHash))
        return null;
    try {
        validNonWordRoundMembers(members);
    }
    catch {
        return null;
    }
    const scope = { ...first, temporary: false, day, members, groupId: JSON.stringify([first.groupId, 'extra-practice-cursor', scopeKey]), roundId: JSON.stringify([first.roundId, 'extra-practice-cursor', scopeKey]) };
    return { scope, key: JSON.stringify([identity(scope), day, members]) };
}
/** Only exact source members may project auxiliary feedback into this page. */
export function projectExtraNonWordRound(binding: ExtraNonWordRoundBinding, cursor: NonWordRoundState) {
    if (JSON.stringify(binding.scope.members) !== JSON.stringify(cursor.members))
        throw Error('巩固来源版本不一致，原答案已保留。');
    const position = (key: string) => {
        const index = cursor.members.findIndex(member => member.itemKey === key);
        if (index < 0)
            throw Error('巩固题目无法核对，原答案已保留。');
        return index;
    };
    const correct = cursor.traversal.correctKeys.map(position), reviewed = cursor.traversal.wrongKeys.map(position), awaiting = cursor.traversal.awaitingReviewKeys.map(position), skipped = cursor.traversal.skippedKeys.map(position);
    const settled = [...correct, ...reviewed, ...awaiting, ...skipped];
    if (new Set(settled).size !== settled.length || cursor.currentItemKey === null && settled.length !== cursor.members.length)
        throw Error('巩固进度无法核对，原答案已保留。');
    return { stages: cursor.members.map((_, index) => correct.includes(index) ? 3 : 0), reviewed, skipped: [...skipped, ...awaiting], awaiting, index: cursor.currentItemKey === null ? 0 : position(cursor.currentItemKey), complete: cursor.currentItemKey === null };
}
