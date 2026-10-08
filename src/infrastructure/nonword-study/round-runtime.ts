import type { NonWordRoundScope, RoundSourceMember, RoundCursorInput } from '../../application/nonword-study';
import type { AttemptCloudPort } from '../../application/learning-attempt';
// @ts-expect-error TS5097: standalone Node contracts.
import { createNonWordRoundSession, validNonWordRoundMembers } from '../../application/nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createLocalAttemptRepository, createAccountAttemptClient, attemptFingerprint } from '../learning-attempt/index.ts';
type Options = {
    attemptGroupId?:string;
    scope: NonWordRoundScope;
    members: readonly RoundSourceMember[];
    initialCursor?: RoundCursorInput;
    fetcher?: typeof fetch;
    cloud?: AttemptCloudPort | null;
    repository?: ReturnType<typeof createLocalAttemptRepository>;
    now?: () => string;
    newId?: () => string;
};
/** Storage composition only; cursor receipts never write events or scheduling state. */
export async function createNonWordRoundRuntime(options: Options) {
    if (!Array.isArray(options.members))
        throw Error('nonword-round-member-limit');
    if (!options.members.length)
        return null;
    if (options.members.some(member => member.kind === 'word' || !['quiz', 'recall', 'code', 'calculation', 'flashcard'].includes(member.mode)))
        return null;
    const members = validNonWordRoundMembers(options.members), scope = structuredClone(options.scope);
    const repository = options.repository ?? createLocalAttemptRepository({ userId: scope.ownerId, libraryId: scope.libraryId });
    const cloud = options.cloud === undefined ? scope.cloud ? createAccountAttemptClient({ ownerId: scope.ownerId, libraryId: scope.libraryId, fetcher: options.fetcher }) : null : options.cloud;
    const session = createNonWordRoundSession({ scope, members, attemptGroupId:options.attemptGroupId, initialCursor: options.initialCursor, repository, fingerprint: attemptFingerprint, now: options.now ?? (() => new Date().toISOString()), newId: options.newId ?? (() => crypto.randomUUID()) });
    const anchorId = await session.anchorAttemptId();
    let notice = '', syncing: Promise<void> | null = null;
    const hydrateContinuations=async()=>{
        if(!cloud||!options.attemptGroupId)return;
        try{await session.hydrateContinuations(cloud,value=>repository.hydrate(value));}
        catch(error){
            if(error instanceof Error&&/nonword-continuation-|binding|conflict/.test(error.message))throw error;
            notice='device-only';
        }
    };
    const synchronize = async () => {
        if (!cloud)
            return;
        const result = await repository.sync(cloud);
        if (await repository.status(anchorId) === 'cloud-conflict')
            throw Error('nonword-round-conflict');
        notice = result.unsupported ? 'unsupported' : result.pending ? 'device-only' : '';
    };
    const refresh = async () => {
        if (!cloud)
            return session.read();
        await synchronize();
        let remote;
        try {
            remote = await cloud.read(anchorId);
        }
        catch {
            notice = 'device-only';
        }
        if (remote) {
            await session.validateSnapshot(remote);
            await repository.hydrate(remote);
        }
        await hydrateContinuations();
        return session.read();
    };
    if (cloud) {
        let remote;
        try {
            remote = await cloud.read(anchorId);
        }
        catch {
            notice = 'device-only';
        }
        if (remote) {
            await session.validateSnapshot(remote);
            await repository.hydrate(remote);
        }
    }
    await session.open(Boolean(cloud&&options.attemptGroupId));
    await hydrateContinuations();
    const schedule = () => syncing ??= synchronize().finally(() => { syncing = null; });
    const afterWrite = () => { void schedule().catch(() => { notice = 'device-only'; }); };
    const persisted = async (result: ReturnType<typeof session.saveCursor>) => { const saved = await result; afterWrite(); return saved; };
    afterWrite();
    return { session, repository, anchorAttemptId: anchorId,
        open: () => session.read(), read: () => session.read(), refresh,
        saveCursor: (cursor: RoundCursorInput, expectedRunId?: string, expectedBoundary?:string) => persisted(session.saveCursor(cursor, expectedRunId,expectedBoundary)),
        selectItem: (itemKey: string, expectedRunId: string) => persisted(session.selectItem(itemKey, expectedRunId)),
        ...(session.reopenPendingWithAck?{reopenPendingWithAck:()=>persisted(session.reopenPendingWithAck!())}:{}),
        startNewRound: (input: {
            restartConfirmed: boolean;
        }) => persisted(session.startNewRound(input)),
        synchronize: schedule,
        async status() { const saved = await repository.status(anchorId); return saved === 'cloud-conflict' || saved === 'cloud-acked' ? saved : notice || saved || 'device-only'; },
    };
}
