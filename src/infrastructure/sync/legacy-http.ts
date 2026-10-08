import type {StudyEventV3,LocalEventContext} from '../../domain/evidence';
import type {CloudBatchResult,CompanionActivityResult} from '../../domain/sync';
import type {DeliveryConnection} from './delivery-http';

/** Legacy V3 409 projection responses remain inspectable by the original retry policy. */
export async function sendLegacyBoundEvent(owner:string,event:StudyEventV3,fetcher:typeof fetch=fetch):Promise<CloudBatchResult>{
  if(!owner.startsWith('account:'))throw Error('study-account-required');
  const response=await fetcher('/api/sync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'study-events-v3-bound',expectedUserId:owner.slice(8),events:[event]})});
  const payload=await response.json() as CloudBatchResult&{message?:string};
  if(!response.ok&&response.status!==409)throw Error(payload.message||'云同步失败');return payload;
}
export async function sendLegacyCompanionActivity<Dashboard>(connection:DeliveryConnection,event:StudyEventV3,localContext?:LocalEventContext,fetcher:typeof fetch=fetch){
  const response=await fetcher(`${connection.url}/v1/activity`,{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':connection.sessionToken},body:JSON.stringify({event,localContext}),signal:AbortSignal.timeout(15000)});
  return{ok:response.ok,httpStatus:response.status,receipt:await response.json() as CompanionActivityResult&{dashboard?:Dashboard}};
}
