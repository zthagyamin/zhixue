/** Readability/support is not a delivery receipt. Never infer an ACK from a download. */
export function manualSyncResult(supported:boolean,snapshot:{complete:boolean;pending:{coreUploads:readonly string[];coreWritebacks:readonly string[];recovery:readonly string[];assistance:readonly string[];tasks:readonly string[];legacyQueues:boolean}}){
 const p=snapshot.pending;
 const outstanding=p.coreUploads.length+p.coreWritebacks.length+p.recovery.length+p.assistance.length+p.tasks.length;
 const complete=supported&&snapshot.complete&&!p.legacyQueues&&outstanding===0;
 const states=[`云端待接收 ${p.coreUploads.length} 条`,`本地助手待确认 ${p.coreWritebacks.length} 条`];
 if(p.assistance.length)states.push(`摘要待写回 ${p.assistance.length} 条`);
 if(p.recovery.length)states.push(`本机待恢复 ${p.recovery.length} 条`);
 if(p.tasks.length)states.push(`任务待同步 ${p.tasks.length} 条`);
 if(p.legacyQueues)states.push('旧版队列仍待处理');
 return {complete,status:complete?'synced' as const:'error' as const,message:complete?'已检查云端与本机回执，当前待同步队列为空。':`${supported?'已检查云端记录':'云端读取尚未确认'}；${states.join('；')}。${snapshot.complete?'':'部分状态尚未完整核对。'}本机记录保留，可稍后重试。`};
}
