// @ts-expect-error TS5097: standalone Node source contracts.
import {studyId} from '../sync/index.ts';

export type AccountSyncAuthorization={expiresAt:string;checkedAt:string};
export type AccountSyncLink={grantId:string;libraryId:string;label:string;state:string;workerStatus:string;error?:string;authorization?:AccountSyncAuthorization};
export type AccountSyncStatus={links:AccountSyncLink[]};
export type AccountSyncNotice={kind:string;message:string;action:'none'|'connect'|'resume'|'reauthorize'|'pair';expiryNotice?:string;expiresAt?:string};
const errors=new Set(['account-authorization-required','account-cloud-unavailable','account-cloud-link-changed','account-network-or-storage-unavailable','account-local-configuration-required','account-sync-integrity-check','account-publication-blocked','account-planning-publication-blocked']);
const workers=new Set(['starting','running','synced','downloading','retry','partial','blocked','paused','stopping','stopped','not-started','busy']);
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function iso(value:unknown):value is string{
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}

/** Optional observation is advisory and never grants permission or predicts a new TTL. */
export function parseAccountSyncStatus(raw:unknown,libraryId?:string):AccountSyncStatus{
  if(!object(raw)||raw.links!==undefined&&!Array.isArray(raw.links))throw new Error('account-sync-status-invalid');
  const values=Array.isArray(raw.links)?raw.links:[];
  const links:AccountSyncLink[]=values.map((value:unknown)=>{
    if(!object(value)||typeof value.label!=='string'||value.label.length>80||typeof value.state!=='string'||typeof value.workerStatus!=='string')throw new Error('account-sync-status-invalid');
    try{studyId(value.grantId,'grant');studyId(value.libraryId,'library');}catch{throw new Error('account-sync-status-invalid');}
    const link:AccountSyncLink={grantId:value.grantId as string,libraryId:value.libraryId as string,label:value.label,
      state:['active','prepared','paused','revoked'].includes(value.state)?value.state:'unknown',workerStatus:workers.has(value.workerStatus)?value.workerStatus:'unknown'};
    if(typeof value.error==='string'&&errors.has(value.error))link.error=value.error;
    const authorization=value.authorization;
    if(object(authorization)&&iso(authorization.expiresAt)&&iso(authorization.checkedAt)&&authorization.checkedAt<authorization.expiresAt){
      link.authorization={expiresAt:authorization.expiresAt,checkedAt:authorization.checkedAt};
    }
    return link;
  });
  const scoped=libraryId?links.filter(link=>link.libraryId===libraryId):links;
  if(libraryId&&links.length&&!scoped.length)throw new Error('account-library-changed');
  return {links:scoped};
}

export function accountSyncError(error:unknown):AccountSyncNotice{
  const code=error instanceof Error?error.message:'';
  if(code==='companion-pairing-required')return {kind:'pairing-required',message:'请先用当前账号重新配对 Companion。',action:'pair'};
  if(code==='companion-origin-not-allowed')return {kind:'origin-blocked',message:'此网页尚未获本机允许，请核对 Companion 来源设置。',action:'none'};
  if(['authentication-required','account-mismatch','account-installation-owner-mismatch'].includes(code))return {kind:'account-required',message:'请核对当前登录账号与 Companion 配对账号。',action:'none'};
  if(['account-authorization-required','study-grant-expired','invalid-study-grant'].includes(code))return {kind:'authorization-required',message:'本机账号同步授权已失效，请重新授权此机。',action:'reauthorize'};
  if(['account-cloud-link-changed','account-library-changed','library-mismatch'].includes(code))return {kind:'binding-changed',message:'账号或学习库关联已变化，请先核对关联后再重新授权。',action:'none'};
  if(code==='account-cloud-unavailable')return {kind:'retry',message:'云端暂时不可用，请稍后重试。',action:'none'};
  if(code==='account-cloud-link-not-ready')return {kind:'unknown',message:'云端连接尚未就绪，请刷新并核对授权状态。',action:'none'};
  return {kind:'unknown',message:'暂时无法核对后台同步，请检查 Companion 后刷新。',action:'none'};
}

export function accountSyncNotice(link:AccountSyncLink|null,now:number):AccountSyncNotice{
  if(!link)return {kind:'not-configured',message:'尚未启用本机后台同步。',action:'none'};
  if(link.error==='account-authorization-required'||link.state==='revoked')return accountSyncError(new Error('account-authorization-required'));
  if(link.error==='account-cloud-link-changed')return accountSyncError(new Error(link.error));
  if(link.state==='unknown')return {kind:'unknown',message:'后台同步状态尚未核对，请刷新。',action:'none'};
  let notice:AccountSyncNotice;
  if(link.workerStatus==='stopping')notice={kind:'stopping',message:'正在停止后台同步。',action:'none'};
  else if(link.state==='prepared')notice={kind:'not-started',message:'本机连接已准备，等待完成账号授权。',action:'connect'};
  else if(link.workerStatus==='stopped')notice={kind:'stopped',message:'后台同步已停止，待同步记录保留。',action:'resume'};
  else if(link.workerStatus==='blocked'||link.error==='account-sync-integrity-check'||link.error==='account-local-configuration-required')notice={kind:'blocked',message:'后台同步未完成，请核对本机来源与设置后重试。',action:'none'};
  else if(link.state==='paused'||link.workerStatus==='paused')notice={kind:'paused',message:'后台同步已暂停，待同步记录保留。',action:'resume'};
  else if(link.workerStatus==='retry'||link.error==='account-cloud-unavailable')notice={kind:'retry',message:'后台同步暂时受阻，将稍后重试。',action:'none'};
  else if(link.workerStatus==='partial')notice={kind:'partial',message:'部分资料尚未同步，请核对来源后重试。',action:'none'};
  else if(link.workerStatus==='not-started')notice={kind:'not-started',message:'已有本机连接，尚未启动后台同步。',action:'resume'};
  else if(link.workerStatus==='starting')notice={kind:'starting',message:'正在核对后台同步授权。',action:'none'};
  else if(link.workerStatus==='synced')notice={kind:'synced',message:'本轮后台同步已完成。',action:'none'};
  else if(link.state==='active'&&['running','downloading','busy'].includes(link.workerStatus))notice={kind:'running',message:'后台同步正在处理。',action:'none'};
  else notice={kind:'unknown',message:'后台同步状态尚未核对，请刷新。',action:'none'};
  const authorization=link.authorization;
  if(authorization&&Number.isFinite(now)){
    const remaining=Date.parse(authorization.expiresAt)-now;
    if(remaining<=0){
      const state=notice.kind==='stopped'?'后台同步已停止。':notice.kind==='paused'?'后台同步已暂停。':notice.kind==='retry'?'后台同步暂时受阻。':notice.kind==='blocked'?'后台同步未完成。':'';
      notice={kind:'authorization-required',message:`${state}已到上次核对的授权期限，请重新授权此机。`,expiresAt:authorization.expiresAt,expiryNotice:'上次核对的授权期限：',action:'reauthorize'};
    }else if(remaining<=7*24*60*60*1000){
      notice={...notice,expiresAt:authorization.expiresAt,expiryNotice:'上次核对的授权期限（7 天内到期）：'};
    }
  }
  return notice;
}
