import type {LongTermPlanState,LongTermPlanMutation,LongTermPlanMutationResult} from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalLongTermJson,parseLongTermPlanState,parseLongTermPlanMutation} from '../../domain/planning/index.ts';

export type LongTermPlanTransport={
  read:()=>Promise<LongTermPlanState>;
  write:(mutation:LongTermPlanMutation)=>Promise<LongTermPlanMutationResult>;
};
export type LongTermPlanView={scope:string;state:LongTermPlanState|null;loading:boolean;saving:boolean;error:string};
type WriteRequest={command:LongTermPlanMutation;promise?:Promise<LongTermPlanState>};
const failure=(error:unknown)=>error instanceof Error?error.message:'long-term-planning-unavailable';
const stale=()=>Error('long-term-source-changed');

/** One immutable owner/library binding. The UI owns when to create and retire it. */
export function createLongTermPlanSession(ports:{
  scope:string;transport:LongTermPlanTransport;newId:()=>string;publish:(view:LongTermPlanView)=>void;initialState?:LongTermPlanState|null;
}){
  const scope=ports.scope,transport={...ports.transport};
  let active=true,readEpoch=0,writes=0;
  let queue:Promise<unknown>=Promise.resolve();
  let view:LongTermPlanView={scope,state:ports.initialState?parseLongTermPlanState(ports.initialState):null,loading:false,saving:false,error:''};
  const requests=new Map<string,WriteRequest>();
  const snapshot=()=>structuredClone(view);
  const publish=(patch:Partial<LongTermPlanView>)=>{
    if(!active)return;
    view={...view,...patch};
    try{ports.publish(snapshot());}catch{/* Rendering does not undo an accepted write. */}
  };
  const accept=(raw:LongTermPlanState):LongTermPlanState=>{
    const next=parseLongTermPlanState(raw),current=view.state;
    if(current&&next.revision<current.revision)return current;
    if(current&&next.revision===current.revision&&canonicalLongTermJson(next)!==canonicalLongTermJson(current)){
      throw Error('long-term-revision-conflict');
    }
    return next;
  };
  return {
    snapshot,
    async refresh():Promise<LongTermPlanState>{
      if(!active)throw stale();
      const token=++readEpoch;
      publish({loading:true,error:''});
      try{
        const received=await transport.read();
        if(!active)throw stale();
        if(token!==readEpoch){if(view.state)return structuredClone(view.state);throw stale();}
        const state=accept(received);publish({state,loading:false,error:''});return structuredClone(state);
      }catch(error){if(active&&token===readEpoch)publish({loading:false,error:failure(error)});throw error;}
    },
    save(value:Omit<LongTermPlanMutation,'operationId'>):Promise<LongTermPlanState>{
      if(!active)return Promise.reject(stale());
      let key:string,request:WriteRequest;
      try{
        const input=structuredClone(value);key=canonicalLongTermJson([scope,input]);
        const found=requests.get(key);
        request=found??{command:parseLongTermPlanMutation({...input,operationId:ports.newId()})};
        if(request.promise)return request.promise;
        requests.set(key,request);
      }catch(error){return Promise.reject(error);}
      // Invalidate earlier reads before queuing a write. New reads still respect revision ordering.
      readEpoch++;writes++;publish({loading:false,saving:true,error:''});
      const operation=queue.then(async()=>{
        if(!active)throw stale();
        try{
          const result=await transport.write(structuredClone(request.command));
          if(!['accepted','duplicate','stale'].includes(result.status))throw Error('invalid-long-term-receipt');
          if(result.status!=='stale'&&result.state.revision<=request.command.expectedRevision)throw Error('invalid-long-term-receipt');
          if(!active){
            if(result.status==='stale')throw Error('long-term-stale');
            // Retirement revokes presentation, not a write already accepted by its original store.
            return parseLongTermPlanState(result.state);
          }
          const received=parseLongTermPlanState(result.state),state=accept(received);
          publish({state,error:result.status==='stale'?'long-term-stale':''});
          if(result.status==='stale')throw Error('long-term-stale');
          if(requests.get(key)===request)requests.delete(key);
          return structuredClone(received);
        }catch(error){if(active)publish({error:failure(error)});throw error;}
      });
      request.promise=operation.finally(()=>{
        writes--;request.promise=undefined;
        if(active)publish({saving:writes>0});
      });
      queue=request.promise.catch(()=>{});
      return request.promise;
    },
    dispose(){active=false;readEpoch++;requests.clear();},
  };
}
export type LongTermPlanSession=ReturnType<typeof createLongTermPlanSession>;
