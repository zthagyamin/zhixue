import type {AuxiliaryDelivery,StudyDeliveryReceipt} from './delivery-contracts';
export type RecentStudyReceipts={workspaceId?:string;libraryId?:string;eventId?:string;companionRevision?:number;cloud?:'acked'|'conflict'|'pending';companion?:'acked'|'conflict'|'pending'|'received'|'blocked'|'applied';projection?:string};
/** The caller has already persisted/validated the bound receipt. Presentation
 * must not regress when replaying an older page of that same receipt stream. */
export function foldCoreReceiptNotice(current:RecentStudyReceipts,workspaceId:string,receipt:StudyDeliveryReceipt):RecentStudyReceipts{
  if(current.workspaceId!==workspaceId||current.eventId!==receipt.eventId||current.libraryId!==receipt.libraryId)return current;
  if(receipt.target==='cloud')return receipt.status==='acked'?{...current,cloud:'acked'}:current;
  if(receipt.revision<=(current.companionRevision??0)||current.companion==='applied'&&receipt.status!=='applied')return current;
  return receipt.status==='received'||receipt.status==='blocked'||receipt.status==='applied'?{...current,companion:receipt.status,companionRevision:receipt.revision}:current;
}
export function strongerAuxiliaryDelivery(current:AuxiliaryDelivery|'pending',other?:AuxiliaryDelivery|'pending'):AuxiliaryDelivery|'pending'{
  const proofRank:Record<AuxiliaryDelivery|'pending',number>={unknown:0,'not-saved':1,'binding-unknown':2,pending:2,'parent-pending':2,unsupported:2,'account-received':3,received:4,blocked:5,applied:6};
  return other&&proofRank[other]>proofRank[current]?other:current;
}
export function auxiliaryDeliveryLabel(state:AuxiliaryDelivery|'pending'):string{
  const labels:Record<AuxiliaryDelivery|'pending',string>={
    unknown:'辅助情况未知：这条作答没有可核对的页面摘要。',
    'binding-unknown':'辅助摘要已存本机；原题来源未绑定，不能自动写回。',
    'not-saved':'作答已保存，但辅助摘要未保存。',
    'parent-pending':'辅助摘要已存本机，等待原作答接收。',
    unsupported:'辅助摘要已存本机；服务或 Companion 需升级后才能同步。',
    pending:'辅助摘要已存本机，等待同步。',
    'account-received':'辅助摘要已进入账号，等待 Companion 写回。',
    received:'Companion 已接收辅助摘要，实际写回待确认。',
    blocked:'辅助摘要写回待处理；原作答记录不受影响。',
    applied:'辅助摘要已写回学习知识库。',
  };return labels[state];
}
