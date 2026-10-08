import type {CloudLearningEvent,CloudSyncSnapshot,AuxiliaryDelivery,ProjectionMismatch} from '../../domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
import {manualSyncResult} from '../../domain/sync/index.ts';
export type RecoverySummary={complete:boolean;pending:{coreUploads:readonly string[];coreWritebacks:readonly string[];recovery:readonly string[];assistance:readonly string[];tasks:readonly string[];legacyQueues:boolean}};
export type SyncOperation='legacy'|'activities'|'account'|'journal'|'targets'|'manual';
export type SyncNotice=
  |{kind:'cloud-start'}
  |{kind:'cloud-receipt';snapshot:CloudSyncSnapshot;processed:string[]}
  |{kind:'cloud-error';message:string}
  |{kind:'activities';delivered:string[]}
  |{kind:'journal';recovered:number;states:Array<{eventId:string;state:AuxiliaryDelivery}>}
  |{kind:'journal-error'}
  |{kind:'projection-mismatches';count:number;at:string}
  |{kind:'manual-start'}
  |{kind:'manual-result';status:'synced'|'error';message:string};
export type SyncFrame<Activity extends {eventId:string}>={
  key:string;owner:string;ready:boolean;accountOwner:string|null;current:()=>boolean;
  legacy?:{enabled:boolean;events:CloudLearningEvent[];send:(batch:CloudLearningEvent[])=>Promise<{snapshot:CloudSyncSnapshot;processedEventIds?:string[]}>};
  activities?:{items:Activity[];send:(activity:Activity)=>Promise<boolean>};
  account?:{drain:()=>Promise<void>;refresh:()=>Promise<unknown>};
  journal:()=>Promise<{recovered:number;failed:number;states:Array<{eventId:string;state:AuxiliaryDelivery}>}>;
  targets:()=>Promise<{projectionMismatches:ProjectionMismatch[]}>;
  bootstrap:()=>Promise<{supported:boolean}>;
  diagnostics:()=>Promise<unknown>;
  recovery:()=>Promise<RecoverySummary>;
};
type Job<Activity extends {eventId:string}>={frame:SyncFrame<Activity>;token:number;promise:Promise<void>};

/** Each run captures its source and publication lease before waiting. Stored receipts remain independent. */
export function createSyncCoordinator<Activity extends {eventId:string}>(ports:{
  capture:()=>SyncFrame<Activity>;publish:(notice:SyncNotice)=>void;busy:(operation:SyncOperation,value:boolean)=>void;now:()=>string;
}){
  let epoch=0,disposed=false;
  const flights=new Map<string,Job<Activity>>();
  const current=(frame:SyncFrame<Activity>,token:number)=>!disposed&&token===epoch&&frame.current();
  const publish=(frame:SyncFrame<Activity>,token:number,notice:SyncNotice)=>{if(current(frame,token))ports.publish(notice);};
  const run=(operation:SyncOperation,frame:SyncFrame<Activity>,work:(token:number)=>Promise<void>):Promise<void>=>{
    if(disposed||!frame.current())return Promise.resolve();
    const key=JSON.stringify([frame.key,operation]),old=flights.get(key);
    if(old&&old.token===epoch&&old.frame.current())return old.promise;
    const token=epoch,job={frame,token,promise:Promise.resolve()};flights.set(key,job);ports.busy(operation,true);
    job.promise=Promise.resolve().then(()=>current(frame,token)?work(token):undefined).finally(()=>{
      if(flights.get(key)!==job)return;flights.delete(key);
      if(current(frame,token))ports.busy(operation,false);
    });return job.promise;
  };
  const legacy=(frame:SyncFrame<Activity>)=>{
    const source=frame.legacy;if(!frame.accountOwner||!source?.enabled||!source.events.length)return Promise.resolve();
    return run('legacy',frame,async token=>{
      const batch=structuredClone(source.events.slice(0,50));publish(frame,token,{kind:'cloud-start'});
      try{
        const receipt=await source.send(batch);
        if(!receipt.snapshot)throw Error('云同步失败');
        publish(frame,token,{kind:'cloud-receipt',snapshot:receipt.snapshot,processed:receipt.processedEventIds??batch.map(item=>item.eventId)});
      }catch(error){publish(frame,token,{kind:'cloud-error',message:error instanceof Error?error.message:'暂时无法同步，学习事件已留在本机等待重试。'});}
    });
  };
  const journal=(frame:SyncFrame<Activity>)=>{
    if(!frame.ready)return Promise.resolve();
    return run('journal',frame,async token=>{
      try{const result=await frame.journal();publish(frame,token,{kind:'journal',recovered:result.recovered,states:result.states});}
      catch{publish(frame,token,{kind:'journal-error'});}
    });
  };
  const targets=(frame:SyncFrame<Activity>)=>{
    if(!frame.ready)return Promise.resolve();
    return run('targets',frame,async token=>{
      await journal(frame);if(!current(frame,token))return;
      const result=await frame.targets();
      if(result.projectionMismatches.length)publish(frame,token,{kind:'projection-mismatches',count:result.projectionMismatches.length,at:ports.now()});
    });
  };
  return {
    flushLegacy:()=>legacy(ports.capture()),flushJournal:()=>journal(ports.capture()),flushTargets:()=>targets(ports.capture()),
    flushActivities(){
      const frame=ports.capture(),source=frame.activities;if(!source?.items.length)return Promise.resolve();
      return run('activities',frame,async token=>{
        const delivered:string[]=[];
        for(const activity of structuredClone(source.items)){if(!current(frame,token))return;if(await source.send(activity))delivered.push(activity.eventId);}
        if(delivered.length)publish(frame,token,{kind:'activities',delivered});
      });
    },
    flushAccount(){
      const frame=ports.capture(),account=frame.account;if(!frame.ready||!frame.accountOwner||!account)return Promise.resolve();
      return run('account',frame,async token=>{
        try{await account.drain();if(current(frame,token))await account.refresh();}
        catch{/* Accepted records retain independent receipts; pending records retry with the next trigger. */}
      });
    },
    manual(){
      const frame=ports.capture();if(!frame.accountOwner||frame.accountOwner!==frame.owner){if(frame.current())ports.publish({kind:'manual-result',status:'error',message:'请先确认账号；本机记录没有上传。'});return Promise.resolve();}
      return run('manual',frame,async token=>{
        publish(frame,token,{kind:'manual-start'});
        try{
          await legacy(frame);if(!current(frame,token))return;
          await targets(frame);if(!current(frame,token))return;
          const result=await frame.bootstrap();if(!current(frame,token))return;
          await frame.diagnostics();if(!current(frame,token))return;
          const receipts=await frame.recovery();if(!current(frame,token))return;
          const outcome=manualSyncResult(result.supported,receipts);publish(frame,token,{kind:'manual-result',status:outcome.status,message:outcome.message});
        }catch(error){publish(frame,token,{kind:'manual-result',status:'error',message:error instanceof Error?error.message:'同步未能完整核对，学习事件仍保留在本机等待重试。'});}
      });
    },
    invalidate(){epoch++;flights.clear();},
    dispose(){disposed=true;epoch++;flights.clear();},
  };
}
