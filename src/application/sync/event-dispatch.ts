import type {StudyEventV3,LocalEventContext} from '../../domain/evidence';
import type {StudySubmissionV1,SubmissionRow,CloudBatchResult,CompanionActivityResult,AuxiliaryDelivery,TargetNoticeScope,RecentStudyReceipts} from '../../domain/sync';
import type {AccountDeliveryRow} from './ports';
type AccountBatch={results:Array<{eventId:string;durable:boolean;status?:string;error?:string;receipt?:unknown}>};
type ReceiptPatch=Pick<RecentStudyReceipts,'cloud'|'companion'|'projection'>;
export type EventDispatchPorts<Dashboard>={
  owner:string;accountOwner:string|null;hasCompanion:boolean;isOwnerCurrent:()=>boolean;isViewCurrent:()=>boolean;
  readSubmitted:(eventId:string)=>Promise<SubmissionRow|null>;
  findAccount:(eventId:string)=>Promise<AccountDeliveryRow|null>;
  readAccount:(libraryId:string,eventId:string)=>Promise<AccountDeliveryRow|null>;
  drainAccount:(libraryId:string)=>Promise<AccountBatch>;
  cloud:(event:StudyEventV3)=>Promise<CloudBatchResult>;
  companion:(event:StudyEventV3,context?:LocalEventContext)=>Promise<{ok:boolean;httpStatus:number;receipt:CompanionActivityResult&{dashboard?:Dashboard}}>;
  submitted:{cloud:(p:StudySubmissionV1)=>Promise<CloudBatchResult>;companion:(p:StudySubmissionV1)=>Promise<CompanionActivityResult>;summary:(p:StudySubmissionV1)=>Promise<AuxiliaryDelivery>};
  notice:(scope:TargetNoticeScope,patch:ReceiptPatch)=>void;auxiliary:(scope:TargetNoticeScope,state:AuxiliaryDelivery)=>void;dashboard:(value:Dashboard)=>void;
};

/** Choose the original journal/envelope route before dispatch. Displaying a different item cannot retarget a receipt. */
export function createEventDispatcher<Dashboard>(ports:EventDispatchPorts<Dashboard>){
  const owner=()=>{if(!ports.isOwnerCurrent())throw Error('study-workspace-changed');};
  const scope=(eventId:string,libraryId?:string):TargetNoticeScope=>({workspaceId:ports.owner,eventId,...(libraryId?{libraryId}:{})});
  const notice=(target:TargetNoticeScope,patch:ReceiptPatch)=>{if(ports.isViewCurrent())ports.notice(target,patch);};
  const submitted=async(event:StudyEventV3)=>{
    owner();const row=await ports.readSubmitted(event.eventId);
    if(row&&row.payload.core.event.coreHash!==event.coreHash)throw Error('study-event-conflict');return row?.payload??null;
  };
  const summary=async(p:StudySubmissionV1)=>{
    try{owner();const state=await ports.submitted.summary(p);if(ports.isViewCurrent())ports.auxiliary(scope(p.eventId,p.route.kind==='account'?p.route.record.libraryId:undefined),state);}
    catch{/* The summary has its own durable queue and must never alter core delivery. */}
  };
  const submittedCloud=async(p:StudySubmissionV1):Promise<CloudBatchResult>=>{
    owner();const result=await ports.submitted.cloud(p);
    notice(scope(p.eventId,p.route.kind==='account'?p.route.record.libraryId:undefined),{cloud:result.conflicts?.some(row=>row.eventId===p.eventId)?'conflict':!result.error&&(result.accepted?.includes(p.eventId)||result.duplicates?.includes(p.eventId))?'acked':'pending'});
    void summary(p);return result;
  };
  const submittedCompanion=async(p:StudySubmissionV1):Promise<CompanionActivityResult>=>{
    owner();const result=await ports.submitted.companion(p);
    const pending=result.projectionStatus==='pending'||result.companionReceipt?.projectionStatus==='pending';
    const accepted=!pending&&(result.status==='duplicate'||result.status==='accepted'&&result.companionReceipt?.durable===true);
    notice(scope(p.eventId,p.route.kind==='account'?p.route.record.libraryId:undefined),{companion:result.status==='conflict'?'conflict':accepted?'received':'pending'});void summary(p);return result;
  };
  return {
    submittedCloud,submittedCompanion,
    async cloud(event:StudyEventV3):Promise<CloudBatchResult>{
      const p=await submitted(event);
      if(p)return submittedCloud(p);
      const known=ports.accountOwner&&event.eventType==='practice-attempt'?await ports.findAccount(event.eventId):null;
      if(known){
        if(known.record.event.coreHash!==event.coreHash)throw Error('study-event-conflict');owner();
        const library=known.record.libraryId,batch=await ports.drainAccount(library),accepted:string[]=[];
        const conflicts=batch.results.filter(result=>result.status==='conflict').map(result=>({eventId:result.eventId,reason:result.error??'conflict'}));
        const stored=await ports.readAccount(library,event.eventId);
        if(stored?.cloud==='acked'&&stored.record.event.coreHash===event.coreHash)accepted.push(event.eventId);
        notice(scope(event.eventId,library),{cloud:conflicts.some(value=>value.eventId===event.eventId)?'conflict':accepted.includes(event.eventId)?'acked':'pending'});return{accepted,conflicts};
      }
      owner();if(!ports.accountOwner)throw Error('study-account-required');
      const result=await ports.cloud(event);
      notice(scope(event.eventId),{cloud:result.conflicts?.some(value=>value.eventId===event.eventId)?'conflict':!result.error&&(result.accepted?.includes(event.eventId)||result.duplicates?.includes(event.eventId))?'acked':'pending'});return result;
    },
    async companion(event:StudyEventV3,context?:LocalEventContext):Promise<CompanionActivityResult>{
      const p=await submitted(event);
      if(p)return submittedCompanion(p);
      if(!ports.hasCompanion)return{status:'not-required'};
      try{
        owner();const response=await ports.companion(event,context),receipt=response.receipt;
        if(receipt.dashboard&&ports.isViewCurrent())ports.dashboard(receipt.dashboard);
        if(response.httpStatus===409&&receipt.status==='conflict'){notice(scope(event.eventId),{companion:'conflict'});return{status:'conflict'};}
        if(!response.ok){notice(scope(event.eventId),{companion:'pending'});return{status:'error'};}
        const pending=receipt.projectionStatus==='pending'||receipt.companionReceipt?.projectionStatus==='pending';
        const durable=!pending&&(receipt.status==='duplicate'||receipt.companionReceipt?.durable===true);
        notice(scope(event.eventId),{companion:durable?'acked':'pending',projection:receipt.companionReceipt?.stateProjection?.status});
        return{status:receipt.status??'accepted',projectionStatus:receipt.projectionStatus,companionReceipt:receipt.companionReceipt};
      }catch{notice(scope(event.eventId),{companion:'pending'});return{status:'error'};}
    },
  };
}
