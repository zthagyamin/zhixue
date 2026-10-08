import type { NonWordRoundState, RoundCursorInput } from './round-session';
export interface NonWordRoundPort {
    selectItem?: (itemKey: string, expectedRunId: string) => Promise<NonWordRoundState>;
    reopenPendingWithAck?:()=>Promise<NonWordRoundState>;
    read: () => Promise<NonWordRoundState>;
    saveCursor: (cursor: RoundCursorInput, expectedRunId?: string,expectedBoundary?:string) => Promise<NonWordRoundState>;
    synchronize: () => Promise<void>;
    status: () => Promise<string>;
}
/** Record visible continuation only after the individual answer's durable receipt. */
export async function continueNonWordRound(port: NonWordRoundPort, itemKey: string, result: 'pending' | 'skipped' | 'again' | 'hard' | 'good' | 'easy', expectedRunId?: string,expectedBoundary?:string) {
    const state = await port.read();
    if (!state.members.some(member => member.itemKey === itemKey))
        throw Error('nonword-round-unknown-item');
    if (expectedRunId !== undefined && state.runId !== expectedRunId)
        throw Error('nonword-round-run-conflict');
    const traversal = { correctKeys: state.traversal.correctKeys.filter(key => key !== itemKey), wrongKeys: state.traversal.wrongKeys.filter(key => key !== itemKey), awaitingReviewKeys: state.traversal.awaitingReviewKeys.filter(key => key !== itemKey), skippedKeys: state.traversal.skippedKeys.filter(key => key !== itemKey) };
    if (result === 'pending')
        traversal.awaitingReviewKeys.push(itemKey);
    else if (result === 'skipped')
        traversal.skippedKeys.push(itemKey);
    else if (result === 'good' || result === 'easy')
        traversal.correctKeys.push(itemKey);
    else
        traversal.wrongKeys.push(itemKey);
    const settled = new Set(Object.values(traversal).flat()), currentItemKey = state.members.find(member => !settled.has(member.itemKey))?.itemKey ?? null;
    return port.saveCursor({ currentItemKey, traversal }, state.runId,expectedBoundary);
}
export async function reopenNonWordPendingRound(port: NonWordRoundPort) {
    if(port.reopenPendingWithAck)return port.reopenPendingWithAck();
    const state = await port.read(), currentItemKey = state.members.find(member => state.traversal.awaitingReviewKeys.includes(member.itemKey))?.itemKey;
    if (!currentItemKey)
        return state;
    return port.saveCursor({ currentItemKey, traversal: { ...state.traversal, awaitingReviewKeys: [] } }, state.runId);
}
