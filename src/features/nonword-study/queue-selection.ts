import type { NonWordRoundPort } from '../../application/nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { isNonWordOriginal } from '../../domain/content/index.ts';

/** Explicit selection changes position after a receipt; it never grades or traverses an item. */
export async function selectNonWordQueueItem(itemKey: string, ports: {
    current: () => boolean;
    round: () => Promise<NonWordRoundPort | null>;
    select: () => void;
}) {
    if (!ports.current())
        return false;
    const round = await ports.round();
    if (!ports.current())
        return false;
    if (round) {
        const current = await round.read();
        if (!ports.current())
            return false;
        if (!round.selectItem)
            throw Error('当前续学服务不能可靠保存选题位置。');
        await round.selectItem(itemKey, current.runId);
    }
    if (!ports.current())
        return false;
    ports.select();
    return true;
}

/** Capture the latest learner navigation intent without changing vocabulary selection. */
export function createNonWordQuestionSelection(options: {
    enabled: boolean;
    original: { mode: string; data: unknown };
    itemKeys: readonly string[];
    current: () => boolean;
    begin: () => number;
    latest: (request: number) => boolean;
    round: () => Promise<NonWordRoundPort | null>;
    select: (index: number) => void;
    failure: (message: string) => void;
}) {
    return (index: number) => {
        if (!options.enabled || !isNonWordOriginal(options.original.mode, options.original.data)) {
            options.select(index);
            return;
        }
        const request = options.begin();
        const current = () => options.latest(request) && options.current();
        void selectNonWordQueueItem(options.itemKeys[index], { current, round: options.round, select: () => options.select(index) })
            .catch(reason => { if (current()) options.failure(reason instanceof Error ? reason.message : '选题位置尚未保存，请再试一次。'); });
    };
}
