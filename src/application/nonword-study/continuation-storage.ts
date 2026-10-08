import type {AttemptBinding, AttemptMutation} from '../../domain/learning-attempt';
import type {AttemptRepository} from './session';
// @ts-expect-error TS5097: standalone contracts.
import {canonicalAttemptJson, attemptId} from '../../domain/learning-attempt/index.ts';

export type ContinuationGroup = {anchorAttemptId:string;sourceHash:string;runId:string;roundId:string};
export type ContinuationProof = {kind:'pending'|'formal';answerRevision:number;evaluationHash:string|null;
    coreHash:string|null;eventId:string|null;rating:'again'|'hard'|'good'|'easy'|null};
export type ContinuationNote = {schemaVersion:1;kind:'nonword-continuation';firstAttemptId:string;sequence:number;
    boundary:string;group:ContinuationGroup|null;proof:ContinuationProof|null};
export type ReopenProof = {boundary:string;operationId:string;fingerprint:string;sequences:number[]};
export type ReopenNote = {schemaVersion:1;kind:'nonword-reopen';group:ContinuationGroup;active:ReopenProof|null;staged:ReopenProof};
export type ContinuationOptions = {repository:AttemptRepository & {status?:(id:string)=>Promise<string|null>};
    fingerprint:(value:unknown)=>Promise<string>;now:()=>string;newId:()=>string};
