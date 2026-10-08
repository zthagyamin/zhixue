export type AttemptIdentity={readonly eventId:string;readonly reviewedAt:string};
export type AttemptBinding={scopeKey:string;itemBinding:string;mode:string};
export type StudyAttemptRequest={readonly identity:AttemptIdentity;capture:<T>(key:string,prepare:()=>T)=>T};
export type AttemptOutcome={status:'saved'|'failed'|'stale'|'blocked'|'conflict';identity?:AttemptIdentity;error?:unknown};
export type DurableActions={publish?:()=>void;continue?:()=>void|boolean};
export type SubmissionControls={durable:(actions?:DurableActions)=>boolean;committed:()=>boolean};
export type StudyAttemptSubmission={
    /** Reserved by the controlled non-word attempt service, never recomputed on retry. */
    identity?:StudyAttemptRequest['identity'];
    intent:string;current:()=>boolean;deferred?:boolean;
    /** Returning a value is never itself evidence of durability. */
    execute:(request:StudyAttemptRequest,control:SubmissionControls)=>unknown;
    onError?:(error:unknown,saved:boolean)=>void;
};
export type AttemptGate<Ticket>={begin:()=>Ticket|null;commit:(ticket:Ticket,resume?:()=>void|boolean)=>boolean;fail:(ticket:Ticket)=>boolean};
type Phase='idle'|'saving'|'failed'|'saved'|'continued'|'stale';

/** One content-bound, page-lifetime submission. Persistence and UI effects are injected. */
export function createStudyAttemptSession<Ticket>(ports:{binding:AttemptBinding;gate:AttemptGate<Ticket>;newId:()=>string;now:()=>string}){
    const binding=Object.freeze({...ports.binding});
    let phase:Phase='idle',generation=0,invalidated=false,revision=0;
    let request:StudyAttemptRequest|undefined,intent:string|undefined;
    let waiting:((outcome:AttemptOutcome)=>void)|undefined;
    const listeners=new Set<()=>void>();
    const setPhase=(next:Phase)=>{phase=next;revision++;for(const listener of [...listeners])try{listener();}catch{/* A view cannot invalidate durable evidence. */}};
    function makeRequest(reserved?:StudyAttemptRequest['identity']):StudyAttemptRequest{
        const identity=Object.freeze(reserved?{...reserved}:{eventId:ports.newId(),reviewedAt:ports.now()});
        if(!/^[A-Za-z0-9:._-]{1,160}$/.test(identity.eventId)||!Number.isFinite(Date.parse(identity.reviewedAt)))throw Error('study-attempt-invalid-identity');
        const captured=new Map<string,unknown>();
        return Object.freeze({identity,capture<T>(key:string,prepare:()=>T):T{
            if(!key||key.length>120)throw Error('study-attempt-invalid-capture');
            if(!captured.has(key))captured.set(key,structuredClone(prepare()));
            return structuredClone(captured.get(key)) as T;
        }});
    }
    return {
        binding,
        snapshot:()=>({phase,identity:request?.identity}),
        subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
        getSnapshot:()=>revision,
        submit(options:StudyAttemptSubmission):Promise<AttemptOutcome>{
            if(invalidated||!options.current())return Promise.resolve({status:'stale',identity:request?.identity});
            if(request&&options.identity&&(request.identity.eventId!==options.identity.eventId||request.identity.reviewedAt!==options.identity.reviewedAt)){
                const error=Error('study-attempt-identity-conflict');
                options.onError?.(error,false);
                return Promise.resolve({status:'conflict',identity:request.identity,error});
            }
            if(['saving','saved','continued'].includes(phase))return Promise.resolve({status:'blocked',identity:request?.identity});
            if(intent!==undefined&&intent!==options.intent){
                const error=Error('study-attempt-retry-conflict');
                try{options.onError?.(error,false);}catch{/* Reporting is not a persistence operation. */}
                return Promise.resolve({status:'conflict',identity:request?.identity,error});
            }
            const ticket=ports.gate.begin();
            if(ticket===null)return Promise.resolve({status:'blocked',identity:request?.identity});
            const run=++generation;let durable=false,applied=false,settled=false;
            let resolveOwn!:(outcome:AttemptOutcome)=>void;
            const result=new Promise<AttemptOutcome>(resolve=>{resolveOwn=resolve;waiting=resolve;});
            const active=()=>!invalidated&&run===generation;
            const settle=(outcome:AttemptOutcome)=>{if(settled)return;settled=true;if(waiting===resolveOwn)waiting=undefined;resolveOwn(outcome);};
            const report=(error:unknown)=>{
                if(!active())return;
                if(!durable){ports.gate.fail(ticket);setPhase('failed');}
                if(options.current())try{options.onError?.(error,durable);}catch{/* Preserve the actual save outcome. */}
                settle({status:!options.current()?'stale':durable?'saved':'failed',identity:request?.identity,error});
            };
            setPhase('saving');
            try{
                request??=makeRequest(options.identity);intent=options.intent;
                const control:SubmissionControls={
                    committed:()=>applied&&active(),
                    durable(actions={}){
                        if(!active()||durable)return false;
                        durable=true;
                        const resume=options.deferred?()=>{
                            if(!active()||phase!=='saved'||!options.current())return false;
                            setPhase('continued');
                            try{return actions.continue?.()!==false;}catch(error){report(error);return false;}
                        }:undefined;
                        applied=ports.gate.commit(ticket,resume);
                        if(!active())return false;
                        const present=applied&&options.current();
                        setPhase(present?'saved':'stale');
                        if(!active())return false;
                        try{if(present)actions.publish?.();}
                        finally{settle({status:present?'saved':'stale',identity:request!.identity});}
                        return applied&&active();
                    },
                };
                Promise.resolve(options.execute(request,control)).then(()=>{
                    if(active()&&!durable)report(Error('study-attempt-local-durability-unconfirmed'));
                },report);
            }catch(error){report(error);}
            return result;
        },
        /** Retire presentation eligibility. The host owns clearing its lock and buffers. */
        invalidate(){
            if(invalidated)return;invalidated=true;generation++;setPhase('stale');
            const resolve=waiting;waiting=undefined;resolve?.({status:'stale',identity:request?.identity});listeners.clear();
        },
    };
}
export type StudyAttemptSession<Ticket>=ReturnType<typeof createStudyAttemptSession<Ticket>>;
