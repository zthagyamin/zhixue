// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingDerivedId} from './identity.ts';
import type {PaperReadingAiPort,PaperReadingStorePort,PaperReadingScope,PaperReadingReceipt} from './ports';
import type {PaperReadingUnitV1,PaperReadingWorkspaceV1,PaperReadingTaskV1,PaperReadingMutation,PaperReadingEvaluation} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingUnit,paperReadingTask,parsePaperReadingWorkspace} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
const equal=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
/** Owns models and durable receipts. The view receives intents, never this store or a grading port. */
export function createPaperReadingService(options:{scope:PaperReadingScope;store:PaperReadingStorePort;ai?:PaperReadingAiPort}){
    const scope=structuredClone(options.scope),flights=new Map<string,Promise<PaperReadingWorkspaceV1>>();
    async function read(unitId:string){
        const workspace=await options.store.read(scope,unitId);
        if(!workspace)throw Error('paper-unit-not-registered');
        return workspace;
    }
    function received(receipt:PaperReadingReceipt){
        if(!receipt.durable||receipt.status==='conflict'||!receipt.workspace)throw Error('paper-reading-save-conflict');
        return parsePaperReadingWorkspace(receipt.workspace);
    }
    async function mutate(mutation:PaperReadingMutation){return received(await options.store.mutate(scope,mutation));}
    async function open(raw:PaperReadingUnitV1){
        const unit=paperReadingUnit(raw);
        if(unit.source.ownerId!==scope.ownerId||unit.source.libraryId!==scope.libraryId)throw Error('paper-reading-source-scope');
        const existing=await options.store.read(scope,unit.unitId);
        if(existing){if(!equal(existing.unit,unit))throw Error('paper-unit-source-conflict');return existing;}
        return mutate({schemaVersion:1,operationId:await paperReadingDerivedId('register:'+unit.unitId),unitId:unit.unitId,expectedRevision:0,kind:'register',unit});
    }
    function exclusive(key:string,run:()=>Promise<PaperReadingWorkspaceV1>){
        const existing=flights.get(key);if(existing)return existing;
        const operation=run().finally(()=>{if(flights.get(key)===operation)flights.delete(key);});
        flights.set(key,operation);return operation;
    }
    function begin(unitId:string,requestId:string,signal:AbortSignal,prepared?:PaperReadingTaskV1){
        return exclusive('prepare:'+unitId,async()=>{
            signal.throwIfAborted();const before=await read(unitId);
            if(before.task?.status==='ready')return before;
            let task:PaperReadingTaskV1|null=null;
            if(prepared){
                const validated=paperReadingTask(prepared);
                if(validated.origin==='prepared'&&validated.status==='ready')task=validated;
            }
            if(!task){if(!options.ai)throw Error('paper-reading-ai-unavailable');task=await options.ai.prepare(before.unit,requestId,signal);}
            signal.throwIfAborted();if(!task)throw Error('paper-reading-ai-unavailable');
            task=paperReadingTask(task);
            task={...task,revision:(before.task?.revision??0)+1};
            if(!equal(task.source,before.unit.source)||task.goal!==before.unit.goal)throw Error('paper-task-binding');
            const current=await read(unitId);signal.throwIfAborted();
            if(current.task?.status==='ready')return current;
            if(!equal(current.unit,before.unit))throw Error('paper-unit-source-conflict');
            return received(await options.store.writeService(scope,{schemaVersion:1,operationId:requestId,unitId,
                expectedRevision:current.revision,kind:'task',task}));
        });
    }
    function evaluate(unitId:string,attemptId:string,requestId:string,signal:AbortSignal){
        return exclusive('evaluate:'+unitId+':'+attemptId,async()=>{
            signal.throwIfAborted();const before=await read(unitId),attempt=before.attempts.find(a=>a.attemptId===attemptId);
            if(!attempt?.submission)throw Error('paper-answer-not-saved');
            if(attempt.evaluation.status==='resolved')return before;
            const prior=before.operations.find(operation=>operation.operationId===requestId);
            if(prior){
                if(prior.kind!=='feedback'||prior.attemptId!==attemptId||prior.answerRevision!==attempt.answerRevision||prior.taskRevision!==attempt.task.revision)throw Error('paper-operation-conflict');
                return before;
            }
            let evaluation:PaperReadingEvaluation;
            try{
                evaluation=options.ai?await options.ai.evaluate(attempt.task,attempt.submission.answer,requestId,signal):{status:'pending',reason:'offline'};
            }catch(error){
                signal.throwIfAborted();
                if(error instanceof Error&&/^paper-ai-(?:receipt-unknown|request-pending|receipt-binding|result-binding)$/.test(error.message))throw error;
                evaluation={status:'pending',reason:'offline'};
            }
            signal.throwIfAborted();const current=await read(unitId),latest=current.attempts.find(a=>a.attemptId===attemptId);
            if(!latest?.submission||latest.answerRevision!==attempt.answerRevision||!equal(latest.task,attempt.task)
                ||!equal(latest.submission,attempt.submission))throw Error('paper-feedback-binding');
            if(latest.evaluation.status==='resolved')return current;
            return received(await options.store.writeService(scope,{schemaVersion:1,operationId:requestId,unitId,expectedRevision:current.revision,
                kind:'feedback',attemptId,answerRevision:attempt.answerRevision,taskRevision:attempt.task.revision,evaluation}));
        });
    }
    return {open,read,mutate,begin,evaluate};
}
export type PaperReadingService=ReturnType<typeof createPaperReadingService>;
