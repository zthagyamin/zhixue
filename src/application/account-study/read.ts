import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { id, queryCount } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
export async function readAccountAction(params: Record<string, string>, auth: Authenticated, context: AccountContext): Promise<AccountReply> {
    const { deps, longTermStore, assistanceStore, requireRole, expectedAccount, scope } = context;
    const action = params.action ?? 'bootstrap', p = auth.principal;
    expectedAccount(p, params.expectedUserId);
    if (action === 'grant-info') {
        requireRole(p, 'device', true);
        return json(p);
    }
    if (p.kind === 'device')
        requireRole(p, 'device');
    if (action === 'bootstrap') {
        const profile = await (await deps.getAccessStore()).profile(p.userId);
        if (p.kind === 'device' && profile.libraryId !== p.libraryId)
            throw new ApiFailure(403, 'library-mismatch');
        const snapshot = profile.libraryId ? await (await deps.getStudyStore()).getSnapshot({ userId: p.userId, libraryId: profile.libraryId }) : null;
        const readFences = profile.libraryId ? await (await deps.getStudyStore()).readFences({ userId: p.userId, libraryId: profile.libraryId }) : null;
        const assistance = await deps.getAssistanceStore?.(), hasAssistance = assistance ? await assistance.supported() : false;
        const assistanceFences = hasAssistance && profile.libraryId ? await assistance!.readFences({ userId: p.userId, libraryId: profile.libraryId }) : null;
        return json({ apiVersion: 1, enabled: true, profile, snapshot, readFences, capabilities: hasAssistance ? ['assistance-summary-v1', 'assistance-summary-v2'] : [], assistanceFences });
    }
    if (action === 'planning-catalog') {
        const owner = await scope(p, params.libraryId), catalog = await (await deps.getPlanStore()).getCatalog(owner, id(params.snapshotId, 'snapshot'));
        if (!catalog)
            throw new ApiFailure(404, 'unknown-planning-catalog');
        return json(catalog);
    }
    if (action === 'planning-catalog-hash') {
        const owner = await scope(p, params.libraryId), catalog = await (await deps.getPlanStore()).getCatalogByHash(owner, id(params.catalogHash, 'catalog-hash'));
        if (!catalog)
            throw new ApiFailure(404, 'unknown-planning-catalog');
        return json(catalog);
    }
    if (action === 'planning-facts') {
        const owner = await scope(p, params.libraryId), facts = await (await deps.getPlanStore()).getFacts(owner, id(params.snapshotId, 'snapshot'));
        if (!facts)
            throw new ApiFailure(404, 'unknown-planning-facts');
        return json(facts);
    }
    if (action === 'plan-state')
        return json(await (await deps.getPlanStore()).getState(await scope(p, params.libraryId), id(params.day, 'plan-day')));
    if (action === 'long-term-plan')
        return json(await (await longTermStore()).getState(await scope(p, params.libraryId)));
    if (action === 'ai-settings') {
        const owner = await scope(p, params.libraryId);
        return json({ settings: await (await deps.getAiStore()).getSettings(owner), serverAvailable: deps.planAiAvailable?.() ?? false });
    }
    if (action === 'plan-operations' || action === 'plan-executions' || action === 'content-decisions') {
        const owner = await scope(p, params.libraryId), limit = queryCount(params.limit, 'limit', 20), after = queryCount(params.after, 'cursor', 0), through = params.through === undefined ? undefined : queryCount(params.through, 'read-fence', 0);
        if (limit < 1 || limit > 20)
            throw new ApiFailure(400, 'invalid-limit');
        if (action === 'content-decisions')
            return json(await (await deps.getContentDecisionStore()).list(owner, after, limit, through));
        const store = await deps.getPlanStore();
        return json(action === 'plan-operations' ? await store.listOperations(owner, after, limit, through) : await store.listExecutions(owner, after, limit, through));
    }
    if (action === 'assistance' || action === 'assistance-receipts') {
        const owner = await scope(p, params.libraryId), store = await assistanceStore(), after = queryCount(params.after, 'cursor', 0), limit = queryCount(params.limit, 'limit', 20), through = params.through === undefined ? undefined : queryCount(params.through, 'read-fence', 0);
        if (limit < 1 || limit > 20)
            throw new ApiFailure(400, 'invalid-limit');
        return json(action === 'assistance' ? await store.listAfter(owner, after, limit, through) : await store.listReceiptsAfter(owner, after, limit, through));
    }
    if (!['manifest', 'items', 'records', 'receipts'].includes(action))
        throw new ApiFailure(400, 'unsupported-action');
    const owner = await scope(p, params.libraryId), store = await deps.getStudyStore();
    if (action === 'manifest') {
        const snapshot = await store.getSnapshot(owner, params.snapshotId === undefined ? undefined : id(params.snapshotId, 'snapshot'));
        if (!snapshot)
            throw new ApiFailure(404, 'unknown-study-snapshot');
        return json(snapshot);
    }
    const limit = queryCount(params.limit, 'limit', 20);
    if (limit < 1 || limit > 20)
        throw new ApiFailure(400, 'invalid-limit');
    if (action === 'items')
        return json(await store.getSnapshotItems(owner, id(params.snapshotId, 'snapshot'), queryCount(params.position, 'position', 0), limit));
    if (action === 'receipts')
        return json(await (await deps.getReceiptStore()).listAfter(owner, queryCount(params.after, 'cursor', 0), limit, params.through === undefined ? undefined : queryCount(params.through, 'read-fence', 0)));
    return json(await store.listRecordsAfter(owner, queryCount(params.after, 'cursor', 0), limit, params.through === undefined ? undefined : queryCount(params.through, 'read-fence', 0)));
}
