export type CompanionSourcePayload={status:string;message?:string;subjects?:unknown[];gateway?:{mode?:string}};
export const COMPANION_READ_MESSAGES={
  loading:'Companion 已连接，正在读取学习资料…',
  local:'Companion 已连接，本机资料已读取。',
  account:'Companion 已连接；账号题库与写回进度请在连接概览单独核对。',
  status:'Companion 已连接；资料与 AI 状态请查看连接概览。',
  failed:'读取本机资料暂时失败，将自动重试；也可检查 Companion 窗口后重新检测。',
};
export function updateCompanionReadMessage(current:string,next:string){return Object.values(COMPANION_READ_MESSAGES).includes(current)?next:current;}
export function usableCompanionSource(value:CompanionSourcePayload):boolean{return Array.isArray(value.subjects)&&Boolean(value.subjects.length||value.gateway?.mode==='indexed');}
