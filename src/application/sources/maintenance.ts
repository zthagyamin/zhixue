export type RecoveryPack={
  complete:boolean;
  pending:{coreUploads:readonly string[];coreWritebacks:readonly string[];recovery:readonly string[];assistance:readonly string[];tasks:readonly string[];legacyQueues:boolean};
  payload:{accountLibraries:readonly {libraryId:string}[]};
};
export type RecoveryActionResult={status:'succeeded'|'partial'|'blocked'|'cancelled'|'stale'|'failed';message:string};
export type MaintenanceFrame={
  owner:string|null;ready:boolean;current:()=>boolean;pending:()=>boolean;buffers:()=>boolean;version:()=>unknown;
};
export type MaintenancePorts<Pack extends RecoveryPack>={
  capture:()=>MaintenanceFrame;confirm:(message:string)=>boolean;
  export:(owner:string)=>Promise<Pack>;download:(value:Pack)=>void;
  clearLibrary:(owner:string,library:string)=>Promise<unknown>;clearRead:()=>Promise<unknown>;clearWorkspace:(owner:string)=>Promise<unknown>;
  cancelRead:()=>void;pauseRead:()=>void;message:(message:string)=>void;
};
export const recoveryPending=(value:RecoveryPack)=>!value.complete||value.pending.legacyQueues||
  [value.pending.coreUploads,value.pending.coreWritebacks,value.pending.recovery,value.pending.assistance,value.pending.tasks].some(items=>items.length>0);
const stale=():RecoveryActionResult=>({status:'stale',message:'学习空间已变化，已忽略旧操作结果。'});

/** Only rebuildable views are passed to the clearing ports. Immutable histories have no deletion port. */
export function createSourceMaintenance<Pack extends RecoveryPack>(ports:MaintenancePorts<Pack>){
  let disposed=false;
  const current=(frame:MaintenanceFrame)=>!disposed&&frame.current();
  const respond=(frame:MaintenanceFrame,status:RecoveryActionResult['status'],message:string):RecoveryActionResult=>{
    if(!current(frame))return stale();ports.message(message);return{status,message};
  };
  async function exportData():Promise<RecoveryActionResult>{
    const frame=ports.capture();
    if(!frame.owner||!frame.ready||!current(frame))return{status:'blocked',message:'请先确认登录身份与本机存储，再导出恢复数据。'};
    if(frame.pending())return respond(frame,'blocked','请等待当前作答保存完成，再导出恢复数据。');
    try{
      const value=await ports.export(frame.owner);if(!current(frame))return stale();
      ports.download(value);
      return value.complete
        ?respond(frame,'succeeded','完整恢复数据包已生成并发起下载，请确认浏览器已保存文件。包含此账号各学习库的题目、记录与待同步摘要。')
        :respond(frame,'partial','已下载当前可读取的数据，但读取期间发生变化或仍缺少依赖；这不是完整恢复包，请稍后重新导出。');
    }catch{return respond(frame,'failed','恢复数据未能完整读取，未生成导出文件。已有记录未删除，请检查存储后重试。');}
  }
  async function clearCache(skipConfirm=false):Promise<RecoveryActionResult>{
    const frame=ports.capture(),version=frame.version();
    if(!frame.owner||!frame.ready||!current(frame))return{status:'blocked',message:'请先确认登录身份与本机存储，再清理读取缓存。'};
    if(frame.pending())return respond(frame,'blocked','当前作答正在处理，完成后再清理缓存。');
    if(!skipConfirm&&!ports.confirm('只清理这台浏览器可重建的读取视图。题库快照、学习记录、摘要、回执、规则和草稿保留，当前题面与输入也不清空。云端与 Obsidian 不会删除。继续吗？'))return{status:'cancelled',message:'已取消清理。'};
    const unchanged=()=>!frame.pending()&&frame.version()===version;
    const changed=()=>respond(frame,'blocked','当前作答或记录已变化，已停止后续缓存清理；所有学习记录保留。');
    try{
      const value=await ports.export(frame.owner);if(!current(frame))return stale();
      if(!unchanged())return changed();
      if(!value.complete||value.pending.coreUploads.length||value.pending.recovery.length||value.pending.tasks.length||value.pending.legacyQueues)
        return respond(frame,'blocked','仍有未上传记录或恢复数据尚未核对完整，已拒绝清理。请先导出并恢复网络同步。');
      ports.cancelRead();
      for(const library of value.payload.accountLibraries){
        if(!current(frame))return stale();if(!unchanged())return changed();
        await ports.clearLibrary(frame.owner,library.libraryId);
      }
      if(!current(frame))return stale();if(!unchanged())return changed();await ports.clearRead();
      if(!current(frame))return stale();if(!unchanged())return changed();await ports.clearWorkspace(frame.owner);
      if(!current(frame))return stale();ports.pauseRead();
      return respond(frame,'succeeded','读取视图已清理；当前题面、输入、所有学习记录与待写回摘要保留。点击刷新可重新读取资料。');
    }catch{return respond(frame,'failed','本机缓存清理未完整完成；请重试。原学习记录和云端历史未删除。');}
  }
  return{exportData,clearCache,dispose(){disposed=true;}};
}
