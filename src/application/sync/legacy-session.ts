import type {CloudProgress} from '../../domain/evidence';
import type {CloudSyncSnapshot,CloudSyncMetadata} from '../../domain/sync';
export type LegacyCloudFrame={owner:string;ready:boolean;signedIn:boolean;current:()=>boolean;progress:CloudProgress;metadata:CloudSyncMetadata};
export type LegacyCloudPorts={
  capture:()=>LegacyCloudFrame;read:(signal:AbortSignal)=>Promise<CloudSyncSnapshot>;
  migrate:(progress:CloudProgress,signal:AbortSignal)=>Promise<{snapshot:CloudSyncSnapshot;conflict:boolean}>;
  restore:(snapshot:CloudSyncSnapshot,kind:'initial'|'migrate',conflict:boolean)=>void;
  baselines:(frame:LegacyCloudFrame,progress:CloudProgress)=>Promise<void>;bootstrap:()=>Promise<unknown>;
  status:(value:'guest'|'checking'|'syncing'|'error')=>void;message:(value:string)=>void;
};
export function createLegacyCloudSession(ports:LegacyCloudPorts){
  let disposed=false,epoch=0,loadedOwner='',active:AbortController|null=null,migrating=false;
  const invalidate=()=>{epoch++;active?.abort();active=null;loadedOwner='';migrating=false;};
  const begin=()=>{active?.abort();const control=new AbortController(),ticket=++epoch;active=control;return{ticket,control};};
  const valid=(frame:LegacyCloudFrame,ticket:number)=>!disposed&&epoch===ticket&&frame.current();
  return{
    async read(){
      const frame=ports.capture();if(disposed||!frame.ready||!frame.current()||migrating)return;
      if(!frame.signedIn){ports.status('guest');ports.message('游客进度只保存在当前设备；登录后可以选择是否迁移到云端。');return;}
      if(loadedOwner===frame.owner)return;const {ticket,control}=begin();ports.status('checking');
      try{const value=await ports.read(control.signal);if(!valid(frame,ticket))return;loadedOwner=frame.owner;ports.restore(value,'initial',false);}
      catch(error){if(valid(frame,ticket)){ports.status('error');ports.message(error instanceof Error?error.message:'云端暂时不可用，本机学习不受影响。');}}
      finally{if(active===control)active=null;}
    },
    async migrate(){
      const frame=ports.capture();if(disposed||!frame.ready||!frame.signedIn||!frame.current()||migrating)return;
      const {ticket,control}=begin();migrating=true;ports.status('syncing');ports.message('正在把现有本地进度写入你的云端空间…');
      try{
        const result=await ports.migrate(structuredClone(frame.progress),control.signal);if(!valid(frame,ticket))return;
        ports.restore(result.snapshot,'migrate',result.conflict);
        await ports.baselines({...frame,current:()=>valid(frame,ticket)},result.snapshot.progress);
        if(valid(frame,ticket))await ports.bootstrap();
      }catch(error){if(valid(frame,ticket)){ports.status('error');ports.message(error instanceof Error?error.message:'迁移失败，本地进度仍然完整保留。');}}
      finally{if(epoch===ticket)migrating=false;if(active===control)active=null;}
    },invalidate,dispose(){invalidate();disposed=true;},
  };
}
