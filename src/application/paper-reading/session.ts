// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingDerivedId} from './identity.ts';
import type {PaperReadingAiPort,PaperReadingStorePort,PaperReadingRemotePort} from './ports';
import type {PaperReadingUnitV1,PaperReadingWorkspaceV1,PaperReadingTaskV1,PaperReadingMutation} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingService} from './service.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export type PaperReadingSessionState={ready:boolean;saving:boolean;busy:boolean;workspace:PaperReadingWorkspaceV1|null;input:string;readonly unsavedInput?:string;error:string;notice:string;saveRecovery?:'retry'|'conflict'|'adopt'|null;cloud:'device-only'|'pending'|'acked'|'conflict'};
type PublicChange=PaperReadingMutation extends infer M?M extends PaperReadingMutation?Omit<M,'schemaVersion'|'unitId'|'operationId'|'expectedRevision'>:never:never;
export function createPaperReadingSession(options:{unit:PaperReadingUnitV1;store:PaperReadingStorePort;remote?:PaperReadingRemotePort;localAi?:PaperReadingAiPort;makeId:()=>string;now:()=>Date;isCurrent?:()=>boolean}){
    const unit=structuredClone(options.unit),scope={ownerId:unit.source.ownerId,libraryId:unit.source.libraryId};
    const service=createPaperReadingService({scope,store:{...options.store,writeService:(bound,mutation)=>{
        const write=queue.catch(()=>{}).then(async()=>{
            if(!current())throw Error('paper-reading-cancelled');
            const stored=await options.store.read(bound,mutation.unitId);
            if(!current())throw Error('paper-reading-cancelled');
            return options.store.writeService(bound,{...mutation,expectedRevision:stored?.revision??0});
        });
        queue=write.catch(()=>{});return write;
    }},ai:options.localAi});
    let state:PaperReadingSessionState={ready:false,saving:false,busy:false,workspace:null,input:'',error:'',notice:'',saveRecovery:null,cloud:options.remote?'pending':'device-only'};
    const listeners=new Set<()=>void>(),requests=new Set<AbortController>();
    let disposed=false,pendingWrites=0,queue:Promise<unknown>=Promise.resolve(),syncing:Promise<void>|null=null;
    let intentVersion=0,failedMutation:Readonly<PaperReadingMutation>|null=null,recoveryFlight:Promise<PaperReadingWorkspaceV1|undefined>|null=null;
    let confirmedSaved:PaperReadingWorkspaceV1|null=null;
    const current=()=>!disposed&&options.isCurrent?.()!==false;
    function emit(change:Partial<PaperReadingSessionState>){if(!current())return;state={...state,...change};listeners.forEach(listener=>listener());}
    function accept(workspace:PaperReadingWorkspaceV1,restoreInput=false){
        if(state.workspace&&workspace.revision<state.workspace.revision)return;
        const changed=workspace.activeAttemptId!==state.workspace?.activeAttemptId;
        emit({workspace,...(restoreInput||changed?{input:workspace.answer}:{}),ready:true});
    }
    function controller(){const c=new AbortController();requests.add(c);return c;}
    async function hydrate(workspace:PaperReadingWorkspaceV1,version:number=intentVersion){
        if(!current()||version!==intentVersion)return;
        if(!options.store.hydrate)throw Error('paper-reading-local-recovery-unavailable');
        const saved=await options.store.hydrate(scope,workspace);
        if(!current()||version!==intentVersion)return;
        accept(saved,!state.saving&&state.input===(state.workspace?.answer??''));
        emit({cloud:canonicalAttemptJson(saved)===canonicalAttemptJson(workspace)?'acked':'pending',notice:''});
    }
    function synchronize():Promise<void>{
        if(!options.remote||!current()||state.error)return Promise.resolve();
        if(syncing)return syncing;
        const c=controller();let version=intentVersion;
        const run=async()=>{
            await queue;if(!current()||state.error)return;
            version=intentVersion;
            const local=await service.read(unit.unitId);let remote=await options.remote!.read(unit.unitId,c.signal);
            if(!current()||version!==intentVersion)return;
            if(remote)await hydrate(remote,version);
            const workspace=await service.read(unit.unitId);
            const common=Math.min(remote?.operations.length??0,workspace.operations.length);
            for(let i=0;i<common;i++)if(canonicalAttemptJson(remote!.operations[i])!==canonicalAttemptJson(workspace.operations[i]))throw Error('paper-reading-cloud-conflict');
            for(const mutation of workspace.operations.slice(remote?.operations.length??0)){
                c.signal.throwIfAborted();if(!current()||version!==intentVersion)return;
                if(mutation.kind==='task'){
                    if(mutation.task.origin!=='prepared')throw Error('paper-reading-cloud-conflict');
                    remote=await options.remote!.begin(unit.unitId,mutation.operationId,c.signal,mutation.task);
                }else if(mutation.kind==='feedback')throw Error('paper-reading-cloud-conflict');
                else {
                    const receipt=await options.remote!.mutate(mutation,c.signal);
                    if(!receipt.durable||receipt.status==='conflict'||!receipt.workspace)throw Error('paper-reading-cloud-conflict');
                    remote=receipt.workspace;
                }
                await hydrate(remote,version);
            }
            if(remote)await hydrate(remote,version);
            else if(current()&&version===intentVersion)accept(local);
        };
        syncing=run().catch(error=>{
            if(c.signal.aborted||!current()||version!==intentVersion)return;
            const message=error instanceof Error?error.message:'paper-reading-cloud-unavailable';
            emit({cloud:/conflict/.test(message)?'conflict':'pending',notice:message});
        }).finally(()=>{requests.delete(c);syncing=null;});
        return syncing;
    }
    async function load(){
        const version=intentVersion;
        try{const saved=await service.open(unit);if(!current()||version!==intentVersion)return;accept(saved,true);emit({notice:'',error:''});void synchronize();}
        catch(error){emit({ready:true,notice:error instanceof Error?error.message:'paper-reading-load-unavailable'});}
    }
    async function persist(mutation:Readonly<PaperReadingMutation>,version:number){
        if(!current())return;
        try{
            const saved=await service.mutate(structuredClone(mutation));
            if(!current()||version!==intentVersion)return saved;
            accept(saved);
            const recovered=!failedMutation||failedMutation.operationId===mutation.operationId
                ||(mutation.kind==='draft'||mutation.kind==='submit')&&saved.answer===state.input;
            if(recovered)failedMutation=null;
            emit({cloud:options.remote?'pending':'device-only',...(recovered?{error:'',saveRecovery:null}:{})});
            return saved;
        }catch(error){
            if(current()&&version===intentVersion){
                failedMutation=mutation;
                const message=error instanceof Error?error.message:'paper-reading-save-unavailable';
                emit({error:message,saveRecovery:/conflict/.test(message)?'conflict':'retry'});
            }
            throw error;
        }
    }
    function change(value:PublicChange){
        if(!current())return Promise.resolve(undefined);
        confirmedSaved=null;
        const operationId=options.makeId(),version=++intentVersion;pendingWrites++;emit({saving:true,...(value.kind==='draft'||value.kind==='submit'?{error:''}:{})});
        const action=queue.catch(()=>{}).then(async()=>{
            if(!current())return;
            let stored:PaperReadingWorkspaceV1;
            try{stored=await service.read(unit.unitId);}
            catch(error){
                if(version===intentVersion)emit({error:error instanceof Error?error.message:'paper-reading-load-unavailable',saveRecovery:'conflict'});
                throw error;
            }
            const mutation=Object.freeze(structuredClone({...value,schemaVersion:1,operationId,unitId:unit.unitId,expectedRevision:stored.revision} as PaperReadingMutation));
            return persist(mutation,version);
        })
            .finally(()=>{pendingWrites--;emit({saving:pendingWrites>0});});
        queue=action;return action;
    }
    function retrySave(){
        if(!current())return Promise.resolve(undefined);
        if(recoveryFlight)return recoveryFlight;
        if(!failedMutation||state.saving||state.busy)return Promise.resolve(undefined);
        const mutation=failedMutation,version=++intentVersion;
        pendingWrites++;emit({saving:true});
        const action=queue.catch(()=>{}).then(()=>current()&&version===intentVersion?persist(mutation,version):undefined).finally(()=>{
            pendingWrites--;if(recoveryFlight===action)recoveryFlight=null;emit({saving:pendingWrites>0});
        });
        queue=action;recoveryFlight=action;return action;
    }
    function reloadSaved(){
        if(!current()||state.saving||state.busy||state.saveRecovery!=='conflict')return Promise.resolve();
        const version=++intentVersion;pendingWrites++;emit({saving:true});
        const action=queue.catch(()=>{}).then(async()=>{
            try{
                const saved=await service.read(unit.unitId);
                if(!current()||version!==intentVersion)return;
                const input=state.input,unsaved=input!==saved.answer;
                const submitted=Boolean(saved.attempts.find(attempt=>attempt.attemptId===saved.activeAttemptId)?.submission);
                // A deliberate reread abandons the conflicting intent, never changes its revision or resubmits it.
                confirmedSaved=unsaved&&submitted?structuredClone(saved):null;
                failedMutation=null;accept(saved);emit({input,error:unsaved?'paper-reading-unsaved-input-conflict':'',saveRecovery:confirmedSaved?'adopt':null,
                    notice:'paper-reading-saved-reloaded'});
            }catch(error){if(version===intentVersion)emit({error:error instanceof Error?error.message:'paper-reading-load-unavailable'});}
        }).finally(()=>{pendingWrites--;emit({saving:pendingWrites>0});});
        queue=action;return action;
    }
    function adoptSavedAnswer(){
        if(!current()||state.saving||state.busy||state.saveRecovery!=='adopt'||!confirmedSaved)return Promise.resolve();
        const confirmed=confirmedSaved,version=++intentVersion,input=state.input;
        pendingWrites++;emit({saving:true});
        const action=queue.catch(()=>{}).then(async()=>{
            if(!current()||version!==intentVersion)return;
            try{
                const latest=await service.read(unit.unitId);
                if(!current()||version!==intentVersion)return;
                if(canonicalAttemptJson(latest)!==canonicalAttemptJson(confirmed)){
                    confirmedSaved=null;emit({error:'paper-reading-save-conflict',saveRecovery:'conflict',notice:''});return;
                }
                const unsavedInput=state.unsavedInput&&state.unsavedInput!==input?state.unsavedInput+'\n\n'+input:input;
                confirmedSaved=null;accept(latest);emit({input:latest.answer,unsavedInput,error:'',saveRecovery:null,notice:'paper-reading-saved-adopted'});
            }catch(error){if(version===intentVersion)emit({error:error instanceof Error?error.message:'paper-reading-load-unavailable'});}
        }).finally(()=>{pendingWrites--;emit({saving:pendingWrites>0});});
        queue=action;return action;
    }
    async function flush(){await queue;if(state.error)throw Error(state.error);}
    async function answer(value:string){emit({input:value});return change({kind:'draft',answer:value,referenceSeen:state.workspace?.referenceSeen??false});}
    async function begin(prepared?:PaperReadingTaskV1){
        if(state.busy||state.saving||!state.ready)return;
        const c=controller(),version=intentVersion;emit({busy:true,notice:''});
        try{
            await flush();let current=await service.read(unit.unitId);
            if(current.task?.status==='ready')return;
            if(options.remote){
                await synchronize();if(state.cloud!=='acked')throw Error(state.notice||'paper-reading-cloud-unconfirmed');
                current=await service.read(unit.unitId);
                const saved=await options.remote.begin(unit.unitId,await paperReadingDerivedId('prepare:'+unit.unitId+':'+((current.task?.revision??0)+1)),c.signal,prepared);await hydrate(saved,version);
            }else {const saved=await service.begin(unit.unitId,await paperReadingDerivedId('prepare:'+unit.unitId+':'+((current.task?.revision??0)+1)),c.signal,prepared);if(version===intentVersion)accept(saved);}
        }catch(error){if(!c.signal.aborted&&version===intentVersion)emit({notice:error instanceof Error?error.message:'paper-reading-ai-unavailable'});}
        finally{requests.delete(c);emit({busy:false});}
    }
    async function evaluate(){
        if(state.busy||state.saving)return;
        if(!options.remote&&!options.localAi){emit({notice:'paper-reading-ai-unavailable'});return;}
        const c=controller(),version=intentVersion;emit({busy:true,notice:''});
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
                await hydrate(await options.remote.evaluate(unit.unitId,attempt.attemptId,await requestIdentity(current),c.signal),version);
            }else{
                if(!options.localAi)throw Error('paper-reading-ai-unavailable');
                const saved=await service.evaluate(unit.unitId,attempt.attemptId,await requestIdentity(current),c.signal);if(version===intentVersion)accept(saved);
            }
        }catch(error){if(!c.signal.aborted&&version===intentVersion)emit({notice:error instanceof Error?error.message:'paper-reading-ai-unavailable'});}
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
        await flush();const saved=await change({kind:'retry',attemptId:'paper-retry:'+options.makeId(),purpose:'remediation'});if(saved&&current())accept(saved,true);void synchronize();return saved;
    }
    return {snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},load,answer,submit,begin,evaluate,reveal,retry,retrySave,reloadSaved,adoptSavedAnswer,
        pause:async(paused:boolean,activeSeconds:number)=>{if(state.busy)throw Error('paper-reading-model-busy');return change({kind:'pause',paused,activeSeconds});},flush,synchronize,
        dispose:()=>{disposed=true;requests.forEach(c=>c.abort());listeners.clear();}};
}
export type PaperReadingSession=ReturnType<typeof createPaperReadingSession>;
