// @ts-expect-error TS5097: standalone Node source contracts.
import {studyId} from '../sync/index.ts';


export type StudyIdentity={userId:string;displayName:string;email:string};

export type AccountLoadStatus={phase:'idle'|'guest'|'local'|'loading'|'cached'|'ready'|'not-connected'|'failed'|'identity-changed'|'cleared'|'library-changed';hasCache?:boolean;deferred?:boolean;message?:string;checkedAt?:string};

/** Background checks must not insert a transient banner above active learning controls. */
export function accountReadNoticePlacement(state:AccountLoadStatus,hasVisibleSource:boolean):'above'|'details'{
  if(state.deferred)return 'above';
  return state.phase==='ready'||hasVisibleSource&&(state.phase==='loading'||state.phase==='cached')?'details':'above';
}

export function accountLoadError(error:unknown):string{
  const code=error instanceof Error?error.message:'';
  if(code==='account-library-changed'||code==='library-mismatch')return '账号关联的学习库已变化。请先确认要使用的学习库，当前资料未被替换。';
  if(code==='account-mismatch'||code==='authentication-required')return '账号身份已变化，请重新确认登录后继续。';
  if(code.includes('cache')||code.includes('quota')||code.includes('storage'))return '本机资料缓存暂不可用。原有学习记录未删除，请检查存储后重试。';
  return '最新资料暂时无法完整读取。已保存的资料和作答仍保留，请稍后重试。';
}

export function accountLoadLabel(state:AccountLoadStatus):string{
  return state.phase==='library-changed'?'需要确认学习库':state.phase==='cleared'?'读取缓存已清理':state.phase==='ready'?'账号资料已更新':state.phase==='cached'||state.phase==='failed'&&state.hasCache?'使用完整缓存':state.phase==='loading'?'正在读取账号资料':state.phase==='not-connected'?'账号题库 · 尚未连接':state.phase==='identity-changed'?'需要确认账号':state.phase==='failed'?'账号资料读取失败':state.phase==='local'?'已选择本机模式':state.phase==='guest'?'游客本机模式':'正在确认账号资料';
}

export function accountLoadDetail(state:AccountLoadStatus):string{
  if(state.message)return state.message;
  if(state.phase==='cleared')return '当前题面、输入、学习记录和待写回摘要仍保留。点击刷新可重新读取账号资料。';
  if(state.deferred)return '最新资料已获取，当前练习保持原题面与进度；返回今日页后更新。';
  if(state.phase==='cached')return '正在使用已完整保存的资料，并检查账号中的最新变化。';
  if(state.phase==='ready')return '题目、计划操作与学习记录已完整核对。作答接收和 Obsidian 写回分别确认。';
  if(state.phase==='not-connected')return '这个账号还没有发布学习题库，属于正常的初始状态。在电脑连接 Companion 并启用账号题库后，这里会显示你自己的资料；现在可以先按公开示例学习。';
  if(state.phase==='local')return '保留你选择的本机学习方式，不自动读取账号题库。';
  return '身份确认后，才会读取这个账号的个人缓存。';
}
export function parseStudyIdentity(value:unknown):StudyIdentity|null{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('study-identity-invalid');const {authenticated,user}=value as {authenticated?:unknown;user?:unknown};
  if(authenticated===false&&user===null)return null;
  if(authenticated!==true||!user||typeof user!=='object'||Array.isArray(user))throw new Error('study-identity-invalid');
  const identity=user as StudyIdentity;
  try{studyId(identity.userId,'identity');if(typeof identity.displayName!=='string'||typeof identity.email!=='string')throw new Error();}catch{throw new Error('study-identity-invalid');}
  return {userId:identity.userId,displayName:identity.displayName,email:identity.email};
}
