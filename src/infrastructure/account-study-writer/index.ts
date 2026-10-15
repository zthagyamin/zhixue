// @ts-expect-error TS5097: standalone Node contracts.
import {studyId} from '../../domain/sync/index.ts';

type Scope = {userId: string; libraryId: string};
type Database = Pick<D1Database, 'prepare'>;

/** Optional only for trusted internal setup; HTTP device writers always supply a grant. */
export function studyWriterCondition(scope: Scope, grantId?: string) {
    if (grantId === undefined) return {sql: '1', bindings: [] as string[]};
    studyId(scope.userId, 'user'); studyId(scope.libraryId, 'library'); studyId(grantId, 'grant');
    return {
        sql: "EXISTS (SELECT 1 FROM account_study_grants g JOIN account_study_profiles p ON p.user_id=g.user_id AND p.library_id=g.library_id WHERE g.user_id=? AND g.library_id=? AND g.grant_id=? AND g.state='active' AND julianday(g.expires_at)>julianday('now'))",
        bindings: [scope.userId, scope.libraryId, grantId],
    };
}

export async function requireCurrentStudyWriter(database: Database, scope: Scope, grantId?: string) {
    if (grantId === undefined) return;
    const condition = studyWriterCondition(scope, grantId);
    if (!await database.prepare('SELECT 1 AS allowed WHERE ' + condition.sql).bind(...condition.bindings).first()) {
        throw new Error('study-writer-required');
    }
}
