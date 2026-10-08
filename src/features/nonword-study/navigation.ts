import type { NonWordRoundState } from '../../application/nonword-study';
import type { FSRSRating } from '../../domain/assessment';
import type { SubjectRound } from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node contracts.
import { awaitSubjectReview, advanceSubjectRound, reopenAwaitingSubjectRound } from '../../domain/planning/index.ts';
/** Visible traversal only. The event writer and scheduling authority are separate. */
type NavigationPorts = {
    canContinue: () => boolean;
    canRestore?: () => boolean;
    round: () => SubjectRound;
    clear: () => void;
    publish: (update: (current: SubjectRound) => SubjectRound) => void;
    select: (index: number) => void;
    bump: () => void;
};
export function bindNonWordNavigation(input: { itemKeys: readonly string[]; index: number }, ports: NavigationPorts, recovered: () => void) {
    const resume = createNonWordContinuation(input, ports);
    return {
        continuePending: () => resume(),
        resumeFormal: (rating: FSRSRating) => { if (ports.canContinue()) recovered(); resume(rating); },
        restoreRound: (state: NonWordRoundState) => restoreNonWordRound(state, input.itemKeys, input.index, ports),
    };
}
export function createNonWordContinuation(input: {
    itemKeys: readonly string[];
    index: number;
}, ports: NavigationPorts) {
    return (rating?: FSRSRating) => {
        if (!ports.canContinue())
            return;
        const advance = (round: SubjectRound) => rating === undefined ? awaitSubjectReview(round, input.itemKeys, input.index) : advanceSubjectRound({ round, itemKeys: input.itemKeys, currentIndex: input.index, correct: rating === 'good' || rating === 'easy', completeAfterAttempt: true });
        const next = advance(ports.round());
        ports.clear();
        ports.publish(current => advance(current).round);
        ports.select(next.nextIndex);
        if (next.nextIndex === input.index)
            ports.bump();
    };
}
export function restorePendingAnswers(itemKeys: readonly string[], ports: NavigationPorts) {
    if (!ports.canRestore?.())
        return;
    const next = reopenAwaitingSubjectRound(ports.round(), itemKeys);
    ports.clear();
    ports.publish(current => reopenAwaitingSubjectRound(current, itemKeys).round);
    ports.select(next.nextIndex);
    ports.bump();
}
export function restoreNonWordRound(state: NonWordRoundState, itemKeys: readonly string[], index: number, ports: NavigationPorts) {
    if (!ports.canRestore?.())
        return false;
    const managed = new Set(state.members.map(member => member.itemKey));
    if ([...managed].some(key => !itemKeys.includes(key)))
        throw Error('续学材料与当前分组不一致。');
    const current = ports.round(), keep = (keys: readonly string[] | undefined) => (keys ?? []).filter(key => !managed.has(key));
    const round: SubjectRound = { ...current, correctKeys: [...keep(current.correctKeys), ...state.traversal.correctKeys], wrongKeys: [...keep(current.wrongKeys), ...state.traversal.wrongKeys], reviewedKeys: [...keep(current.reviewedKeys), ...state.traversal.wrongKeys], awaitingReviewKeys: [...keep(current.awaitingReviewKeys), ...state.traversal.awaitingReviewKeys], skippedKeys: [...keep(current.skippedKeys), ...state.traversal.skippedKeys] };
    const next = state.currentItemKey === null ? index : itemKeys.indexOf(state.currentItemKey);
    const same = (keys: string[] | undefined, other: string[] | undefined) => JSON.stringify([...new Set(keys ?? [])].sort()) === JSON.stringify([...new Set(other ?? [])].sort());
    if (next === index && ['correctKeys', 'wrongKeys', 'reviewedKeys', 'awaitingReviewKeys', 'skippedKeys'].every(key => same(current[key as 'correctKeys'], round[key as 'correctKeys'])))
        return false;
    ports.publish(() => round);
    ports.select(Math.max(0, next));
    ports.bump();
    return true;
}
