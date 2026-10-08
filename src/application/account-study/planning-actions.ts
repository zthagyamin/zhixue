import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, id } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
export async function executePlanningAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext): Promise<AccountReply | null> {
    const { deps, longTermStore, requireRole, scope } = context;
    const p = auth.principal, action = body.action;
    if (action === 'publish-planning-catalog') {
        requireRole(p, 'device');
        fields(body, ['action', 'catalog'], ['libraryId']);
        const owner = await scope(p, body.libraryId);
        const raw = body.catalog as {
            snapshotId?: unknown;
        };
        if (!raw || typeof raw !== 'object')
            throw new ApiFailure(400, 'invalid-study-payload');
        if (!await (await deps.getStudyStore()).getSnapshot(owner, id(raw.snapshotId, 'snapshot')))
            throw new ApiFailure(404, 'unknown-study-snapshot');
        return json({ status: await (await deps.getPlanStore()).putCatalog(owner, raw) });
    }
    if (action === 'publish-planning-facts') {
        requireRole(p, 'device');
        fields(body, ['action', 'facts'], ['libraryId']);
        return json({ status: await (await deps.getPlanStore()).putFacts(await scope(p, body.libraryId), body.facts) });
    }
    if (action === 'mutate-plan') {
        requireRole(p, 'browser');
        fields(body, ['action', 'mutation'], ['libraryId']);
        return json(await (await deps.getPlanStore()).mutate(await scope(p, body.libraryId), body.mutation));
    }
    if (action === 'mutate-long-term-plan') {
        requireRole(p, 'browser');
        fields(body, ['action', 'mutation'], ['libraryId']);
        return json(await (await longTermStore()).mutate(await scope(p, body.libraryId), body.mutation));
    }
    if (action === 'plan-execution-receipt') {
        requireRole(p, 'device');
        if (p.kind !== 'device')
            throw new ApiFailure(403, 'action-not-allowed');
        fields(body, ['action', 'receipt'], ['libraryId']);
        return json(await (await deps.getPlanStore()).appendExecution(await scope(p, body.libraryId), body.receipt, p.grantId));
    }
    if (action === 'claim-plan-operation') {
        requireRole(p, 'device');
        if (p.kind !== 'device')
            throw new ApiFailure(403, 'action-not-allowed');
        fields(body, ['action', 'operationId'], ['libraryId']);
        return json(await (await deps.getPlanStore()).claimExecution(await scope(p, body.libraryId), id(body.operationId, 'operation'), p.grantId));
    }
    if (action === 'decide-content') {
        requireRole(p, 'browser');
        fields(body, ['action', 'decision'], ['libraryId']);
        return json(await (await deps.getContentDecisionStore()).decide(await scope(p, body.libraryId), body.decision));
    }
    if (action === 'content-decision-receipt') {
        requireRole(p, 'device');
        if (p.kind !== 'device')
            throw new ApiFailure(403, 'action-not-allowed');
        fields(body, ['action', 'receipt'], ['libraryId']);
        return json(await (await deps.getContentDecisionStore()).appendReceipt(await scope(p, body.libraryId), body.receipt, p.grantId));
    }
    return null;
}
