import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, id } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
export async function executeAccessAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext): Promise<AccountReply | null> {
    const { deps, requireRole } = context;
    const p = auth.principal, action = body.action;
    if (action === 'register-grant') {
        requireRole(p, 'browser');
        fields(body, ['action', 'grantId', 'libraryId', 'tokenHash', 'label', 'expectedProfileRevision', 'replaceLibrary']);
        const input = { ...body };
        delete input.action;
        return json(await (await deps.getAccessStore()).register(p.userId, input));
    }
    if (action === 'activate-grant') {
        requireRole(p, 'device', true);
        fields(body, ['action']);
        return json(await (await deps.getAccessStore()).activate(auth.secret));
    }
    if (action === 'revoke-grant') {
        requireRole(p, 'browser');
        fields(body, ['action', 'grantId']);
        return json({ revoked: await (await deps.getAccessStore()).revoke(p.userId, id(body.grantId, 'grant')) });
    }
    return null;
}
