import type {StudyIdentity,AccountLoadStatus,SourceVersion} from '../../domain/sources';
// @ts-expect-error TS5097: standalone Node source contracts.
import {sourceVersionRegresses} from '../../domain/sources/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {readAccountSource} from './account-read.ts';
export type AccountSourceFrame<Loaded>={
  key:string;owner:string;modeEpoch:number;ready:boolean;identity:StudyIdentity|null;local:boolean;paused:boolean;
  current:()=>boolean;studying:()=>boolean;mutation:()=>number;visible:()=>Loaded|null;
  client:{cached:()=>Promise<Loaded|null>;load:(options:{signal?:AbortSignal})=>Promise<Loaded>};
};
export type AccountSourcePorts<Loaded,Projection,Receipt>={
  capture:()=>AccountSourceFrame<Loaded>;version:(value:Loaded)=>SourceVersion;
  prepare:(frame:AccountSourceFrame<Loaded>,value:Loaded,current:()=>boolean)=>Promise<Receipt[]>;
  project:(frame:AccountSourceFrame<Loaded>,value:Loaded)=>Promise<Projection>;
  publish:(frame:AccountSourceFrame<Loaded>,value:Loaded,projection:Projection)=>void;
  receipts:(frame:AccountSourceFrame<Loaded>,value:Receipt[])=>void;
  status:(frame:AccountSourceFrame<Loaded>,value:AccountLoadStatus)=>void;
  clear:(frame:AccountSourceFrame<Loaded>)=>void;identityChanged:(frame:AccountSourceFrame<Loaded>)=>void;
  now:()=>string;abort:()=>{signal:AbortSignal;abort:()=>void};
};

/** Source application is separate from persistent receipts and from the active question's display lifetime. */
export function createAccountSourceSession<Loaded,Projection,Receipt>(ports:AccountSourcePorts<Loaded,Projection,Receipt>){
  let disposed=false,readEpoch=0,applyEpoch=0;
  let controller:ReturnType<typeof ports.abort>|null=null,pending:{frame:AccountSourceFrame<Loaded>;value:Loaded}|null=null;
  const valid=(frame:AccountSourceFrame<Loaded>)=>!disposed&&frame.current();
  const apply=async(value:Loaded|null,frame:AccountSourceFrame<Loaded>):Promise<boolean>=>{
    if(!valid(frame))return false;const token=++applyEpoch,mutation=frame.mutation();
    if(!value){ports.clear(frame);return false;}
    const incoming=ports.version(value),visible=frame.visible();
    if(sourceVersionRegresses(incoming,visible?ports.version(visible):null)||pending&&pending.frame.key===frame.key&&sourceVersionRegresses(incoming,ports.version(pending.value)))return false;
    const current=()=>valid(frame)&&token===applyEpoch;
    const receipts=await ports.prepare(frame,value,current);if(!current())return false;
    ports.receipts(frame,receipts);
    const defer=()=>{pending={frame,value};ports.status(frame,{phase:'ready',hasCache:true,deferred:true});return false;};
    if(frame.studying())return defer();
    const projection=await ports.project(frame,value);if(!current())return false;
    if(frame.studying()||mutation!==frame.mutation())return defer();
    pending=null;ports.publish(frame,value,projection);return true;
  };
  const cancel=()=>{readEpoch++;applyEpoch++;controller?.abort();controller=null;};
  return {
    apply(value:Loaded|null,expectedModeEpoch?:number){const frame=ports.capture();if(expectedModeEpoch!==undefined&&expectedModeEpoch!==frame.modeEpoch)return Promise.resolve(false);return apply(value,frame);},
    async read(choice:{enable?:boolean}={}):Promise<Loaded|null>{
      const frame=ports.capture();if(!frame.ready||!frame.identity||frame.paused&&!choice.enable||!valid(frame))return null;
      cancel();const token=readEpoch,active=ports.abort();controller=active;
      const current=()=>valid(frame)&&token===readEpoch&&!active.signal.aborted;
      const value=await readAccountSource({identity:frame.identity,local:frame.local&&!choice.enable,signal:active.signal,client:frame.client,now:ports.now,
        onStatus:status=>{if(current())ports.status(frame,status);},
        apply:async next=>{if(!current()){active.abort();return false;}return apply(next,frame);},
        onIdentityChanged:()=>{if(current())ports.identityChanged(frame);},
      });
      return current()?value:null;
    },
    pending:()=>pending&&valid(pending.frame)?pending.value:null,
    clearPending(){pending=null;},cancel,
    dispose(){disposed=true;cancel();pending=null;},
  };
}