export const sameContinuationValue=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
function closed(raw:unknown,keys:string[]):Record<string,unknown>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||keys.some(key=>!Object.hasOwn(raw,key)))throw Error('nonword-continuation-fields');
    return raw as Record<string,unknown>;
}
function digest(raw:unknown){if(typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(raw))throw Error('nonword-continuation-hash');return raw;}
function count(raw:unknown){if(!Number.isSafeInteger(raw)||Number(raw)<0)throw Error('nonword-continuation-sequence');return raw as number;}
export function parseContinuationGroup(raw:unknown):ContinuationGroup{
    const v=closed(raw,['anchorAttemptId','sourceHash','runId','roundId']);
    return {anchorAttemptId:attemptId(v.anchorAttemptId),sourceHash:digest(v.sourceHash),runId:attemptId(v.runId),roundId:digest(v.roundId)};
}
function boundary(raw:unknown):string{const id=attemptId(raw);if(id!=='initial'&&!id.startsWith('nw-reopen:'))throw Error('nonword-continuation-boundary');return id;}
function proof(raw:unknown):ContinuationProof{
    const v=closed(raw,['kind','answerRevision','evaluationHash','coreHash','eventId','rating']);
    if(!['pending','formal'].includes(String(v.kind)))throw Error('nonword-continuation-proof');
    const result={kind:v.kind as ContinuationProof['kind'],answerRevision:count(v.answerRevision),evaluationHash:v.evaluationHash===null?null:digest(v.evaluationHash),
        coreHash:v.coreHash===null?null:digest(v.coreHash),eventId:v.eventId===null?null:attemptId(v.eventId),rating:v.rating as ContinuationProof['rating']};
    if(result.kind==='formal'? !result.coreHash||!result.eventId||!result.evaluationHash||!['again','hard','good','easy'].includes(String(result.rating))
        :result.coreHash!==null||result.eventId!==null||result.rating!==null)throw Error('nonword-continuation-proof');
    return result;
}
export function parseContinuationNote(raw:unknown):ContinuationNote{
    const v=closed(raw,['schemaVersion','kind','firstAttemptId','sequence','boundary','group','proof']);
    if(v.schemaVersion!==1||v.kind!=='nonword-continuation')throw Error('nonword-continuation-version');
    const sequence=count(v.sequence),p=v.proof===null?null:proof(v.proof);
    if((sequence===0)!==(p===null))throw Error('nonword-continuation-proof');
    return {schemaVersion:1,kind:'nonword-continuation',firstAttemptId:attemptId(v.firstAttemptId),sequence,boundary:boundary(v.boundary),
        group:v.group===null?null:parseContinuationGroup(v.group),proof:p};
}
function reopenProof(raw:unknown):ReopenProof{
    const v=closed(raw,['boundary','operationId','fingerprint','sequences']);
    if(!Array.isArray(v.sequences)||v.sequences.length<1||v.sequences.length>500)throw Error('nonword-continuation-member-limit');
    const b=boundary(v.boundary);if(b==='initial')throw Error('nonword-continuation-boundary');
    return {boundary:b,operationId:attemptId(v.operationId),fingerprint:digest(v.fingerprint),sequences:v.sequences.map(count)};
}
export function parseReopenNote(raw:unknown):ReopenNote{
    const v=closed(raw,['schemaVersion','kind','group','active','staged']);
    if(v.schemaVersion!==1||v.kind!=='nonword-reopen')throw Error('nonword-continuation-version');
    return {schemaVersion:1,kind:'nonword-reopen',group:parseContinuationGroup(v.group),active:v.active===null?null:reopenProof(v.active),staged:reopenProof(v.staged)};
}
export function createContinuationStorage(options:ContinuationOptions){
    const groupKeys=(b:AttemptBinding)=>[b.ownerId,b.libraryId,b.groupId,b.roundId];
    const idFor=(kind:'continue'|'reopen',b:AttemptBinding)=>options.fingerprint(kind==='continue'?['nonword-continuation-v1',b]:['nonword-reopen-v1',...groupKeys(b)]).then(hash=>`nw-${kind}:${hash}`);
    async function read(kind:'continue'|'reopen',binding:AttemptBinding){
        const id=await idFor(kind,binding),row=await options.repository.read(id);if(!row)return null;
        if(await options.repository.status?.(id)==='cloud-conflict')throw Error('nonword-continuation-conflict');
        if(row.attemptId!==id||!sameContinuationValue(groupKeys(row.binding),groupKeys(binding))
            ||kind==='continue'&&!sameContinuationValue(row.binding,binding)||row.answer!==''||row.submitted||row.formal||row.parentAttemptId
            ||row.checkpoint.mode!=='lesson'||row.checkpoint.purpose!=='guided'||row.evaluation.status!=='pending'||row.evaluation.reason!=='not-requested')throw Error('nonword-continuation-binding');
        const notes=row.checkpoint.pluginFields?.notes;if(typeof notes!=='string'||notes.length>32000)throw Error('nonword-continuation-size');
        const raw:unknown=JSON.parse(notes);return {row,value:kind==='continue'?parseContinuationNote(raw):parseReopenNote(raw)};
    }
    async function write(kind:'continue'|'reopen',binding:AttemptBinding,value:ContinuationNote|ReopenNote,expectedRevision:number){
        const parsed=kind==='continue'?parseContinuationNote(value):parseReopenNote(value),notes=JSON.stringify(parsed);
        if(notes.length>32000)throw Error('nonword-continuation-size');
        const prior=await read(kind,binding),id=await idFor(kind,binding);
        if((prior?.row.revision??0)!==expectedRevision)throw Error('nonword-continuation-conflict');
        const mutation:AttemptMutation={schemaVersion:1,attemptId:id,binding:prior?.row.binding??binding,operationId:options.newId(),expectedRevision,
            updatedAt:options.now(),kind:'checkpoint',answer:'',parentAttemptId:null,
            checkpoint:{phase:'lesson',mode:'lesson',purpose:'guided',intent:'lesson',position:0,traversed:false,pluginFields:{notes}}};
        try{const receipt=await options.repository.mutate(mutation);if(!receipt.durable||receipt.status==='conflict'||!receipt.attempt)throw Error('nonword-continuation-save');}
        catch(error){const saved=await options.repository.read(id),hash=await options.fingerprint(mutation);if(!saved?.operations.some(op=>op.operationId===mutation.operationId&&op.fingerprint===hash))throw error;}
        const saved=await read(kind,binding);if(!saved||!sameContinuationValue(saved.value,parsed))throw Error('nonword-continuation-receipt');
        return saved;
    }
    return {idFor,read,write};
}
