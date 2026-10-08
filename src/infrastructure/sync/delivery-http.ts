import type {DeliveryHttpPort} from '../../application/sync';
export type DeliveryConnection={url:string;sessionToken:string;capabilities:readonly string[]};

/** Endpoint/session selection is frozen by the caller; immutable data supplies the target library. */
export function createDeliveryHttp(options:{workspaceId:string;companion?:DeliveryConnection|null;fetcher?:typeof fetch}):DeliveryHttpPort{
  const fetcher=options.fetcher??fetch,userId=options.workspaceId.startsWith('account:')?options.workspaceId.slice(8):null;
  const json=async(url:string,init:RequestInit,conflictEventId?:string)=>{
    const response=await fetcher(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...init}),raw=await response.json();
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('invalid-study-delivery');const value=raw as Record<string,unknown>;
    if(!response.ok&&!(response.status===409&&conflictEventId&&value.status==='conflict'&&value.eventId===conflictEventId))throw Error(typeof value.error==='string'?value.error:'study-delivery-failed');return value;
  };
  const post=(url:string,body:unknown,headers:Record<string,string>={},conflictEventId?:string)=>json(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)},conflictEventId);
  const requireUser=()=>{if(!userId)throw Error('study-account-required');return userId;};
  return {
    account:(libraryId,action,body)=>post('/api/account-study',{action,libraryId,...body,expectedUserId:requireUser()}),
    native:(action,body,conflictEventId)=>{
      if(!options.companion)throw Error('companion-pairing-required');
      return post(`${options.companion.url}/v1/${action}`,body,{'X-Study-Loop-Session':options.companion.sessionToken},conflictEventId);
    },
    bootstrap:()=>json(`/api/account-study?${new URLSearchParams({action:'bootstrap',expectedUserId:requireUser()})}`,{}),
    boundEvents:events=>post('/api/sync',{action:'study-events-v3-bound',expectedUserId:requireUser(),events}),
  };
}
