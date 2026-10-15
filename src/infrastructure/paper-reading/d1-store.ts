import type {PaperReadingMutation, PaperReadingWorkspaceV1} from '../../domain/paper-reading';
import type {PaperReadingReceipt, PaperReadingScope, PaperReadingStorePort} from '../../application/paper-reading';
import type {PaperReadingDiscoveryQuery, PaperReadingDiscoveryPage, PaperReadingDiscoverySummary} from '../../application/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {applyPaperReadingMutation, parsePaperReadingMutation, parsePaperReadingWorkspace} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {PAPER_READING_DISCOVERY_MAX_PAGE_CHARS,paperReadingDiscoveryQuery,paperReadingDiscoverySummary,paperReadingDiscoveryCursor,parsePaperReadingDiscoveryPage} from '../../domain/paper-reading/index.ts';

type StoredWorkspace = {user_id:string; library_id:string; unit_id:string; revision:number; workspace_json:string};
type AccountScope = {userId:string; libraryId:string};

/** Account reading sidecar. The registered unit is its immutable source snapshot. */
export class D1PaperReadingStore implements PaperReadingStorePort {
    private database:Pick<D1Database, 'prepare'>;
    constructor(database:Pick<D1Database, 'prepare'>) {this.database=database;}

    private q(sql:string, ...values:(string|number|null)[]) {
        return this.database.prepare(sql).bind(...values);
    }

    private accountScope(scope:PaperReadingScope):AccountScope {
        if(!scope || typeof scope!=='object' || Array.isArray(scope)
            || Object.keys(scope).length!==2 || !Object.hasOwn(scope,'ownerId') || !Object.hasOwn(scope,'libraryId'))
            throw Error('paper-reading-scope-binding');
        const id=(value:unknown) => {
            if(typeof value!=='string' || value.length>200 || !value.startsWith('account:'))
                throw Error('paper-reading-scope-binding');
            const raw=value.slice('account:'.length);
            if(!raw || raw.trim()!==raw || Array.from(raw).some(character=>character.charCodeAt(0)<32 || character.charCodeAt(0)===127))
                throw Error('paper-reading-scope-binding');
            return raw;
        };
        return {userId:id(scope.ownerId), libraryId:id(scope.libraryId)};
    }

    private unitId(value:string) {
        if(typeof value!=='string' || !value.trim() || value.length>200) throw Error('paper-unit-binding');
    }

    private bindSource(scope:PaperReadingScope, workspace:PaperReadingWorkspaceV1, unitId:string) {
        if(workspace.unit.unitId!==unitId) throw Error('paper-unit-binding');
        if(workspace.unit.source.ownerId!==scope.ownerId || workspace.unit.source.libraryId!==scope.libraryId)
            throw Error('paper-reading-scope-binding');
    }

