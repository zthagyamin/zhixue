import type {RecentStudyReceipts} from '../../domain/sync';

export type SyncSummaryInput = {
  pending: {total:number;uploads:number;writebacks:number;assistance:number}|null;
  checkedAt?: string | null;
  receipts?: RecentStudyReceipts | null;
  workspaceId: string;
  libraryId?: string | null;
  accountStatus?: 'not-enabled' | 'enabled' | 'unknown';
  companionStatus?: 'offline' | 'online' | 'unknown';
};
export type SyncSummaryView = {queue:string;checked:string;recent:string[];guidance:string[]};

export function syncSummary(input:SyncSummaryInput):SyncSummaryView {
  const queue=input.pending
    ? `当前账号在本机待处理 ${input.pending.total} 项（包括该账号各学习库）`
    : '当前账号在本机待处理情况待核对';
  const time=input.checkedAt ? new Date(input.checkedAt) : null;
  const checked=time && Number.isFinite(time.getTime()) ? `最近核对：${time.toLocaleString()}` : '尚未核对时间';
  const receipt=input.receipts;
  const matches=Boolean(receipt?.eventId && receipt.workspaceId===input.workspaceId &&
    (receipt.libraryId??null)===(input.libraryId??null));
  const recent:string[]=[];
  if(matches && receipt){
    if(receipt.cloud==='acked')recent.push('账号：已接收');
    else if(receipt.cloud==='pending')recent.push('账号：等待接收');
    else if(receipt.cloud==='conflict')recent.push('账号：记录冲突，请检查后处理，原记录保留');
    if(receipt.companion==='applied')recent.push('学习库：已写回');
    else if(receipt.companion==='received'||receipt.companion==='acked')recent.push('Companion：已接收，实际写回待核对');
    else if(receipt.companion==='blocked')recent.push('学习库写回：待处理，请检查连接与来源');
    else if(receipt.companion==='conflict')recent.push('Companion：记录冲突，请检查后处理，原记录保留');
    else if(receipt.companion==='pending')recent.push('Companion：等待接收或处理');
  }
  const guidance:string[]=[];
  if(input.accountStatus==='not-enabled')guidance.push('账号同步未启用；记录保留在本机，可在设置中核对。');
  if(input.companionStatus==='offline')guidance.push('Companion 离线；恢复连接后可核对学习库写回。');
  return {queue,checked,recent,guidance};
}
