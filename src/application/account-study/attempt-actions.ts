import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseAttemptMutation, attemptId } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, validated } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue } from './result.ts';
export async function executeAttemptAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext): Promise<AccountReply | null> {
    if (!['attempt-read', 'attempt-list', 'attempt-mutate', 'attempt-reference'].includes(String(body.action)))
        return null;
    if (auth.principal.kind === 'device')
        context.requireRole(auth.principal, 'device');
    const owner = await context.scope(auth.principal, body.libraryId), store = await context.deps.getAttemptStore?.();
    if (!store || !await store.supported())
        throw new AccountFailure(409, 'learning-attempts-unsupported');
    if (body.action === 'attempt-mutate') {
        fields(body, ['action', 'mutation'], ['libraryId']);
        const mutation = await validated(async () => parseAttemptMutation(body.mutation));
        if (mutation.binding.ownerId !== owner.userId || mutation.binding.libraryId !== owner.libraryId)
            throw new AccountFailure(403, 'attempt-scope-mismatch');
        try {
            return accountValue(await store.mutate(owner, mutation));
        }
        catch (error) {
            if (error instanceof Error && /^(attempt-|submitted-answer-)/.test(error.message))
                throw new AccountFailure(409, error.message);
            throw error;
        }
    }
    if (body.action === 'attempt-list') {
        fields(body, ['action'], ['libraryId', 'groupId']);
        return accountValue({ attempts: await store.list(owner, body.groupId === undefined ? undefined : attemptId(body.groupId)) });
    }
    fields(body, ['action', 'attemptId'], ['libraryId']);
    const attempt = await store.read(owner, attemptId(body.attemptId));
    if (body.action === 'attempt-read')
        return accountValue({ attempt });
    if (!attempt)
        throw new AccountFailure(404, 'attempt-not-found');
    const study = await context.deps.getStudyStore();
    const item = await study.getSnapshotItem(owner, attempt.binding.snapshotId, attempt.binding.itemKey);
    if (!item || item.itemKey !== attempt.binding.itemKey || item.contentHash !== attempt.binding.contentHash)
        throw new AccountFailure(409, 'attempt-reference-unavailable');
    const snapshot = await study.getSnapshot(owner, attempt.binding.snapshotId);
    if (!snapshot || snapshot.snapshotId !== attempt.binding.snapshotId || snapshot.libraryId !== owner.libraryId
        || !snapshot.items.some(member => member.itemKey === item.itemKey && member.contentHash === item.contentHash))
        throw new AccountFailure(409, 'attempt-reference-unavailable');
    return accountValue({ item, snapshot });
}
