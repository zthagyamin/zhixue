import type {StudyStorePort,StudyScope} from '../../application/account-study';
import type {AccountMathMappingStorePort,MathMappingPublishReceipt} from '../../application/math-study';
import type {AttemptBinding} from '../../domain/learning-attempt';
import type {MathMappingPreparationV1,MathMappingPreparationRecordV1} from '../../domain/guided-math';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseMathMappingPreparation,validateMathMappingPreparation} from '../../domain/guided-math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyIso} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalizeJson} from '../../domain/evidence/index.ts';

type Row={schema_version:number;user_id:string;library_id:string;snapshot_id:string;item_key:string;content_hash:string;mapping_id:string;record_json:string;origin_grant_id:string;published_at:string};
const sourceSql='SELECT v.item_json,s.header_json,s.snapshot_hash,s.member_count FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=? AND s.published=1';
const membersSql='SELECT json_group_array(json_array(position,item_key,content_hash)) AS members FROM (SELECT position,item_key,content_hash FROM account_study_snapshot_members WHERE user_id=? AND library_id=? AND snapshot_id=? ORDER BY position)';
/** Append-only prepared mappings, resolved against complete historical sources.
 * Content and publication checks are repeated in the committing INSERT. */
export class D1MathMappingStore implements AccountMathMappingStorePort{
    private database:Pick<D1Database,'prepare'>;
    private study:StudyStorePort;
    constructor(database:Pick<D1Database,'prepare'>,study:StudyStorePort){this.database=database;this.study=study;}
    private q(sql:string,...values:(string|number|null)[]){return this.database.prepare(sql).bind(...values);}
    async supported():Promise<boolean>{
        const columns=(await this.q('PRAGMA table_info(math_variant_mappings_v1)').all<{name:string}>()).results.map(row=>row.name);
        const required=['schema_version','user_id','library_id','snapshot_id','item_key','content_hash','mapping_id','record_json','origin_grant_id','published_at'];
        if(required.some(column=>!columns.includes(column)))return false;
        return !await this.q('SELECT 1 FROM math_variant_mappings_v1 WHERE schema_version<>1 LIMIT 1').first();
    }
    private scope(scope:StudyScope){studyObject(scope,['userId','libraryId']);studyId(scope.userId);studyId(scope.libraryId);}
    private identity(scope:StudyScope,p:MathMappingPreparationV1){return [scope.userId,scope.libraryId,p.snapshotId,p.mapping.parentItemKey,p.mapping.parentContentHash,p.mapping.mappingId];}
    private async raw(scope:StudyScope,p:MathMappingPreparationV1){return this.q('SELECT * FROM math_variant_mappings_v1 WHERE user_id=? AND library_id=? AND snapshot_id=? AND item_key=? AND content_hash=? AND mapping_id=?',...this.identity(scope,p)).first<Row>();}
    private async original(scope:StudyScope,p:MathMappingPreparationV1){
        const snapshot=await this.study.getSnapshot(scope,p.snapshotId);
        const item=await this.study.getSnapshotItem(scope,p.snapshotId,p.mapping.parentItemKey);
        if(!snapshot||snapshot.snapshotId!==p.snapshotId||snapshot.libraryId!==scope.libraryId||!item
            ||!snapshot.items.some(m=>m.itemKey===item.itemKey&&m.contentHash===item.contentHash))throw Error('math-mapping-original-unavailable');
        validateMathMappingPreparation(p,item);return item;
    }
    private async checked(scope:StudyScope,row:Row):Promise<MathMappingPreparationRecordV1>{
        const value=studyObject(JSON.parse(row.record_json),['schemaVersion','preparation','provenance','technicalValidation']);
        const p=parseMathMappingPreparation(value.preparation),provenance=studyObject(value.provenance,['originGrantId','publishedAt']);
        const technical=studyObject(value.technicalValidation,['schemaVersion','templateVersion']);
        studyId(provenance.originGrantId);studyIso(provenance.publishedAt);
        if(row.schema_version!==1||value.schemaVersion!==1||technical.schemaVersion!==1||technical.templateVersion!==1
            ||row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.snapshot_id!==p.snapshotId||row.item_key!==p.mapping.parentItemKey
            ||row.content_hash!==p.mapping.parentContentHash||row.mapping_id!==p.mapping.mappingId
            ||row.origin_grant_id!==provenance.originGrantId||row.published_at!==provenance.publishedAt)throw Error('math-mapping-record-binding');
        await this.original(scope,p);
        return {schemaVersion:1,preparation:p,provenance:{originGrantId:provenance.originGrantId,publishedAt:provenance.publishedAt},technicalValidation:{schemaVersion:1,templateVersion:1}};
    }
    async readPreparation(scope:StudyScope,binding:AttemptBinding):Promise<MathMappingPreparationRecordV1|null>{
        this.scope(scope);
        if(binding.ownerId!==scope.userId||binding.libraryId!==scope.libraryId)throw Error('math-mapping-scope-binding');
        if(!await this.supported())return null;
        const rows=(await this.q('SELECT * FROM math_variant_mappings_v1 WHERE user_id=? AND library_id=? AND snapshot_id=? AND item_key=? AND content_hash=?',scope.userId,scope.libraryId,binding.snapshotId,binding.itemKey,binding.contentHash).all<Row>()).results;
        if(!rows.length)return null;
        if(rows.length!==1)throw Error('math-mapping-record-conflict');
        return this.checked(scope,rows[0]);
    }
    async resolveMapping(scope:StudyScope,binding:AttemptBinding){return (await this.readPreparation(scope,binding))?.preparation.mapping??null;}
    async publish(scope:StudyScope,raw:MathMappingPreparationV1,provenance:{originGrantId:string;publishedAt:string}):Promise<MathMappingPublishReceipt>{
        this.scope(scope);const p=parseMathMappingPreparation(raw);
        studyObject(provenance,['originGrantId','publishedAt']);studyId(provenance.originGrantId);studyIso(provenance.publishedAt);
        if(!await this.supported())throw Error('math-mapping-unsupported');
        const args=this.identity(scope,p).slice(0,5);
        const pinned=await this.q(sourceSql,...args).first<{item_json:string;header_json:string;snapshot_hash:string;member_count:number}>();
        if(!pinned)throw Error('math-mapping-original-unavailable');
        const members=await this.q(membersSql,scope.userId,scope.libraryId,p.snapshotId).first<string>('members');
        const item=await this.original(scope,p);
        if(canonicalizeJson(item)!==canonicalizeJson(JSON.parse(pinned.item_json)))throw Error('math-mapping-original-changed');
        const old=await this.raw(scope,p);
        if(old){const record=await this.checked(scope,old),same=canonicalizeJson(record.preparation)===canonicalizeJson(p);
            return {status:same?'duplicate':'conflict',durable:same,record};}
        const record:MathMappingPreparationRecordV1={schemaVersion:1,preparation:p,provenance:{...provenance},technicalValidation:{schemaVersion:1,templateVersion:1}};
        const result=await this.q('INSERT INTO math_variant_mappings_v1(schema_version,user_id,library_id,snapshot_id,item_key,content_hash,mapping_id,record_json,origin_grant_id,published_at) SELECT 1,?,?,?,?,?,?,?,?,? WHERE EXISTS ('+sourceSql+' AND v.item_json=? AND s.header_json=? AND s.snapshot_hash=? AND s.member_count=?) AND ('+membersSql.replace(' AS members','')+')=? AND EXISTS (SELECT 1 FROM account_study_grants g JOIN account_study_profiles p ON p.user_id=g.user_id AND p.library_id=g.library_id WHERE g.grant_id=? AND g.user_id=? AND g.library_id=? AND g.state=\'active\' AND g.expires_at>?) ON CONFLICT DO NOTHING',
            ...this.identity(scope,p),canonicalizeJson(record),provenance.originGrantId,provenance.publishedAt,...args,pinned.item_json,pinned.header_json,pinned.snapshot_hash,pinned.member_count,
            scope.userId,scope.libraryId,p.snapshotId,members,provenance.originGrantId,scope.userId,scope.libraryId,provenance.publishedAt).run();
        const saved=await this.raw(scope,p);
        if(!saved)return {status:'conflict',durable:false,record:null};
        const checked=await this.checked(scope,saved),same=canonicalizeJson(checked.preparation)===canonicalizeJson(p);
        return {status:!same?'conflict':result.meta.changes?'accepted':'duplicate',durable:same,record:checked};
    }
}
