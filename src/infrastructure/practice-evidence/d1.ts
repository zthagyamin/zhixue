import type {LearningAttempt} from '../../domain/learning-attempt';
import type {PracticeEvidenceMutationV1, PracticeEvidenceReceipt, PracticeEvidenceV1} from '../../domain/practice-evidence';
import type {AccountPracticeEvidenceOriginalPort, AccountPracticeEvidenceMappingPort, AccountPracticeEvidenceScope, AccountPracticeEvidenceStorePort, PracticeEvidencePage, PracticeEvidenceAttemptPort, PracticeEvidenceServiceWritePort} from '../../application/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolvePracticeEvidenceAuthority} from '../../application/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidence, parsePracticeEvidenceMutation, applyPracticeEvidenceMutation, validatePracticeEvidenceAuthority, evidenceEqual, practiceEvidenceFingerprint} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport} from '../../domain/content/index.ts';

type Options = {mapping?:AccountPracticeEvidenceMappingPort;service?:PracticeEvidenceServiceWritePort};
export class D1PracticeEvidenceStore implements AccountPracticeEvidenceStorePort {
    private database:Pick<D1Database,'prepare'>;
    private original:AccountPracticeEvidenceOriginalPort;
    private options:Options;
    constructor(database:Pick<D1Database,'prepare'>, original:AccountPracticeEvidenceOriginalPort, options:Options={}) {
        this.database=database;this.original=original;this.options=options;
    }
    private q(sql:string,...values:(string|number|null)[]) {return this.database.prepare(sql).bind(...values);}
    async supported():Promise<boolean> {
        const rows=await this.q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('practice_evidence_v1','learning_attempts_v1','account_study_snapshots','account_study_snapshot_members')").all<{name:string}>();
        return rows.results.length===4;
    }
    private scope(scope:AccountPracticeEvidenceScope) {attemptId(scope.userId);attemptId(scope.libraryId);}
    private attempts(scope:AccountPracticeEvidenceScope):PracticeEvidenceAttemptPort {
        return {readAttempt:id=>this.original.readAttempt(scope,id), resolveSource:async a=>{
            const item=await this.original.readItem(scope,a.binding);
            if(!item||item.itemKey!==a.binding.itemKey||item.contentHash!==a.binding.contentHash||item.practice?.questionType!=='calculation')return null;
            const calculation=parseCalculationSupport(item.learningSupport);
            const mapping=await this.options.mapping?.resolveMapping(scope,a.binding);
            return {binding:a.binding,calculation,...(mapping?{mapping}:{})};
        }};
    }
    private async member(scope:AccountPracticeEvidenceScope,a:LearningAttempt) {
        const b=a.binding;
        const member=await this.q(this.memberSql(),scope.userId,scope.libraryId,b.snapshotId,b.itemKey,b.contentHash).first();
        if(!member||!await this.original.readItem(scope,b))throw Error('practice-evidence-source-unavailable');
    }
    private memberSql() {return 'SELECT 1 FROM account_study_snapshot_members m JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=? AND s.published=1';}
    private answerMapping(record:PracticeEvidenceV1,attempt:LearningAttempt) {
        for(const report of [record.execution?.first,record.execution?.latest])
            if(report&&report.mapping.originalLineCount!==attempt.submitted?.answer.split('\n').length)throw Error('practice-evidence-answer-mapping');
    }
    private async raw(scope:AccountPracticeEvidenceScope,id:string) {
        const row=await this.q('SELECT evidence_json FROM practice_evidence_v1 WHERE user_id=? AND library_id=? AND attempt_id=?',scope.userId,scope.libraryId,id).first<{evidence_json:string}>();
        return row?parsePracticeEvidence(JSON.parse(row.evidence_json)):null;
    }
    async read(scope:AccountPracticeEvidenceScope,id:string):Promise<PracticeEvidenceV1|null> {
        this.scope(scope);attemptId(id);
        if(!await this.supported())throw Error('practice-evidence-unsupported');
        const record=await this.raw(scope,id);
        if(!record)return null;
        if(record.attemptId!==id)throw Error('practice-evidence-record-binding');
        const authority=await resolvePracticeEvidenceAuthority({ownerId:scope.userId,libraryId:scope.libraryId},this.attempts(scope),record);
        await this.member(scope,authority.attempt);
        await validatePracticeEvidenceAuthority(record,authority);this.answerMapping(record,authority.attempt);return record;
    }
    async list(scope:AccountPracticeEvidenceScope,page:{cursor?:string;limit?:number}={}):Promise<PracticeEvidencePage> {
        this.scope(scope);if(page.cursor!==undefined)attemptId(page.cursor);
        const limit=page.limit??200;
        if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('practice-evidence-page-limit');
        if(!await this.supported())throw Error('practice-evidence-unsupported');
        const rows=await this.q('SELECT attempt_id FROM practice_evidence_v1 WHERE user_id=? AND library_id=? AND attempt_id>? ORDER BY attempt_id LIMIT ?',scope.userId,scope.libraryId,page.cursor??'',limit+1).all<{attempt_id:string}>();
        const records:PracticeEvidenceV1[]=[];
        for(const row of rows.results.slice(0,limit)) {const record=await this.read(scope,row.attempt_id);if(!record)throw Error('practice-evidence-page-changed');records.push(record);}
        const complete=rows.results.length<=limit;
        return {records,complete,nextCursor:complete?null:records.at(-1)!.attemptId};
    }
    mutate(scope:AccountPracticeEvidenceScope,mutation:PracticeEvidenceMutationV1) {return this.write(scope,mutation,false);}
    trustedWriter() {return {mutate:(scope:AccountPracticeEvidenceScope,mutation:PracticeEvidenceMutationV1)=>this.write(scope,mutation,true)};}
    private async write(scope:AccountPracticeEvidenceScope,raw:PracticeEvidenceMutationV1,trusted:boolean):Promise<PracticeEvidenceReceipt> {
        this.scope(scope);const m=parsePracticeEvidenceMutation(raw),b=m.binding;
        if(b.ownerId!==scope.userId||b.libraryId!==scope.libraryId)throw Error('practice-evidence-scope-binding');
        if(!trusted&&(m.kind==='step-diagnostic'&&m.diagnostic.source==='model'||m.kind==='code-hint'&&m.hint.source==='model'))throw Error('practice-evidence-trusted-service-required');
        if(!await this.supported())throw Error('practice-evidence-unsupported');
        const current=await this.read(scope,m.attemptId);
        const authority=await resolvePracticeEvidenceAuthority({ownerId:scope.userId,libraryId:scope.libraryId},this.attempts(scope),m,trusted?this.options.service:undefined,current);
        await this.member(scope,authority.attempt);
        const next=await applyPracticeEvidenceMutation(current,m,authority);
        if(next.status!=='accepted')return {...next,durable:next.status==='duplicate'};
        this.answerMapping(next.record!,authority.attempt);
        // Pin the exact DB original, navigation children and remediation variant parent;
        // every mutation is guarded
        // in its committing SQL statement, so a submit/formal claim cannot race this write.
        const originals=[authority.attempt,authority.currentPreparedChild,authority.preparedChild,authority.parentAttempt].filter((a):a is LearningAttempt=>Boolean(a));
        let guard='EXISTS ('+this.memberSql()+')';
        const guardValues:(string|number|null)[]=[scope.userId,scope.libraryId,b.snapshotId,b.itemKey,b.contentHash];
        for(const a of originals) {
            const row=await this.q('SELECT attempt_json,revision FROM learning_attempts_v1 WHERE user_id=? AND library_id=? AND attempt_id=?',scope.userId,scope.libraryId,a.attemptId).first<{attempt_json:string;revision:number}>();
            if(!row||row.revision!==a.revision||!evidenceEqual(JSON.parse(row.attempt_json),a))return {status:'conflict',durable:false,operationId:m.operationId,revision:current?.revision??0,record:current};
            guard+=' AND EXISTS (SELECT 1 FROM learning_attempts_v1 WHERE user_id=? AND library_id=? AND attempt_id=? AND revision=? AND attempt_json=?)';
            guardValues.push(scope.userId,scope.libraryId,a.attemptId,a.revision,row.attempt_json);
        }
        const saved=next.record!,json=JSON.stringify(saved);
        if(!current)await this.q('INSERT INTO practice_evidence_v1(user_id,library_id,attempt_id,revision,evidence_json,updated_at) SELECT ?,?,?,?,?,? WHERE '+guard+' ON CONFLICT DO NOTHING',scope.userId,scope.libraryId,m.attemptId,saved.revision,json,saved.updatedAt,...guardValues).run();
        else await this.q('UPDATE practice_evidence_v1 SET revision=?,evidence_json=?,updated_at=? WHERE user_id=? AND library_id=? AND attempt_id=? AND revision=? AND '+guard,saved.revision,json,saved.updatedAt,scope.userId,scope.libraryId,m.attemptId,current.revision,...guardValues).run();
        const record=await this.read(scope,m.attemptId),operation=record?.operations.find(o=>o.operationId===m.operationId);
        if(operation?.fingerprint!==await practiceEvidenceFingerprint(m))return {status:'conflict',durable:false,operationId:m.operationId,revision:record?.revision??0,record};
        return {...next,durable:true,record,revision:record!.revision};
    }
}
