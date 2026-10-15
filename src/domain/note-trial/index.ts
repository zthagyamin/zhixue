/** Session-only source slots; original material IDs and content remain untouched. */
export function markTrialSlotForRetry(marked: readonly number[], slot: number, needsRetry: boolean): number[] {
    return needsRetry ? Array.from(new Set([...marked, slot])) : marked.filter(value => value !== slot);
}

export function trialRetrySlots(questionCount: number, marked: readonly number[]): number[] {
    const selected = new Set(marked);
    return Array.from({ length: questionCount }, (_, slot) => slot).filter(slot => selected.has(slot));
}
