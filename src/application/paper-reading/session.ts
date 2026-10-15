// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingDerivedId} from './identity.ts';
import type {PaperReadingAiPort,PaperReadingStorePort,PaperReadingRemotePort} from './ports';
import type {PaperReadingUnitV1,PaperReadingWorkspaceV1,PaperReadingTaskV1,PaperReadingMutation} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingService} from './service.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export type PaperReadingSessionState={ready:boolean;saving:boolean;busy:boolean;workspace:PaperReadingWorkspaceV1|null;input:string;error:string;notice:string;cloud:'device-only'|'pending'|'acked'|'conflict'};
type PublicChange=PaperReadingMutation extends infer M?M extends PaperReadingMutation?Omit<M,'schemaVersion'|'unitId'|'operationId'|'expectedRevision'>:never:never;
export function createPaperReadingSession(options:{unit:PaperReadingUnitV1;store:PaperReadingStorePort;remote?:PaperReadingRemotePort;localAi?:PaperReadingAiPort;makeId:()=>string;now:()=>Date}){
    const unit=structuredClone(options.unit),scope={ownerId:unit.source.ownerId,libraryId:unit.source.libraryId};
    const service=createPaperReadingService({scope,store:{...options.store,writeService:(bound,mutation)=>{
        const write=queue.catch(()=>{}).then(async()=>{
            const current=await options.store.read(bound,mutation.unitId);
            return options.store.writeService(bound,{...mutation,expectedRevision:current?.revision??0});
        });
        queue=write.catch(()=>{});return write;
    }},ai:options.localAi});
    let state:PaperReadingSessionState={ready:false,saving:false,busy:false,workspace:null,input:'',error:'',notice:'',cloud:options.remote?'pending':'device-only'};
    const listeners=new Set<()=>void>(),requests=new Set<AbortController>();
    let disposed=false,pendingWrites=0,queue:Promise<unknown>=Promise.resolve(),syncing:Promise<void>|null=null;
    function emit(change:Partial<PaperReadingSessionState>){if(disposed)return;state={...state,...change};listeners.forEach(listener=>listener());}
    function accept(workspace:PaperReadingWorkspaceV1,restoreInput=false){
        const changed=workspace.activeAttemptId!==state.workspace?.activeAttemptId;
        emit({workspace,...(restoreInput||changed?{input:workspace.answer}:{}),ready:true});
    }
    function controller(){const c=new AbortController();requests.add(c);return c;}
    async function hydrate(workspace:PaperReadingWorkspaceV1){
        if(!options.store.hydrate)throw Error('paper-reading-local-recovery-unavailable');
        const saved=await options.store.hydrate(scope,workspace);
        accept(saved,!state.saving&&state.input===(state.workspace?.answer??''));
        emit({cloud:canonicalAttemptJson(saved)===canonicalAttemptJson(workspace)?'acked':'pending',notice:''});
    }
    function synchronize():Promise<void>{
        if(!options.remote||disposed)return Promise.resolve();
        if(syncing)return syncing;
        const c=controller();
        const run=async()=>{
            await queue;if(disposed)return;
            const local=await service.read(unit.unitId);let remote=await options.remote!.read(unit.unitId,c.signal);
            if(remote)await hydrate(remote);
            const current=await service.read(unit.unitId);
            const common=Math.min(remote?.operations.length??0,current.operations.length);
            for(let i=0;i<common;i++)if(canonicalAttemptJson(remote!.operations[i])!==canonicalAttemptJson(current.operations[i]))throw Error('paper-reading-cloud-conflict');
            for(const mutation of current.operations.slice(remote?.operations.length??0)){
                c.signal.throwIfAborted();
                if(mutation.kind==='task'){
                    if(mutation.task.origin!=='prepared')throw Error('paper-reading-cloud-conflict');
                    remote=await options.remote!.begin(unit.unitId,mutation.operationId,c.signal,mutation.task);
                }else if(mutation.kind==='feedback')throw Error('paper-reading-cloud-conflict');
                else {
                    const receipt=await options.remote!.mutate(mutation,c.signal);
                    if(!receipt.durable||receipt.status==='conflict'||!receipt.workspace)throw Error('paper-reading-cloud-conflict');
                    remote=receipt.workspace;
                }
                await hydrate(remote);
            }
            if(remote)await hydrate(remote);
            else accept(local);
        };
        syncing=run().catch(error=>{
            if(c.signal.aborted||disposed)return;
            const message=error instanceof Error?error.message:'paper-reading-cloud-unavailable';
            emit({cloud:/conflict/.test(message)?'conflict':'pending',notice:message});
        }).finally(()=>{requests.delete(c);syncing=null;});
        return syncing;
    }
    async function load(){
        try{accept(await service.open(unit),true);emit({notice:'',error:''});void synchronize();}
        catch(error){emit({ready:true,notice:error instanceof Error?error.message:'paper-reading-load-unavailable'});}
    }
    function change(value:PublicChange){
        const operationId=options.makeId();pendingWrites++;emit({saving:true,...(value.kind==='draft'||value.kind==='submit'?{error:''}:{})});
        const action=queue.catch(()=>{}).then(async()=>{
            const current=await service.read(unit.unitId);
            const mutation={...value,schemaVersion:1,operationId,unitId:unit.unitId,expectedRevision:current.revision} as PaperReadingMutation;
            const saved=await service.mutate(mutation);accept(saved);
            emit({cloud:options.remote?'pending':'device-only',...(saved.answer===state.input?{error:''}:{})});return saved;
        }).catch(error=>{emit({error:error instanceof Error?error.message:'paper-reading-save-unavailable'});throw error;})
            .finally(()=>{pendingWrites--;emit({saving:pendingWrites>0});});
        queue=action;return action;
    }
    async function flush(){await queue;if(state.error)throw Error(state.error);}
    async function answer(value:string){emit({input:value});return change({kind:'draft',answer:value,referenceSeen:state.workspace?.referenceSeen??false});}
    async function begin(prepared?:PaperReadingTaskV1){
        if(state.busy||state.saving||!state.ready)return;
        const c=controller();emit({busy:true,notice:''});
        try{
            await flush();let current=await service.read(unit.unitId);
            if(current.task?.status==='ready')return;
            if(options.remote){
                await synchronize();if(state.cloud!=='acked')throw Error(state.notice||'paper-reading-cloud-unconfirmed');
                current=await service.read(unit.unitId);
                const saved=await options.remote.begin(unit.unitId,await paperReadingDerivedId('prepare:'+unit.unitId+':'+((current.task?.revision??0)+1)),c.signal,prepared);await hydrate(saved);
            }else accept(await service.begin(unit.unitId,await paperReadingDerivedId('prepare:'+unit.unitId+':'+((current.task?.revision??0)+1)),c.signal,prepared));
        }catch(error){if(!c.signal.aborted)emit({notice:error instanceof Error?error.message:'paper-reading-ai-unavailable'});}
        finally{requests.delete(c);emit({busy:false});}
    }
    async function evaluate(){
        if(state.busy||state.saving)return;
        if(!options.remote&&!options.localAi){emit({notice:'paper-reading-ai-unavailable'});return;}
        const c=controller();emit({busy:true,notice:''});
        try{
            await flush();let current=await service.read(unit.unitId);
            const attempt=current.attempts.find(a=>a.attemptId===current.activeAttemptId);
            if(!attempt?.submission)return;
            const requestIdentity=async(workspace:PaperReadingWorkspaceV1)=>{
                const confirmedPending=workspace.operations.filter(op=>op.kind==='feedback'&&op.attemptId===attempt.attemptId
                    &&op.answerRevision===attempt.answerRevision&&op.taskRevision===attempt.task.revision&&op.evaluation.status==='pending').length;
                return paperReadingDerivedId('evaluate:'+attempt.attemptId+':'+attempt.task.revision+':'+attempt.answerRevision+':'+confirmedPending);
            };
            if(options.remote){
                await synchronize();if(state.cloud!=='acked')throw Error(state.notice||'paper-reading-cloud-unconfirmed');
                current=await service.read(unit.unitId);
                await hydrate(await options.remote.evaluate(unit.unitId,attempt.attemptId,await requestIdentity(current),c.signal));
            }else{
                if(!options.localAi)throw Error('paper-reading-ai-unavailable');
                accept(await service.evaluate(unit.unitId,attempt.attemptId,await requestIdentity(current),c.signal));
            }
        }catch(error){if(!c.signal.aborted)emit({notice:error instanceof Error?error.message:'paper-reading-ai-unavailable'});}
        finally{requests.delete(c);emit({busy:false});}
    }
    async function submit(){
        if(state.saving)await flush();
        if(!state.input.trim())throw Error('paper-reading-empty-answer');
        const saved=await change({kind:'submit',answer:state.input,referenceSeen:state.workspace?.referenceSeen??false,submittedAt:options.now().toISOString()});
        void evaluate();return saved;
    }
    async function reveal(){if(state.busy)throw Error('paper-reading-model-busy');return change({kind:'reference'});}
    async function retry(){
        if(state.busy)throw Error('paper-reading-model-busy');
        await flush();const saved=await change({kind:'retry',attemptId:'paper-retry:'+options.makeId(),purpose:'remediation'});accept(saved,true);void synchronize();return saved;
    }
    return {snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},load,answer,submit,begin,evaluate,reveal,retry,
        pause:async(paused:boolean,activeSeconds:number)=>{if(state.busy)throw Error('paper-reading-model-busy');return change({kind:'pause',paused,activeSeconds});},flush,synchronize,
        dispose:()=>{disposed=true;requests.forEach(c=>c.abort());listeners.clear();}};
}
export type PaperReadingSession=ReturnType<typeof createPaperReadingSession>;
