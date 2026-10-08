export type DailyRevision={day:string;revision:number};
export type DailyPlanView<State,Source>={scope:string;day:string;state:State|null;source:Source|null;ready:boolean;loading:boolean;error:string|null};
export type DailyPlanPorts<State extends DailyRevision,Source>={
  read:()=>Promise<State>;
  project:(state:State)=>Promise<Source|null>;
  prepare?:(state:State,goalRevision:number,isCurrent:()=>boolean)=>Promise<State>;
  canPrepare?:()=>boolean;
};
export class PlanningReadCancelledError extends Error{
  constructor(){super('planning-scope-changed');this.name='PlanningReadCancelledError';}
}
export const isPlanningReadCancelled=(error:unknown):boolean=>error instanceof PlanningReadCancelledError;
const retired=()=>new PlanningReadCancelledError();
const alwaysCurrent=()=>true;

/** Scope captures the owner/library/day; the supplied ports capture the corresponding source version. */
export function createDailyPlanSession<State extends DailyRevision,Source>(ports:DailyPlanPorts<State,Source>&{
  scope:string;day:string;publish:(view:DailyPlanView<State,Source>)=>void;initialState?:State|null;initialView?:DailyPlanView<State,Source>|null;
}){
  let active=true,epoch=0;
  const previous=ports.initialView?.scope===ports.scope&&ports.initialView.day===ports.day?ports.initialView:null;
  const initial=previous?.state??(ports.initialState?.day===ports.day?ports.initialState:null);
  let view:DailyPlanView<State,Source>={scope:ports.scope,day:ports.day,state:initial,source:previous?.source??null,ready:previous?.ready??false,loading:false,error:null};
  let preparing:{revision:number;epoch:number;promise:Promise<State>;boundary:()=>boolean;allowed:()=>boolean}|null=null;
  const snapshot=()=>structuredClone(view);
  const publish=(patch:Partial<DailyPlanView<State,Source>>)=>{
    if(!active)return;view={...view,...patch};
    try{ports.publish(snapshot());}catch{/* An observer cannot replace a verified plan. */}
  };
  return {
    snapshot,
    refresh(goalRevision?:number,boundary=alwaysCurrent):Promise<State>{
      if(!active)return Promise.reject(retired());
      if(goalRevision!==undefined&&(!Number.isSafeInteger(goalRevision)||goalRevision<0))return Promise.reject(Error('invalid-long-term-revision'));
      if(preparing?.epoch===epoch&&preparing.allowed()&&(goalRevision===undefined||preparing.revision===goalRevision&&preparing.boundary===boundary))return preparing.promise;
      const token=++epoch,current=()=>active&&token===epoch;
      const canPrepare=()=>current()&&boundary()&&(ports.canPrepare?.()??true);
      publish({loading:true,error:null});
      const operation=(async()=>{
        try{
          let state=await ports.read();
          if(!current())throw retired();
          if(state.day!==ports.day||!Number.isSafeInteger(state.revision)||state.revision<0)throw Error('daily-plan-scope-mismatch');
          if(goalRevision!==undefined&&canPrepare()){
            if(!ports.prepare)throw Error('daily-plan-prepare-unavailable');
            state=await ports.prepare(structuredClone(state),goalRevision,canPrepare);
          }
          if(!current())throw retired();
          if(state.day!==ports.day||!Number.isSafeInteger(state.revision)||state.revision<0)throw Error('daily-plan-scope-mismatch');
          if(view.state&&state.revision<view.state.revision)state=view.state;
          const source=await ports.project(structuredClone(state));
          if(!current())throw retired();
          publish({state:structuredClone(state),source,ready:true,loading:false,error:null});
          return structuredClone(state);
        }catch(error){
          if(current())publish({loading:false,error:error instanceof Error?error.message:'账号计划暂不可用。'});
          throw error;
        }
      })();
      if(goalRevision!==undefined){
        const pending={revision:goalRevision,epoch:token,promise:operation,boundary,allowed:canPrepare};preparing=pending;
        void operation.finally(()=>{if(preparing===pending)preparing=null;}).catch(()=>{});
      }
      return operation;
    },
    dispose(){active=false;epoch++;preparing=null;},
  };
}
