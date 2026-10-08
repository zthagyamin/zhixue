// @ts-expect-error TS5097: standalone Node contracts.
import { createAccountStudyHttpHandlers } from '../src/infrastructure/account-study/index.ts';
import type { AccountHttpDependencies } from '../src/infrastructure/account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseStudySnapshot, parseStudyItem } from './account-study-content.ts';
type Dependencies = Omit<AccountHttpDependencies, 'parseSnapshot' | 'parseItem' | 'now'> & {
    now?: () => Date;
};
/** Compatibility assembly: existing D1 adapters and content codec; no request/business policy here. */
export function createAccountStudyHandlers(deps: Dependencies) { return createAccountStudyHttpHandlers({ ...deps, now: deps.now ?? (() => new Date()), parseSnapshot: parseStudySnapshot, parseItem: parseStudyItem }); }
