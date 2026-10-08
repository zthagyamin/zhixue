// @ts-expect-error TS5097: direct Node regression execution.
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db.ts';
// @ts-expect-error TS5097: direct Node regression execution.
import {makeTrialMaterialBackup,readTrialMaterialBackup,mergeTrialMaterialBackup,trialMaterialRecordKind} from './trial-material-backup-model.ts';
export async function exportTrialMaterialBackup(owner:string,library:string){return makeTrialMaterialBackup(owner,library,await loadWorkspaceRecord(owner,trialMaterialRecordKind(library),[]));}
export async function restoreTrialMaterialBackup(owner:string,library:string,raw:unknown,isCurrent=()=>true){
 const incoming=await readTrialMaterialBackup(raw,owner,library),kind=trialMaterialRecordKind(library);
 if(!isCurrent())throw new Error('已离开原学习库，没有执行恢复。');
 await updateWorkspaceRecord<unknown>(owner,kind,[],current=>{if(!isCurrent())throw new Error('学习库已变化，未修改新空间。');return mergeTrialMaterialBackup(current,incoming);});
 const readback=await loadWorkspaceRecord<unknown>(owner,kind,[]),verified=mergeTrialMaterialBackup([],readback);
 if(incoming.some(item=>!verified.some(stored=>JSON.stringify(stored)===JSON.stringify(item))))throw new Error('材料恢复尚未核对，请重新读取；原文件保留。');
 return incoming.length;
}
