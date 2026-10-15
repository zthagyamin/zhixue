import type {PaperReadingWorkspaceV1} from './workspace';
import type {PaperReadingTaskV1} from './evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePaperReadingWorkspace} from './workspace.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId} from '../sync/index.ts';

export type PaperReadingDiscoveryScope={ownerId:string;libraryId:string};
export type PaperReadingDiscoveryQuery={cursor?:string|null;limit?:number};
export type PaperReadingDiscoverySummary={
    schemaVersion:1;unitId:string;revision:number;title:string;materialFingerprint:string;sourceVersion:string;
    sectionId:string;paragraphIds:string[];
    task:null|{taskId:string;revision:number;origin:PaperReadingTaskV1['origin'];status:PaperReadingTaskV1['status'];
        ability:PaperReadingTaskV1['ability'];question:string};
    attemptCount:number;hasSubmission:boolean;pendingEvaluation:boolean;
};
export type PaperReadingDiscoveryPage={schemaVersion:1;scope:PaperReadingDiscoveryScope;
    items:PaperReadingDiscoverySummary[];nextCursor:string|null};
export const PAPER_READING_DISCOVERY_MAX_PAGE_CHARS=1_200_000;
const cursorPrefix='paper-reading-discovery:v1:';
function scopeValue(raw:unknown):PaperReadingDiscoveryScope{
    const value=studyObject(raw,['ownerId','libraryId']);
    for(const field of ['ownerId','libraryId']){
        studyId(value[field],'paper-discovery-scope');
        if(!(value[field] as string).startsWith('account:')||(value[field] as string).length<=8)throw Error('paper-reading-discovery-scope-binding');
    }
    return {ownerId:value.ownerId as string,libraryId:value.libraryId as string};
}
function sameScope(a:PaperReadingDiscoveryScope,b:PaperReadingDiscoveryScope){return a.ownerId===b.ownerId&&a.libraryId===b.libraryId;}
function text(value:unknown,max:number,empty=false):asserts value is string{
    if(typeof value!=='string'||value.length>max||!empty&&!value.trim())throw Error('paper-reading-discovery-invalid-text');
}
function count(value:unknown,min:number):asserts value is number{
    if(!Number.isSafeInteger(value)||(value as number)<min)throw Error('paper-reading-discovery-invalid-count');
}
function digest(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('paper-reading-discovery-source-binding');}
/** SQLite BINARY orders valid Unicode by scalar value, rather than UTF16 surrogate order. */
export function comparePaperReadingDiscoveryIds(a:string,b:string):number{
    const left=Array.from(a),right=Array.from(b);
    for(let i=0;i<Math.min(left.length,right.length);i++){
        const difference=left[i].codePointAt(0)!-right[i].codePointAt(0)!;
        if(difference)return difference;
    }
    return left.length-right.length;
}
export function paperReadingDiscoveryCursor(rawScope:PaperReadingDiscoveryScope,afterUnitId:string):string{
    const scope=scopeValue(rawScope);text(afterUnitId,200);
    return cursorPrefix+encodeURIComponent(JSON.stringify({...scope,afterUnitId}));
}
export function paperReadingDiscoveryQuery(rawScope:PaperReadingDiscoveryScope,raw:unknown={}){
    const scope=scopeValue(rawScope);let value:Record<string,unknown>;
    try{value=studyObject(raw,[],['cursor','limit']);}catch{throw Error('paper-reading-discovery-invalid-fields');}
    const limit=value.limit===undefined?20:value.limit;count(limit,1);
    if(limit>50)throw Error('paper-reading-discovery-invalid-limit');
    const cursor=value.cursor===undefined?null:value.cursor;
    let afterUnitId:string|null=null;
    if(cursor!==null){
        if(typeof cursor!=='string'||cursor.length>10000||!cursor.startsWith(cursorPrefix))throw Error('paper-reading-discovery-invalid-cursor');
        let decoded:unknown;
        try{decoded=JSON.parse(decodeURIComponent(cursor.slice(cursorPrefix.length)));}catch{throw Error('paper-reading-discovery-invalid-cursor');}
        const parts=studyObject(decoded,['ownerId','libraryId','afterUnitId']);
        if(!sameScope(scopeValue({ownerId:parts.ownerId,libraryId:parts.libraryId}),scope))throw Error('paper-reading-discovery-cursor-binding');
        text(parts.afterUnitId,200);afterUnitId=parts.afterUnitId as string;
        if(cursor!==paperReadingDiscoveryCursor(scope,afterUnitId))throw Error('paper-reading-discovery-invalid-cursor');
    }
    return {cursor:cursor as string|null,limit,afterUnitId};
}
export function parsePaperReadingDiscoverySummary(raw:unknown):PaperReadingDiscoverySummary{
    const value=studyObject(raw,['schemaVersion','unitId','revision','title','materialFingerprint','sourceVersion',
        'sectionId','paragraphIds','task','attemptCount','hasSubmission','pendingEvaluation']);
    if(value.schemaVersion!==1)throw Error('paper-reading-discovery-schema');
    text(value.unitId,200);count(value.revision,1);text(value.title,1200);text(value.sectionId,400);
    digest(value.materialFingerprint);digest(value.sourceVersion);
    if(!Array.isArray(value.paragraphIds)||!value.paragraphIds.length||value.paragraphIds.length>2667
        ||new Set(value.paragraphIds).size!==value.paragraphIds.length)throw Error('paper-reading-discovery-source-binding');
    for(const paragraphId of value.paragraphIds)text(paragraphId,400);
    count(value.attemptCount,0);
    if(typeof value.hasSubmission!=='boolean'||typeof value.pendingEvaluation!=='boolean'
        ||value.pendingEvaluation&&!value.hasSubmission||value.hasSubmission&&value.attemptCount===0)throw Error('paper-reading-discovery-attempt-binding');
    if(value.task!==null){
        const task=studyObject(value.task,['taskId','revision','origin','status','ability','question']);
        text(task.taskId,200);count(task.revision,1);text(task.question,2000,task.status==='needs-improvement');
        if(!['ai','prepared'].includes(task.origin as string)||!['ready','needs-improvement'].includes(task.status as string)
            ||!['definition','mechanism','comparison','condition','application'].includes(task.ability as string))throw Error('paper-reading-discovery-task-binding');
    }else if(value.attemptCount!==0)throw Error('paper-reading-discovery-attempt-binding');
    return structuredClone(value) as PaperReadingDiscoverySummary;
}
/** Derive a small projection from a verified immutable journal; never include answer/reference text. */
export function paperReadingDiscoverySummary(raw:PaperReadingWorkspaceV1):PaperReadingDiscoverySummary{
    const workspace=parsePaperReadingWorkspace(raw),task=workspace.task,source=workspace.unit.source;
    return parsePaperReadingDiscoverySummary({schemaVersion:1,unitId:workspace.unit.unitId,revision:workspace.revision,
        title:workspace.unit.title,materialFingerprint:source.materialFingerprint,sourceVersion:source.sourceVersion,
        sectionId:source.sectionId,paragraphIds:source.paragraphs.map(p=>p.id),task:task?{
            taskId:task.taskId,revision:task.revision,origin:task.origin,status:task.status,ability:task.ability,question:task.question}:null,
        attemptCount:workspace.attempts.length,hasSubmission:workspace.attempts.some(a=>a.submission!==null),
        pendingEvaluation:workspace.attempts.some(a=>a.submission!==null&&a.evaluation.status==='pending')});
}
export function parsePaperReadingDiscoveryPage(raw:unknown,rawScope:PaperReadingDiscoveryScope,query:PaperReadingDiscoveryQuery={}):PaperReadingDiscoveryPage{
    const scope=scopeValue(rawScope),expected=paperReadingDiscoveryQuery(scope,query);
    const value=studyObject(raw,['schemaVersion','scope','items','nextCursor']);
    if(value.schemaVersion!==1||!sameScope(scopeValue(value.scope),scope))throw Error('paper-reading-discovery-response-binding');
    if(!Array.isArray(value.items)||value.items.length>expected.limit)throw Error('paper-reading-discovery-response-limit');
    const items=value.items.map(parsePaperReadingDiscoverySummary);let previous=expected.afterUnitId;
    for(const item of items){
        if(previous!==null&&comparePaperReadingDiscoveryIds(previous,item.unitId)>=0)throw Error('paper-reading-discovery-cursor-binding');
        previous=item.unitId;
    }
    if(value.nextCursor!==null&&(!items.length||value.nextCursor!==paperReadingDiscoveryCursor(scope,items[items.length-1].unitId)))throw Error('paper-reading-discovery-cursor-binding');
    if(JSON.stringify(value).length>PAPER_READING_DISCOVERY_MAX_PAGE_CHARS)throw Error('paper-reading-discovery-response-limit');
    return {schemaVersion:1,scope,items,nextCursor:value.nextCursor as string|null};
}
