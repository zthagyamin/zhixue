// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { id } from './request-values.ts';
import type { AccountStudyDependencies, Principal, StudyScope, LongTermStorePort, AssistanceStorePort } from './ports';
export function createAccountContext(deps: AccountStudyDependencies) {
    async function longTermStore(): Promise<LongTermStorePort> {
        const store = await deps.getLongTermStore?.();
        if (!store)
            throw new ApiFailure(503, 'long-term-planning-unavailable');
        return store;
    }
    async function assistanceStore(): Promise<AssistanceStorePort> {
        const store = await deps.getAssistanceStore?.();
        if (!store || !await store.supported())
            throw new ApiFailure(409, 'assistance-unsupported');
        return store;
    }
    function requireRole(principal: Principal, role: 'browser' | 'device', pending = false): void {
        if (principal.kind !== role || (!pending && principal.kind === 'device' && principal.state !== 'active'))
            throw new ApiFailure(403, 'action-not-allowed');
    }
    function expectedAccount(principal: Principal, expected: unknown): void {
        if (expected !== undefined && id(expected, 'expected-user') !== principal.userId)
            throw new ApiFailure(403, 'account-mismatch');
    }
    async function scope(principal: Principal, value?: unknown): Promise<StudyScope> {
        const supplied = value === undefined ? undefined : id(value, 'library');
        if (principal.kind === 'device') {
            if (supplied !== undefined && supplied !== principal.libraryId)
                throw new ApiFailure(403, 'library-mismatch');
            return { userId: principal.userId, libraryId: principal.libraryId };
        }
        const profile = await (await deps.getAccessStore()).profile(principal.userId), libraryId = supplied ?? profile.libraryId;
        if (supplied !== undefined && profile.libraryId !== supplied)
            throw new ApiFailure(403, 'library-mismatch');
        if (!libraryId)
            throw new ApiFailure(404, 'study-library-not-configured');
        return { userId: principal.userId, libraryId };
    }
    return { deps, longTermStore, assistanceStore, requireRole, expectedAccount, scope };
}
export type AccountContext = ReturnType<typeof createAccountContext>;
