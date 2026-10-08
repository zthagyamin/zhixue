import {handleBoundStudyEventsV3Get} from '../../app/sync-v3-api.ts';
/** Real HTTP boundary with disposable, deterministic in-memory evidence only. */
export function nativePreviewRead(events,userId){return request=>handleBoundStudyEventsV3Get(request,async()=>({userId}),()=>({
  latestCursor:async()=>events.size,
  listEventsAfter:async(_owner,after,limit,through)=>[...events.values()].map((event,index)=>({sequence:index+1,event})).filter(row=>row.sequence>after&&row.sequence<=through).slice(0,limit),
}));}
