import type {AccountLoadStatus} from './account-study-load-state';
import type {AccountAiSettingsResponse} from './account-study-client';

export type SettingsStatus={label:string;detail:string;tone:'good'|'warning'|'muted'};
export function settingsAccountConnection(state:AccountLoadStatus,signedIn:boolean):SettingsStatus{
  if(!signedIn)return{label:'未登录',detail:'游客模式不代表已启用账号题库',tone:'muted'};
  const labels:Record<AccountLoadStatus['phase'],string>={idle:'待核对',guest:'游客模式',local:'本机模式',loading:'读取中',cached:'使用缓存',ready:'已核对','not-connected':'未连接',failed:'读取失败','identity-changed':'身份待确认',cleared:'缓存已清理','library-changed':'学习库待确认'};
  const details:Partial<Record<AccountLoadStatus['phase'],string>>={
    ready:'题库读取已核对；写回状态另行确认',cached:'正在使用缓存，最新状态待核对',
    local:'当前使用本机学习方式','not-connected':'登录身份与题库启用分开',
    loading:'正在核对最新资料',failed:'已有记录保留，请重试',cleared:'原记录保留，可重新读取',
    'library-changed':'请确认要使用的学习库','identity-changed':'请重新确认登录身份',
  };
  return{label:labels[state.phase],detail:details[state.phase]??'正在确认状态',
    tone:state.phase==='ready'?'good':['failed','cached','library-changed','identity-changed'].includes(state.phase)?'warning':'muted'};
}

export function settingsCompanionConnection(input:{paired:boolean;detected:string;syncState:string}):SettingsStatus{
  if(input.detected!=='online')return{label:input.detected==='offline'?'离线':'尚未检测',detail:input.paired?'配对已保存，等待核对本机服务':'尚未确认本机服务可达',tone:'muted'};
  if(!input.paired)return{label:'在线，待配对',detail:'本机服务可达，尚未绑定学习空间',tone:'warning'};
  if(['connected','key_missing','provider_unavailable'].includes(input.syncState))return{label:'已连接',detail:'本机服务可达；AI 状态单独核对',tone:'good'};
  return{label:'可达，资料待核对',detail:'已配对，但资料读取尚未完成',tone:'warning'};
}

export function settingsAiConnection(input:{mode:'account'|'local';signedIn:boolean;accountAi:AccountAiSettingsResponse|null;accountAiFailed?:boolean;companionOnline:boolean;localStatus?:string}):SettingsStatus{
  if(input.mode==='account'){
    if(!input.signedIn)return{label:'需登录',detail:'账号 AI 使用独立配置',tone:'muted'};
    if(!input.accountAi)return{label:input.accountAiFailed?'暂无法核对':'待核对',detail:'登录并不代表已启用 AI',tone:input.accountAiFailed?'warning':'muted'};
    if(!input.accountAi.serverAvailable)return{label:'站点未启用',detail:'当前站点未提供账号 AI 服务',tone:'muted'};
    if(!input.accountAi.settings.configured)return{label:'待配置',detail:'尚未配置账号 AI',tone:'warning'};
    if(!input.accountAi.settings.enabled)return{label:'未启用',detail:'已有配置，但账号 AI 已关闭',tone:'muted'};
    return{label:'已启用',detail:'账号配置已核对，调用结果以当次反馈为准',tone:'good'};
  }
  if(!input.companionOnline)return{label:'本机离线',detail:'等待 Companion 恢复后核对本机 AI',tone:'muted'};
  if(input.localStatus==='connected')return{label:'已配置',detail:'本机配置已读取，调用结果以当次反馈为准',tone:'good'};
  if(input.localStatus==='provider_unavailable')return{label:'暂不可用',detail:'本机已返回 AI 服务不可用状态',tone:'warning'};
  if(input.localStatus==='key_missing')return{label:'待配置',detail:'需要在本机配置 AI',tone:'warning'};
  return{label:'待核对',detail:'尚无明确的本机 AI 状态',tone:'muted'};
}

export function countSettingsPractice(events:ReadonlyArray<{eventId:string;eventType:string}>,historyReady:boolean):number|null{
  if(!historyReady)return null;
  return new Set(events.filter(event=>event.eventType==='practice-attempt').map(event=>event.eventId)).size;
}

export type PendingSettingsSummary={total:number;uploads:number;writebacks:number;assistance:number};
type PendingSnapshot={complete:boolean;pending:{coreUploads:string[];coreWritebacks:string[];recovery:string[];assistance:string[];tasks:string[];legacyQueues:boolean};payload:{workspaceRecords:ReadonlyArray<{kind:string;value:unknown}>}};
export function settingsPendingSummary(value:PendingSnapshot):PendingSettingsSummary|null{
  if(!value.complete)return null;
  const p=value.pending,uploads=new Set([...p.coreUploads,...p.recovery,...p.tasks]);
  const legacy=value.payload.workspaceRecords.filter(row=>row.kind==='pending-activities'||row.kind==='cloud-outbox');
  let legacyEntries=0;
  for(const row of legacy){
    if(!Array.isArray(row.value))return null;
    for(const entry of row.value){
      if(!entry||typeof entry!=='object')return null;
      const id=typeof entry.eventId==='string'?entry.eventId:typeof entry.id==='string'?entry.id:null;
      if(!id)return null;
      uploads.add(id);legacyEntries++;
    }
  }
  if(p.legacyQueues&&!legacyEntries)return null;
  const writebacks=new Set(p.coreWritebacks),assistance=new Set(p.assistance);
  // Core/recovery/task IDs refer to records; auxiliary summaries are separate work.
  const total=new Set([...uploads,...writebacks].map(id=>'record:'+id));
  for(const id of assistance)total.add('assistance:'+id);
  return{total:total.size,uploads:uploads.size,writebacks:writebacks.size,assistance:assistance.size};
}