    async supported():Promise<boolean> {
        return Boolean(await this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_reading_workspaces_v1'").first());
    }

    async read(scope:PaperReadingScope, unitId:string):Promise<PaperReadingWorkspaceV1|null> {
        const account=this.accountScope(scope); this.unitId(unitId);
        const pinnedScope={ownerId:'account:'+account.userId, libraryId:'account:'+account.libraryId};
        if(!await this.supported()) throw Error('paper-reading-unsupported');
        const row=await this.q('SELECT user_id,library_id,unit_id,revision,workspace_json FROM paper_reading_workspaces_v1 WHERE user_id=? AND library_id=? AND unit_id=?',
            account.userId, account.libraryId, unitId).first<StoredWorkspace>();
        if(!row) return null;
        if(row.user_id!==account.userId || row.library_id!==account.libraryId || row.unit_id!==unitId)
            throw Error('paper-reading-row-binding');
        // Replay proves the aggregate and each embedded task/attempt still bind to this source.
        const workspace=parsePaperReadingWorkspace(JSON.parse(row.workspace_json));
        this.bindSource(pinnedScope, workspace, unitId);
        if(!Number.isSafeInteger(row.revision) || row.revision!==workspace.revision)
            throw Error('paper-reading-corrupt-revision');
        return workspace;
    }

    async list(inputScope:PaperReadingScope, rawQuery:PaperReadingDiscoveryQuery={}):Promise<PaperReadingDiscoveryPage> {
        const account=this.accountScope(inputScope);
        const scope={ownerId:'account:'+account.userId,libraryId:'account:'+account.libraryId};
        const snapshot=structuredClone(rawQuery),query=paperReadingDiscoveryQuery(scope,snapshot);
        if(!await this.supported())throw Error('paper-reading-unsupported');
        const rows=await this.q('SELECT user_id,library_id,unit_id,revision,workspace_json FROM paper_reading_workspaces_v1 WHERE user_id=? AND library_id=? AND unit_id>? ORDER BY unit_id COLLATE BINARY LIMIT ?',
            account.userId,account.libraryId,query.afterUnitId??'',query.limit+1).all<StoredWorkspace>();
        const items:PaperReadingDiscoverySummary[]=[];
        for(const row of rows.results){
            if(items.length===query.limit)break;
            if(row.user_id!==account.userId||row.library_id!==account.libraryId)throw Error('paper-reading-row-binding');
            const workspace=parsePaperReadingWorkspace(JSON.parse(row.workspace_json));
            this.bindSource(scope,workspace,row.unit_id);
            if(!Number.isSafeInteger(row.revision)||row.revision!==workspace.revision)throw Error('paper-reading-corrupt-revision');
            const summary=paperReadingDiscoverySummary(workspace);
            // Bound response size as well as item count; the cursor retains every excluded row.
            if(JSON.stringify({schemaVersion:1,scope,items:[...items,summary],nextCursor:paperReadingDiscoveryCursor(scope,row.unit_id)}).length>PAPER_READING_DISCOVERY_MAX_PAGE_CHARS){
                if(!items.length)throw Error('paper-reading-discovery-response-limit');
                break;
            }
            items.push(summary);
        }
        const nextCursor=rows.results.length>items.length?paperReadingDiscoveryCursor(scope,items[items.length-1].unitId):null;
        return parsePaperReadingDiscoveryPage({schemaVersion:1,scope,items,nextCursor},scope,snapshot);
    }

    mutate(scope:PaperReadingScope, mutation:PaperReadingMutation):Promise<PaperReadingReceipt> {
        return this.write(scope, mutation, 'public');
    }

    writeService(scope:PaperReadingScope, mutation:PaperReadingMutation):Promise<PaperReadingReceipt> {
        return this.write(scope, mutation, 'service');
    }

    private receipt(mutation:PaperReadingMutation, status:PaperReadingReceipt['status'], workspace:PaperReadingWorkspaceV1|null):PaperReadingReceipt {
        return {schemaVersion:1, operationId:mutation.operationId, status, durable:status!=='conflict', workspace};
    }

    private async write(scope:PaperReadingScope, raw:PaperReadingMutation, authority:'public'|'service'):Promise<PaperReadingReceipt> {
        const account=this.accountScope(scope), mutation=parsePaperReadingMutation(raw);
        const pinnedScope={ownerId:'account:'+account.userId, libraryId:'account:'+account.libraryId};
        if(mutation.kind==='register' && (mutation.unit.source.ownerId!==pinnedScope.ownerId || mutation.unit.source.libraryId!==pinnedScope.libraryId))
            throw Error('paper-reading-scope-binding');
        const current=await this.read(pinnedScope, mutation.unitId);
        // Public writes never accept tasks/feedback, even when a service operation is already saved.
        const result=applyPaperReadingMutation(current, mutation, authority);
        if(result.status!=='accepted') return this.receipt(mutation, result.status, result.workspace);
        const next=result.workspace!;
        this.bindSource(pinnedScope, next, mutation.unitId);
        let changes=0, writeError:unknown;
        try {
            const saved=current
                ? await this.q('UPDATE paper_reading_workspaces_v1 SET revision=?,workspace_json=? WHERE user_id=? AND library_id=? AND unit_id=? AND revision=?',
                    next.revision, JSON.stringify(next), account.userId, account.libraryId, mutation.unitId, current.revision).run()
                : await this.q('INSERT INTO paper_reading_workspaces_v1(user_id,library_id,unit_id,revision,workspace_json) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
                    account.userId, account.libraryId, mutation.unitId, next.revision, JSON.stringify(next)).run();
            changes=saved.meta?.changes??0;
        } catch(error) {
            // A lost response can follow a committed write; only the exact persisted operation resolves it.
            writeError=error;
        }
        const readback=await this.read(pinnedScope, mutation.unitId);
        const operation=readback?.operations.find(saved=>saved.operationId===mutation.operationId);
        if(operation && canonicalAttemptJson(operation)===canonicalAttemptJson(mutation))
            return this.receipt(mutation, !writeError && changes>0?'accepted':'duplicate', readback);
        if(writeError) throw writeError;
        return this.receipt(mutation, 'conflict', readback);
    }
}
