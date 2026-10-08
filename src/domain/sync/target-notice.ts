import type {RecentStudyReceipts} from './receipt-notice';
export type TargetNoticeScope={workspaceId:string;eventId:string;libraryId?:string};
/** A target can only update the displayed event, and cannot weaken the other target's proof. */
export function applyTargetNotice(current:RecentStudyReceipts,scope:TargetNoticeScope,patch:Pick<RecentStudyReceipts,'cloud'|'companion'|'projection'>):RecentStudyReceipts{
  if(current.workspaceId!==scope.workspaceId||current.eventId!==scope.eventId||scope.libraryId!==undefined&&current.libraryId!==scope.libraryId)return current;
  const cloudRank={pending:0,acked:1,conflict:2},companionRank={pending:0,received:1,acked:1,blocked:2,applied:3,conflict:4};
  const next={...current};
  if(patch.cloud&&(!current.cloud||cloudRank[patch.cloud]>=cloudRank[current.cloud]))next.cloud=patch.cloud;
  if(patch.companion&&(!current.companion||companionRank[patch.companion]>=companionRank[current.companion]))next.companion=patch.companion;
  if(patch.projection!==undefined)next.projection=patch.projection;
  return next;
}
