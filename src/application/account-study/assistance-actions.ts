import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, validated } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseAccountAssistance, parseAssistanceReceipt, parseWritebackReceipt } from '../../domain/sync/index.ts';
export async function executeAssistanceAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext): Promise<AccountReply | null> {
    const { deps, assistanceStore, requireRole, scope } = context;
    const p = auth.principal, action = body.action;
    if (action === 'append-assistance') {
        requireRole(p, 'browser');
        fields(body, ['action', 'records'], ['libraryId']);
        if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 20)
            throw new ApiFailure(400, 'invalid-assistance-batch');
        const owner = await scope(p, body.libraryId), store = await assistanceStore(), records = await validated(() => Promise.all((body.records as unknown[]).map(parseAccountAssistance)));
        if (records.some(record => record.libraryId !== owner.libraryId))
            throw new ApiFailure(403, 'library-mismatch');
        const results = [];
        for (const record of records)
            results.push(await store.append(owner, record));
        return json({ results });
    }
    if (action === 'assistance-receipt') {
        requireRole(p, 'device');
        if (p.kind !== 'device')
            throw new ApiFailure(403, 'action-not-allowed');
        fields(body, ['action', 'receipt'], ['libraryId']);
        const owner = await scope(p, body.libraryId), store = await assistanceStore(), receipt = await validated(() => Promise.resolve(parseAssistanceReceipt(body.receipt)));
        return json(await store.appendReceipt(owner, receipt, p.grantId));
    }
    if (action === 'writeback-receipt') {
        requireRole(p, 'device');
        if (p.kind !== 'device')
            throw new ApiFailure(403, 'action-not-allowed');
        fields(body, ['action', 'receipt'], ['libraryId']);
        const owner = await scope(p, body.libraryId);
        const receipt = await validated(async () => parseWritebackReceipt(body.receipt));
        return json(await (await deps.getReceiptStore()).append(owner, receipt, p.grantId));
    }
    return null;
}
