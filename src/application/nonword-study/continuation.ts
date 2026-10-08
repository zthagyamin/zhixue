import type {AttemptBinding, LearningAttempt} from '../../domain/learning-attempt';
import type {NonWordRoundState} from './round-session';
// @ts-expect-error TS5097: standalone contracts.
import {createContinuationStorage, sameContinuationValue, type ContinuationOptions, type ContinuationGroup, type ContinuationNote, type ContinuationProof, type ReopenNote, type ReopenProof} from './continuation-storage.ts';
export type {ContinuationGroup} from './continuation-storage';

export function continuationProof(first:LearningAttempt):ContinuationProof{
    if(first.parentAttemptId||first.checkpoint.purpose!=='first'||!['recall','quiz','code','calculation','flashcard'].includes(first.checkpoint.mode??'')
        ||!first.submitted||!first.checkpoint.traversed)throw Error('nonword-continuation-first-required');
    if(first.formal?.status==='linked'){
        if(first.evaluation.status!=='resolved'||first.formal.evaluationHash!==first.evaluation.evaluationHash)throw Error('nonword-continuation-formal-proof');
        return {kind:'formal',answerRevision:first.submitted.answerRevision,evaluationHash:first.evaluation.evaluationHash,
            coreHash:first.formal.coreHash,eventId:first.formal.eventId,rating:first.formal.rating};
    }
    return {kind:'pending',answerRevision:first.submitted.answerRevision,evaluationHash:first.evaluation.status==='resolved'?first.evaluation.evaluationHash:null,
        coreHash:null,eventId:null,rating:null};
}
export function createContinuationCoordinator(options:ContinuationOptions){
    const storage=createContinuationStorage(options),same=sameContinuationValue;
    async function anchor(binding:AttemptBinding,group:ContinuationGroup){
        const row=await options.repository.read(group.anchorAttemptId);
        if(!row||row.binding.ownerId!==binding.ownerId||row.binding.libraryId!==binding.libraryId||row.checkpoint.mode!=='lesson'
            ||row.checkpoint.purpose!=='guided'||row.answer!==''||row.submitted||row.formal||row.parentAttemptId)throw Error('nonword-continuation-anchor');
        if(await options.repository.status?.(row.attemptId)==='cloud-conflict')throw Error('nonword-continuation-conflict');
        const value=JSON.parse(row.checkpoint.pluginFields?.notes??'null') as {schemaVersion?:unknown;sourceHash?:unknown;runId?:unknown};
        if(value?.schemaVersion!==1||value.sourceHash!==group.sourceHash||value.runId!==group.runId
            ||await options.fingerprint([row.binding.roundId,group.runId])!==group.roundId
            ||await options.fingerprint(group.roundId)!==binding.roundId)throw Error('nonword-continuation-run');
        return row;
    }
    function acknowledged(row:LearningAttempt,ack:ReopenProof|null){return Boolean(ack&&row.operations.some(op=>op.operationId===ack.operationId&&op.fingerprint===ack.fingerprint));}
    async function effective(binding:AttemptBinding,known?:ContinuationGroup|null){
        const stored=await storage.read('reopen',binding),note=stored?.value as ReopenNote|undefined,group=known??note?.group;
        if(!group)return {boundary:'initial',ack:null,row:null,group:null,ackRevision:stored?.row.revision??0};
        if(note&&!same(note.group,group))throw Error('nonword-continuation-group');
        const row=await anchor(binding,group),marker=row.checkpoint.view?.instanceId;
        const staged=note?.staged??null,active=note?.active??null;
        const latest=row.operations.filter(op=>op.operationId.startsWith('nw-reopen:')).sort((a,b)=>b.revision-a.revision)[0];
        const matchesLatest=(value:ReopenProof|null)=>acknowledged(row,value)&&(!latest||value?.operationId===latest.operationId&&value.fingerprint===latest.fingerprint);
        const ack=matchesLatest(staged)?staged:matchesLatest(active)?active:null;
        if(latest&&!ack)throw Error('nonword-continuation-ack-unavailable');
        if(marker?.startsWith('nw-reopen:')&&marker!==ack?.boundary)throw Error('nonword-continuation-ack-unavailable');
        // A legacy cursor write may drop view; a proved ACK still owns the boundary.
        return {boundary:ack?.boundary??'initial',ack,row,group,ackRevision:stored?.row.revision??0};
    }
    async function associate(first:LearningAttempt,group?:ContinuationGroup){
        const saved=await storage.read('continue',first.binding),note=saved?.value as ContinuationNote|undefined;
        if(note&&note.firstAttemptId!==first.attemptId)throw Error('nonword-continuation-first-conflict');
        if(group){await anchor(first.binding,group);if(note?.group&&!same(note.group,group))throw Error('nonword-continuation-group');}
        const selected=group??note?.group??null;
        const current=await effective(first.binding,selected);
        if(group&&!note?.group)await storage.write('continue',first.binding,note?{...note,group}:{schemaVersion:1,kind:'nonword-continuation',firstAttemptId:first.attemptId,
            sequence:0,boundary:current.boundary,group,proof:null},saved?.row.revision??0);
        return current.boundary;
    }
    async function append(first:LearningAttempt,frozen:string){
        const saved=await storage.read('continue',first.binding),prior=saved?.value as ContinuationNote|undefined;
        if(prior&&prior.firstAttemptId!==first.attemptId)throw Error('nonword-continuation-first-conflict');
        const current=await effective(first.binding,prior?.group);
        if(current.boundary!==frozen)throw Error('续学位置已变化，原答案保留，请重新打开原作答。');
        const latest=await options.repository.read(first.attemptId);
        if(!latest||!same(latest.binding,first.binding)||!same(latest.submitted,first.submitted))throw Error('nonword-continuation-first-binding');
        const proof=continuationProof(latest);
        if(prior&&prior.boundary===frozen&&same(prior.proof,proof))return prior;
        const value:ContinuationNote={schemaVersion:1,kind:'nonword-continuation',firstAttemptId:first.attemptId,sequence:(prior?.sequence??0)+1,
            boundary:frozen,group:prior?.group??current.group,proof};
        const receipt=(await storage.write('continue',first.binding,value,saved?.row.revision??0)).value as ContinuationNote;
        if((await effective(first.binding,receipt.group)).boundary!==frozen)throw Error('nonword-continuation-boundary-changed');
        return receipt;
    }
    async function project(state:NonWordRoundState,base:AttemptBinding){
        const current=await effective(base,{anchorAttemptId:state.anchorAttemptId,sourceHash:state.sourceHash,runId:state.runId,roundId:state.roundId});
        if(current.ack&&current.ack.sequences.length!==state.members.length)throw Error('nonword-continuation-member-limit');
        const traversal=structuredClone(state.traversal);let changed=false;
        for(const [index,member] of state.members.entries()){
            if(traversal.skippedKeys.includes(member.itemKey))continue;
            const binding={...base,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash};
            const saved=await storage.read('continue',binding),note=saved?.value as ContinuationNote|undefined;
            if(!note?.proof||note.sequence<=(current.ack?.sequences[index]??0)||note.boundary!==current.boundary)continue;
            const first=await options.repository.read(note.firstAttemptId);
            if(!first||!same(first.binding,binding)||first.checkpoint.mode!==member.mode||first.parentAttemptId||first.checkpoint.purpose!=='first'
                ||!first.submitted||!first.checkpoint.traversed||first.submitted.answerRevision!==note.proof.answerRevision)continue;
            if(note.group&&!same(note.group,current.group))throw Error('nonword-continuation-group');
            if(note.proof.kind==='formal'&&!same(continuationProof(first),note.proof))throw Error('nonword-continuation-formal-proof');
            const target=note.proof.kind==='pending'?'awaitingReviewKeys': ['good','easy'].includes(note.proof.rating!)?'correctKeys':'wrongKeys';
            if(traversal[target].includes(member.itemKey))continue;
            for(const key of Object.keys(traversal) as (keyof typeof traversal)[])traversal[key]=traversal[key].filter(id=>id!==member.itemKey);
            traversal[target].push(member.itemKey);changed=true;
        }
        if(!changed)return state;
        const settled=new Set(Object.values(traversal).flat());
        return {...state,traversal,currentItemKey:state.currentItemKey&&!settled.has(state.currentItemKey)?state.currentItemKey:state.members.find(member=>!settled.has(member.itemKey))?.itemKey??null};
    }
    async function stageReopen(state:NonWordRoundState,base:AttemptBinding,operation:{operationId:string;fingerprint:string;boundary:string}){
        const current=await effective(base,{anchorAttemptId:state.anchorAttemptId,sourceHash:state.sourceHash,runId:state.runId,roundId:state.roundId});
        const sequences=await Promise.all(state.members.map(async member=>{
            const stored=await storage.read('continue',{...base,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash});
            return (stored?.value as ContinuationNote|undefined)?.sequence??0;
        }));
        const note:ReopenNote={schemaVersion:1,kind:'nonword-reopen',group:current.group!,active:current.ack,
            staged:{...operation,sequences}};
        await storage.write('reopen',base,note,current.ackRevision);
    }
    async function assertBoundary(binding:AttemptBinding,frozen:string,group?:ContinuationGroup){
        if((await effective(binding,group)).boundary!==frozen)throw Error('nonword-continuation-boundary-changed');
    }
    async function hydrateRound(state:NonWordRoundState,base:AttemptBinding,remote:{read:(id:string)=>Promise<LearningAttempt|null>},hydrate:(row:LearningAttempt)=>Promise<unknown>){
        const read=async(kind:'continue'|'reopen',binding:AttemptBinding)=>{
            const id=await storage.idFor(kind,binding),value=await remote.read(id);if(!value)return null;
            if(value.attemptId!==id||value.binding.ownerId!==binding.ownerId||value.binding.libraryId!==binding.libraryId
                ||value.binding.groupId!==binding.groupId||value.binding.roundId!==binding.roundId
                ||kind==='continue'&&!same(value.binding,binding))throw Error('nonword-continuation-binding');
            await hydrate(value);return storage.read(kind,binding);
        };
        await read('reopen',base);
        // Bounded batches, exact identities; global lists cannot prove complete recovery.
        for(let offset=0;offset<state.members.length;offset+=8)await Promise.all(state.members.slice(offset,offset+8).map(async member=>{
            const binding={...base,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash};
            const saved=await read('continue',binding),note=saved?.value as ContinuationNote|undefined;
            if(!note?.proof)return;
            const first=await remote.read(note.firstAttemptId);if(!first)return;
            if(first.attemptId!==note.firstAttemptId||!same(first.binding,binding)||first.parentAttemptId||first.checkpoint.purpose!=='first')throw Error('nonword-continuation-first-binding');
            await hydrate(first);
        }));
    }
    return {associate,append,project,stageReopen,storage,assertBoundary,hydrateRound};
}
