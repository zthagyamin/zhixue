import type {StudyRecordEnvelope,LocalStudyEventRecord} from '../../domain/sync';
import type {AccountDeliveryRow} from './ports';
export type AccountDrainPorts={
  list:(owner:string,libraryId:string)=>Promise<AccountDeliveryRow[]>;
  mirror:(owner:string,eventId:string)=>Promise<LocalStudyEventRecord|undefined>;
  storageFailure:(error:unknown)=>boolean;
  send:(records:StudyRecordEnvelope[])=>Promise<{results:Array<{eventId:string;durable:boolean;receipt?:unknown}>}>;
  receipt:(owner:string,raw:unknown)=>Promise<unknown>;
  isCurrent?:()=>boolean;
};
/** The captured library and immutable envelope determine receipt ownership even after navigation. */
export async function drainAccountRecords(workspaceId:string,libraryId:string,ports:AccountDrainPorts):Promise<void>{
  const current=()=>ports.isCurrent?.()??true;
  const pending:StudyRecordEnvelope[]=[],blocked:string[]=[];
  for(const row of (await ports.list(workspaceId,libraryId)).filter(row=>row.cloud==='pending')){
    if(!current())return;
    try{const mirror=await ports.mirror(workspaceId,row.record.event.eventId);
      if(mirror&&(mirror.event.coreHash!==row.record.event.coreHash||mirror.cloud==='conflict')){blocked.push(row.record.event.eventId);continue;}
    }catch(error){if(!ports.storageFailure(error))throw error;}
    pending.push(row.record);
  }
  for(let offset=0;offset<pending.length;offset+=5){
    if(!current())return;
    const batch=pending.slice(offset,offset+5),response=await ports.send(batch);
    for(const record of batch){const result=response.results.find(value=>value.eventId===record.event.eventId);if(result?.durable&&result.receipt){
      const receipt=result.receipt as {libraryId?:unknown;eventId?:unknown;envelopeHash?:unknown;target?:unknown;status?:unknown};
      if(receipt.libraryId!==libraryId||receipt.eventId!==record.event.eventId||receipt.envelopeHash!==record.envelopeHash||receipt.target!=='cloud'||receipt.status!=='acked')throw Error('study-receipt-binding');
      await ports.receipt(workspaceId,result.receipt);
    }}
  }
  if(blocked.length)throw Error('study-mirror-conflict');
}
