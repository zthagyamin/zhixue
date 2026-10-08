import {createEventDispatcher,type EventDispatchPorts} from '../../src/application/sync';
import {sendLegacyBoundEvent,sendLegacyCompanionActivity,type DeliveryConnection} from '../../src/infrastructure/sync';
import {findLocalAccountStudyRecord,getLocalStudyRecord} from '../local-account-study';
import {createAccountStudyClient} from '../account-study-client';
import {flushAccountStudyRecords} from '../account-study-record-client';
import {createSubmissionTransport} from '../study-submission-transport';
import {readJournalForDelivery,type SubmissionJournal} from '../study-submission-journal';

/** Existing records and clients provide I/O; route selection and display receipt rules live in the use case. */
export function createDashboardEventDispatcher<Dashboard>(options:{workspaceId:string;accountOwner:string|null;companionUrl:string;companion:DeliveryConnection|null;journal:SubmissionJournal;
  isOwnerCurrent:()=>boolean;isViewCurrent:()=>boolean;notice:EventDispatchPorts<Dashboard>['notice'];auxiliary:EventDispatchPorts<Dashboard>['auxiliary'];dashboard:(value:Dashboard)=>void}){
  const owner=options.workspaceId,check=()=>{if(!options.isOwnerCurrent())throw Error('study-workspace-changed');};
  const transport=createSubmissionTransport({workspaceId:owner,journal:options.journal,isCurrent:options.isOwnerCurrent,companion:options.companion});
  return createEventDispatcher<Dashboard>({owner,accountOwner:options.accountOwner,hasCompanion:Boolean(options.companion),isOwnerCurrent:options.isOwnerCurrent,isViewCurrent:options.isViewCurrent,
    readSubmitted:eventId=>readJournalForDelivery(options.journal,owner,eventId),
    findAccount:eventId=>options.accountOwner?findLocalAccountStudyRecord(options.accountOwner,eventId):Promise.resolve(null),
    readAccount:(library,eventId)=>getLocalStudyRecord(owner,library,eventId),
    drainAccount:async library=>{
      const client=createAccountStudyClient({companionUrl:options.companionUrl,expectedUserId:owner.slice(8),libraryId:library});
      let result:{results:Array<{eventId:string;durable:boolean;status?:string;error?:string;receipt?:unknown}>}={results:[]};
      await flushAccountStudyRecords(owner,library,async records=>{check();result=await client.appendRecords(records) as typeof result;return result;});return result;
    },
    cloud:async event=>{check();return sendLegacyBoundEvent(owner,event);},
    companion:async(event,localContext)=>{
      check();if(!options.companion)throw Error('companion-pairing-required');
      return sendLegacyCompanionActivity<Dashboard>(options.companion,event,localContext);
    },
    submitted:{cloud:p=>transport.core(p,'cloud'),companion:p=>transport.core(p,'companion'),summary:p=>transport.summary(p)},
    notice:options.notice,auxiliary:options.auxiliary,dashboard:options.dashboard,
  });
}
