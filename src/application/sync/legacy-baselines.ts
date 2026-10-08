import type {CloudProgress,StudyEventV3} from '../../domain/evidence';
import type {LocalStudyEventRecord,CloudBatchResult} from '../../domain/sync';
export async function migrateLegacyBaselines(owner:string,progress:CloudProgress,ports:{
  current:()=>boolean;now:()=>string;events:(progress:CloudProgress,at:string,owner:string)=>Promise<StudyEventV3[]>;
  list:(kind:StudyEventV3['item']['kind'],key:string)=>Promise<LocalStudyEventRecord[]>;
  put:(record:LocalStudyEventRecord)=>Promise<unknown>;send:(event:StudyEventV3)=>Promise<CloudBatchResult>;ack:(eventId:string)=>Promise<unknown>;
}){
  if(!progress.fsrsData||!ports.current())return;
  const events=await ports.events(progress,ports.now(),owner);
  for(const event of events){
    if(!ports.current())return;
    const prior=await ports.list(event.item.kind,event.item.key);if(!ports.current())return;
    if(prior.some(row=>row.event.eventType==='review-baseline'||row.event.eventType==='practice-attempt'&&row.event.scheduling!==undefined))continue;
    await ports.put({workspaceId:owner,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:ports.now()});
    if(!ports.current())return;
    try{const result=await ports.send(event);if(!result.error&&[...(result.accepted??[]),...(result.duplicates??[])].includes(event.eventId))await ports.ack(event.eventId);}
    catch{/* Original event stays pending; retry cannot manufacture a new learner grade. */}
  }
}
