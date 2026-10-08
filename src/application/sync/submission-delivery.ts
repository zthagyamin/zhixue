import type {StudySubmissionV1,AuxiliaryDelivery,CloudBatchResult,CompanionActivityResult,DeliveryTarget} from '../../domain/sync';
import type {SubmissionJournalPort,SubmissionStores,DeliveryHttpPort} from './ports';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseStudySubmission,submissionAssociationHash,sealAccountAssistance,studyId,studyObject} from '../../domain/sync/index.ts';
type Options={workspaceId:string;journal:SubmissionJournalPort;isCurrent:()=>boolean;storage:SubmissionStores;http:DeliveryHttpPort;companion?:{capabilities:readonly string[]}|null};
const capability=(p:StudySubmissionV1)=>p.summary?.schemaVersion===2?'assistance-summary-v2':'assistance-summary-v1';
/** Only a frozen submission is accepted. Never consult the current page, source,
 * library or plugin to reconstruct provenance during a delayed dispatch. */
export function createSubmissionDelivery(options:Options){
  const workspaceId=options.workspaceId;studyId(workspaceId,'workspace');
  const userId=workspaceId.startsWith('account:')?workspaceId.slice(8):null;
  const owner=()=>{if(!options.isCurrent())throw Error('study-workspace-changed');};
  const {persistOriginalSubmission,getLocalStudyRecord,applyLocalStudyReceipt,getLocalStudyEvent,updateStudyEventDelivery,isStudyStorageFailure}=options.storage;
  const account:DeliveryHttpPort['account']=(...args)=>{owner();return options.http.account(...args);};
  const native:DeliveryHttpPort['native']=(...args)=>{owner();return options.http.native(...args);};
  const bootstrap=()=>{owner();return options.http.bootstrap();};
  const boundEvents:DeliveryHttpPort['boundEvents']=(...args)=>{owner();return options.http.boundEvents(...args);};
  async function check(raw:StudySubmissionV1){owner();const p=await parseStudySubmission(raw);if(p.workspaceId!==workspaceId)throw new Error('submission-owner-binding');return p;}
  async function accountMirror(p:StudySubmissionV1){
    let mirror;try{mirror=await getLocalStudyEvent(workspaceId,p.eventId);}catch(error){if(!isStudyStorageFailure(error))throw error;}
    if(mirror&&(mirror.event.coreHash!==p.core.event.coreHash||mirror.cloud==='conflict'))throw new Error('study-mirror-conflict');return mirror;
  }
  async function core(raw:StudySubmissionV1,target:'cloud'):Promise<CloudBatchResult>;
  async function core(raw:StudySubmissionV1,target:'companion'):Promise<CompanionActivityResult>;
  async function core(raw:StudySubmissionV1,target:DeliveryTarget):Promise<CloudBatchResult|CompanionActivityResult>{
    const p=await check(raw);if(p.core[target]!=='pending')return{};
    // Core transport receipts live in the original stores. When only the journal
    // survived, repair those stores before delivery instead of inventing an ACK.
    const persisted=await persistOriginalSubmission(p);if(persisted.mirror==='conflict'||persisted.mirror==='failed')throw new Error(`study-mirror-${persisted.mirror}`);
    try{if(await options.journal.get(workspaceId,p.eventId))await options.journal.markCoreStored(workspaceId,p.eventId);}catch{/* Replay remains safe; core delivery does not depend on auxiliary storage. */}
    if(target==='cloud'){
      let result:CloudBatchResult;
      if(p.route.kind==='account'){
        const record=p.route.record,reply=await account(record.libraryId,'append-records',{records:[record]});
        if(!Array.isArray(reply.results))throw new Error('invalid-study-delivery');
        const entry=reply.results.find(value=>value?.eventId===p.eventId);
        if(entry?.status==='conflict')result={conflicts:[{eventId:p.eventId,reason:'account-event-conflict'}]};
        else if(entry?.durable===true&&entry.receipt){
          const receipt=entry.receipt;
          if(receipt.libraryId!==record.libraryId||receipt.eventId!==p.eventId||receipt.envelopeHash!==record.envelopeHash||receipt.target!=='cloud'||receipt.status!=='acked')throw new Error('study-receipt-binding');
          await applyLocalStudyReceipt(workspaceId,receipt);result={accepted:[p.eventId]};
        }else result={};
      }else{
        if(!userId)throw new Error('study-account-required');
        result=await boundEvents([p.core.event]) as CloudBatchResult;
      }
      try{
        if(result.conflicts?.some(row=>row.eventId===p.eventId))await updateStudyEventDelivery(workspaceId,p.eventId,'cloud','conflict');
        else if(!result.error&&(result.accepted?.includes(p.eventId)||result.duplicates?.includes(p.eventId)))await updateStudyEventDelivery(workspaceId,p.eventId,'cloud','acked');
      }catch(error){if(p.route.kind!=='account'||!isStudyStorageFailure(error))throw error;}
      return result;
    }
    if(p.route.kind!=='local')return{};
    const reply=await native('activity',{event:p.core.event,...(p.core.localContext?{localContext:p.core.localContext}:{}),...(p.route.binding?{attemptBinding:p.route.binding}:{})},p.eventId) as CompanionActivityResult;
    const pending=reply.projectionStatus==='pending'||reply.companionReceipt?.projectionStatus==='pending';
    if(reply.status==='conflict')await updateStudyEventDelivery(workspaceId,p.eventId,'companion','conflict');
    else if(!pending&&(reply.status==='duplicate'||reply.status==='accepted'&&reply.companionReceipt?.durable===true))await updateStudyEventDelivery(workspaceId,p.eventId,'companion','acked');
    return reply;
  }
  const transport={core,async summary(raw:StudySubmissionV1):Promise<AuxiliaryDelivery>{
    const p=await check(raw);if(!p.summary)return'unknown';if(p.route.kind==='local'&&!p.route.binding)return'binding-unknown';
    const row=await options.journal.get(workspaceId,p.eventId);if(!row)return'not-saved';
    const associationHash=await submissionAssociationHash(p);if(row.associationHash!==associationHash||row.payload.summary?.summaryHash!==p.summary.summaryHash)throw new Error('assistance-dispatch-binding');
    if(row.writeback?.receipt.status==='applied')return'applied';
    if(p.route.kind==='account'){
      if(row.cloudAck)return row.writeback?.receipt.status??'account-received';
      await accountMirror(p);
      const parent=await getLocalStudyRecord(workspaceId,p.route.record.libraryId,p.eventId);
      if(!parent||parent.cloud!=='acked'||parent.record.envelopeHash!==p.route.record.envelopeHash)return'parent-pending';
      const boot=await bootstrap();
      const profile=boot.profile as {libraryId?:string}|undefined;
      if(boot.apiVersion!==1||boot.enabled!==true||profile?.libraryId!==p.route.record.libraryId)throw new Error('assistance-bootstrap-binding');
      if(!Array.isArray(boot.capabilities)||!boot.capabilities.includes(capability(p)))return'unsupported';
      const record=await sealAccountAssistance(p.route.record,p.summary),reply=await account(record.libraryId,'append-assistance',{records:[record]});
      if(!Array.isArray(reply.results))throw new Error('invalid-assistance-response');
      const ack=reply.results.find(value=>value?.summaryId===p.summary!.summaryId);
      if(!ack||!['accepted','duplicate'].includes(ack.status)||ack.durable!==true)throw new Error('assistance-append-unconfirmed');
      await options.journal.ackSummary(workspaceId,p.eventId,{summaryId:ack.summaryId,summaryHash:ack.summaryHash,associationHash:ack.associationHash,sequence:ack.sequence});return'account-received';
    }
    if(!options.companion?.capabilities.includes(capability(p)))return'unsupported';
    const parent=await getLocalStudyEvent(workspaceId,p.eventId);if(parent?.event.coreHash!==p.core.event.coreHash||parent.companion!=='acked')return'parent-pending';
    const reply=await native('assistance',{record:{schemaVersion:1,binding:p.route.binding,summary:p.summary,associationHash}});
    if(reply.durable!==true||!['accepted','duplicate'].some(status=>status===reply.status)||reply.summaryId!==p.summary.summaryId||reply.summaryHash!==p.summary.summaryHash||reply.associationHash!==associationHash)throw new Error('assistance-native-ack-binding');
    const receipt=studyObject(reply.receipt,['sequence','receipt']);await options.journal.applyReceipt(workspaceId,p.eventId,receipt.sequence as number,receipt.receipt);
    return (await options.journal.get(workspaceId,p.eventId))!.writeback!.receipt.status;
  },async drain():Promise<{recovered:number;failed:number;states:Array<{eventId:string;state:AuxiliaryDelivery}>}>{
    owner();let recovered=0,failed=0;const states:Array<{eventId:string;state:AuxiliaryDelivery}>=[];
    for(const row of await options.journal.list(workspaceId)){
      owner();const p=row.payload;
      try{
        let cloudPending=false,companionPending=false;
        if(p.route.kind==='account'){
          let primary=await getLocalStudyRecord(workspaceId,p.route.record.libraryId,p.eventId);const mirror=await accountMirror(p);
          if(!row.coreStored||!primary||!mirror){const saved=await persistOriginalSubmission(p);if(saved.mirror==='conflict'||saved.mirror==='failed')throw new Error(`study-mirror-${saved.mirror}`);await options.journal.markCoreStored(workspaceId,p.eventId);primary=await getLocalStudyRecord(workspaceId,p.route.record.libraryId,p.eventId);if(!row.coreStored)recovered++;}
          if(primary?.record.envelopeHash!==p.route.record.envelopeHash||mirror&&mirror.event.coreHash!==p.core.event.coreHash)throw new Error('submission-core-conflict');cloudPending=primary.cloud==='pending';
        }else{
          let stored=await getLocalStudyEvent(workspaceId,p.eventId);
          if(!row.coreStored||!stored){await persistOriginalSubmission(p);await options.journal.markCoreStored(workspaceId,p.eventId);stored=await getLocalStudyEvent(workspaceId,p.eventId);recovered++;}
          if(stored?.event.coreHash!==p.core.event.coreHash)throw new Error('submission-core-conflict');cloudPending=stored.cloud==='pending';companionPending=stored.companion==='pending';
        }
        const targets=[];let rowFailed=false,summaryAttempted=false,state:AuxiliaryDelivery|undefined;
        const sendSummary=async()=>{summaryAttempted=true;try{state=await transport.summary(p);}catch{rowFailed=true;}};
        if(cloudPending)targets.push(core(p,'cloud').then(sendSummary));
        if(companionPending)targets.push(core(p,'companion').then(sendSummary));
        // Targets remain independent; a failed cloud request does not suppress
        // native writeback. A failed summary waits for the next trigger.
        const deliveries=await Promise.allSettled(targets);if(deliveries.some(result=>result.status==='rejected'))rowFailed=true;
        if(!summaryAttempted)await sendSummary();if(state)states.push({eventId:p.eventId,state});if(rowFailed)failed++;
      }catch{failed++;}
    }
    return{recovered,failed,states};
  }};return transport;
}
