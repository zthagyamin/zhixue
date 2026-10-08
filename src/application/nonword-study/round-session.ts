import type { AttemptBinding, AttemptMutation, LearningAttempt } from '../../domain/learning-attempt';
import type { AttemptRepository } from './session';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId, canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone contracts.
import {createContinuationCoordinator} from './continuation.ts';
export type RoundSourceMember = {
    itemKey: string;
    snapshotId: string;
    contentHash: string;
    kind: 'practice' | 'word';
    mode: string;
};
export type NonWordRoundScope = {
    ownerId: string;
    libraryId: string;
    groupId: string;
    day: string;
    cloud: boolean;
};
export type RoundTraversal = {
    correctKeys: string[];
    wrongKeys: string[];
    awaitingReviewKeys: string[];
    skippedKeys: string[];
};
export type RoundCursorInput = {
    currentItemKey: string | null;
    traversal: RoundTraversal;
};
export type NonWordRoundState = RoundCursorInput & {
    schemaVersion: 1;
    anchorAttemptId: string;
    sourceHash: string;
    runId: string;
    roundId: string;
    members: RoundSourceMember[];
};
type StoredCursor = {
    schemaVersion: 1;
    sourceHash: string;
    runId: string;
    currentIndex: number | null;
    correct: number[];
    wrong: number[];
    awaiting: number[];
    skipped: number[];
};
type Options = {
    attemptGroupId?: string;
    scope: NonWordRoundScope;
    members: readonly RoundSourceMember[];
    initialCursor?: RoundCursorInput;
    repository: AttemptRepository & {
        status?: (id: string) => Promise<string | null>;
    };
    now: () => string;
    newId: () => string;
    fingerprint: (value: unknown) => Promise<string>;
};
const MODES = ['quiz', 'recall', 'code', 'calculation', 'flashcard'];
const emptyTraversal = (): RoundTraversal => ({ correctKeys: [], wrongKeys: [], awaitingReviewKeys: [], skippedKeys: [] });
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('nonword-round-invalid');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
        throw Error('nonword-round-fields');
    return row;
}
export function validNonWordRoundMembers(raw: readonly RoundSourceMember[]): RoundSourceMember[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500)
        throw Error('nonword-round-member-limit');
    const members = raw.map(value => {
        const row = object(value, ['itemKey', 'snapshotId', 'contentHash', 'kind', 'mode']);
        if (row.kind !== 'practice' || !MODES.includes(String(row.mode)))
            throw Error('nonword-round-unsupported-source');
        if (typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash))
            throw Error('nonword-round-source-hash');
        return { itemKey: attemptId(row.itemKey), snapshotId: attemptId(row.snapshotId), contentHash: row.contentHash, kind: 'practice' as const, mode: row.mode as string };
    });
    if (new Set(members.map(member => member.itemKey)).size !== members.length)
        throw Error('nonword-round-duplicate-member');
    return members;
}
/** Durable cursor projection only. It cannot write formal events or scheduling state. */
export function createNonWordRoundSession(options: Options) {
    const continuations=createContinuationCoordinator(options);
    const scope = structuredClone(options.scope), members = validNonWordRoundMembers(structuredClone(options.members));
    const initialCursor = options.initialCursor === undefined ? undefined : structuredClone(options.initialCursor);
    object(scope, ['ownerId', 'libraryId', 'groupId', 'day', 'cloud']);
    attemptId(scope.ownerId);
    attemptId(scope.libraryId);
    if (typeof scope.groupId !== 'string' || !scope.groupId.trim() || scope.groupId.length > 65536 || typeof scope.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scope.day) || typeof scope.cloud !== 'boolean')
        throw Error('nonword-round-scope');
    let row: LearningAttempt | null = null, binding: AttemptBinding, anchorId: string, sourceHash: string, initialRunId: string;
    let identity: Promise<void> | null = null, queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => { const result = queue.then(work); queue = result.catch(() => { }); return result; };
    const identify = () => identity ??= (async () => {
        sourceHash = await options.fingerprint(members);
        const base = [scope.ownerId, scope.libraryId, scope.groupId, scope.day, sourceHash];
        anchorId = `nw-round:${await options.fingerprint(base)}`;
        initialRunId = await options.fingerprint([...base, 'initial-run']);
        binding = { ownerId: scope.ownerId, libraryId: scope.libraryId, snapshotId: members[0].snapshotId, itemKey: members[0].itemKey, contentHash: members[0].contentHash,
            groupId: await options.fingerprint(['round-cursor', ...base]), roundId: await options.fingerprint(['round-anchor', ...base]) };
    })();
    function encode(input: RoundCursorInput, runId: string): StoredCursor {
        object(input, ['currentItemKey', 'traversal']);
        object(input.traversal, ['correctKeys', 'wrongKeys', 'awaitingReviewKeys', 'skippedKeys']);
        const index = (key: string) => {
            const position = members.findIndex(member => member.itemKey === key);
            if (position < 0)
                throw Error('nonword-round-unknown-item');
            return position;
        };
        const seen = new Set<number>();
        const positions = (keys: string[]) => {
            if (!Array.isArray(keys) || keys.length > members.length)
                throw Error('nonword-round-traversal-limit');
            return keys.map(key => {
                const position = index(attemptId(key));
                if (seen.has(position))
                    throw Error('nonword-round-overlapping-status');
                seen.add(position);
                return position;
            });
        };
        return { schemaVersion: 1, sourceHash, runId: attemptId(runId), currentIndex: input.currentItemKey === null ? null : index(attemptId(input.currentItemKey)),
            correct: positions(input.traversal.correctKeys), wrong: positions(input.traversal.wrongKeys), awaiting: positions(input.traversal.awaitingReviewKeys), skipped: positions(input.traversal.skippedKeys) };
    }
    function decode(saved: LearningAttempt): StoredCursor {
        if (saved.schemaVersion !== 1 || saved.attemptId !== anchorId || canonicalAttemptJson(saved.binding) !== canonicalAttemptJson(binding) || saved.answer !== '' || saved.submitted || saved.formal || saved.evaluation.status !== 'pending' || saved.evaluation.reason !== 'not-requested' || saved.checkpoint.mode !== 'lesson' || saved.checkpoint.purpose !== 'guided' || saved.parentAttemptId)
            throw Error('nonword-round-anchor-binding');
        const text = saved.checkpoint.pluginFields?.notes;
        if (typeof text !== 'string' || text.length > 32000)
            throw Error('nonword-round-cursor-size');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw Error('nonword-round-cursor-json');
        }
        const cursor = object(parsed, ['schemaVersion', 'sourceHash', 'runId', 'currentIndex', 'correct', 'wrong', 'awaiting', 'skipped']);
        if (cursor.schemaVersion !== 1 || cursor.sourceHash !== sourceHash)
            throw Error('nonword-round-cursor-version');
        attemptId(cursor.runId);
        const index = (value: unknown): number => {
            if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= members.length)
                throw Error('nonword-round-cursor-index');
            return value as number;
        };
        const traversal = Object.fromEntries(['correct', 'wrong', 'awaiting', 'skipped'].map(key => {
            if (!Array.isArray(cursor[key]))
                throw Error('nonword-round-cursor-status');
            return [key, cursor[key].map(value => members[index(value)].itemKey)];
        })) as Record<string, string[]>;
        return encode({ currentItemKey: cursor.currentIndex === null ? null : members[index(cursor.currentIndex)].itemKey,
            traversal: { correctKeys: traversal.correct, wrongKeys: traversal.wrong, awaitingReviewKeys: traversal.awaiting, skippedKeys: traversal.skipped } }, cursor.runId as string);
    }
    async function state(saved: LearningAttempt): Promise<NonWordRoundState> {
        const cursor = decode(saved), keys = (positions: number[]) => positions.map(position => members[position].itemKey);
        return { schemaVersion: 1, anchorAttemptId: anchorId, sourceHash, runId: cursor.runId, roundId: await options.fingerprint([binding.roundId, cursor.runId]),
            currentItemKey: cursor.currentIndex === null ? null : members[cursor.currentIndex].itemKey, members: structuredClone(members),
            traversal: { correctKeys: keys(cursor.correct), wrongKeys: keys(cursor.wrong), awaitingReviewKeys: keys(cursor.awaiting), skippedKeys: keys(cursor.skipped) } };
    }
    function mutationFor(cursor:StoredCursor,marker?:string,clearMarker=false):AttemptMutation {
        const notes = JSON.stringify(cursor);
        if (notes.length > 32000)
            throw Error('nonword-round-cursor-size');
        const view=marker?{purpose:'guided' as const,instanceId:marker,lessonStep:'independent' as const,paused:false,referenceSeen:false}:clearMarker?undefined:row?.checkpoint.view;
        return { schemaVersion: 1, attemptId: anchorId, operationId: options.newId(), expectedRevision: row?.revision ?? 0, binding, updatedAt: options.now(),
            kind: 'checkpoint', answer: '', parentAttemptId: null, checkpoint: { phase: 'lesson', mode: 'lesson', purpose: 'guided', intent: 'lesson', position: cursor.currentIndex ?? 0, traversed: false, pluginFields: { notes },...(view?{view}:{}) } };
    }
    async function baseFor(saved:NonWordRoundState):Promise<AttemptBinding>{
        return {...binding,groupId:await options.fingerprint(options.attemptGroupId),roundId:await options.fingerprint(saved.roundId)};
    }
    async function projected(saved:LearningAttempt){
        const value=await state(saved);return options.attemptGroupId?continuations.project(value,await baseFor(value)):value;
    }
    async function apply(cursor: StoredCursor,prepared?:AttemptMutation): Promise<NonWordRoundState> {
        if (await options.repository.status?.(anchorId) === 'cloud-conflict')throw Error('nonword-round-conflict');
        const mutation=prepared??mutationFor(cursor);
        let result;
        try {
            result = await options.repository.mutate(mutation);
        }
        catch (error) {
            const saved = await options.repository.read(anchorId).catch(() => null), fingerprint = await options.fingerprint(mutation);
            if (!saved?.operations.some(operation => operation.operationId === mutation.operationId && operation.fingerprint === fingerprint))
                throw error;
            row = saved;
            return state(saved);
        }
        if (!result.durable || result.status === 'conflict' || !result.attempt)
            throw Error('nonword-round-cursor-conflict');
        row = result.attempt;
        return state(row);
    }
    return {
        async hydrateContinuations(remote:{read:(id:string)=>Promise<LearningAttempt|null>},hydrate:(row:LearningAttempt)=>Promise<unknown>){
            await identify();if(!options.attemptGroupId)return;
            const saved=await options.repository.read(anchorId);if(!saved)throw Error('nonword-round-not-open');
            const current=await state(saved);await continuations.hydrateRound(current,await baseFor(current),remote,hydrate);
        },
        async anchorAttemptId(): Promise<string> { await identify(); return anchorId; },
        async validateSnapshot(saved: LearningAttempt): Promise<NonWordRoundState> { await identify(); return state(saved); },
        open: (raw=false) => serial(async () => {
            await identify();
            row = await options.repository.read(anchorId);
            if (!row)
                return apply(encode(initialCursor ?? { currentItemKey: members[0].itemKey, traversal: emptyTraversal() }, initialRunId));
            return raw?state(row):projected(row);
        }),
        read: () => serial(async () => {
            await identify();
            const saved = await options.repository.read(anchorId);
            if (!saved)
                throw Error('nonword-round-not-open');
            row = saved;
            return projected(row);
        }),
        selectItem: (itemKey: string, expectedRunId: string) => serial(async () => {
            await identify();
            const saved = await options.repository.read(anchorId);
            if (!saved)
                throw Error('nonword-round-not-open');
            row = saved;
            const current = await projected(saved);
            if (current.runId !== expectedRunId)
                throw Error('nonword-round-run-conflict');
            if (!members.some(member => member.itemKey === itemKey))
                throw Error('nonword-round-unknown-item');
            return current.currentItemKey === itemKey ? current : apply(encode({ currentItemKey: itemKey, traversal: current.traversal }, current.runId));
        }),
        saveCursor: (input: RoundCursorInput, expectedRunId?: string, expectedBoundary?:string) => serial(async () => {
            await identify();
            if(expectedBoundary!==undefined){
                const saved=await options.repository.read(anchorId);if(!saved)throw Error('nonword-round-not-open');row=saved;
                const current=await state(saved);
                await continuations.assertBoundary(await baseFor(current),expectedBoundary,{anchorAttemptId:anchorId,sourceHash,runId:current.runId,roundId:current.roundId});
            }
            if (!row)
                throw Error('nonword-round-not-open');
            const runId = decode(row).runId;
            if (expectedRunId !== undefined && runId !== expectedRunId)
                throw Error('nonword-round-run-conflict');
            return apply(encode(structuredClone(input), runId));
        }),
        reopenPendingWithAck: options.attemptGroupId?()=>serial(async()=>{
            await identify();const saved=await options.repository.read(anchorId);
            if(!saved)throw Error('nonword-round-not-open');row=saved;
            const current=await projected(saved),key=current.members.find(member=>current.traversal.awaitingReviewKeys.includes(member.itemKey))?.itemKey;
            if(!key)return current;
            const cursor=encode({currentItemKey:key,traversal:{...current.traversal,awaitingReviewKeys:[]}},current.runId);
            const marker=`nw-reopen:${options.newId()}`,mutation=mutationFor(cursor,marker);
            mutation.operationId=marker;
            await continuations.stageReopen(current,await baseFor(current),{boundary:marker,operationId:mutation.operationId,fingerprint:await options.fingerprint(mutation)});
            return apply(cursor,mutation);
        }):undefined,
        startNewRound: (input: {
            restartConfirmed: boolean;
        }) => serial(async () => {
            await identify();
            if (!row)
                throw Error('nonword-round-not-open');
            object(input, ['restartConfirmed']);
            if (input.restartConfirmed !== true)
                throw Error('nonword-round-restart-not-confirmed');
            const nextRun = attemptId(options.newId());
            if (nextRun === decode(row).runId)
                throw Error('nonword-round-restart-identity');
            const cursor=encode({ currentItemKey: members[0].itemKey, traversal: emptyTraversal() }, nextRun);
            return apply(cursor,mutationFor(cursor,undefined,true));
        }),
    };
}
