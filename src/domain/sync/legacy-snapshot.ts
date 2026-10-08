import type {CloudProgress} from '../evidence';
import type {CloudLearningEvent,CloudSyncMetadata,CloudSyncSnapshot} from './cloud-contracts';
// @ts-expect-error TS5097: standalone Node contracts.
import {applyCloudEvents,hasProgressData} from './legacy-progress.ts';
type Input={progress:CloudProgress;events:CloudLearningEvent[];metadata:CloudSyncMetadata;overlay:Pick<CloudProgress,'itemStages'|'fsrsData'>|null};
type View={progress?:CloudProgress;metadata:CloudSyncMetadata;status:'synced'|'local-only'|'needs-migration';message:string};
export function restoreLegacySnapshot(snapshot:CloudSyncSnapshot,input:Input,kind:'initial'|'migrate'='initial',conflict=false):View{
  const overlay=(value:CloudProgress):CloudProgress=>({...value,itemStages:{...value.itemStages,...input.overlay?.itemStages},fsrsData:{...value.fsrsData,...input.overlay?.fsrsData}});
  if(kind==='migrate')return{progress:overlay(snapshot.progress),metadata:{decision:'enabled',cursor:snapshot.cursor,lastSyncedAt:snapshot.syncedAt},status:'synced',
    message:conflict?'云端已有进度，已安全恢复云端版本，没有覆盖。':'本地进度已经迁移；原始资料没有上传。'};
  if(snapshot.hasProgress)return{progress:overlay(applyCloudEvents(snapshot.progress,input.events)),metadata:{...input.metadata,decision:'enabled',cursor:snapshot.cursor,lastSyncedAt:input.events.length?input.metadata.lastSyncedAt:snapshot.syncedAt},status:'synced',
    message:input.events.length?`${input.events.length} 条事件等待每日同步；也可以立即同步。`:'已恢复此账号的云端学习进度。'};
  if(input.metadata.decision==='local-only')return{metadata:input.metadata,status:'local-only',message:'这台设备继续使用本地进度，不会上传学习记录。'};
  if(hasProgressData(input.progress))return{metadata:{...input.metadata,decision:'pending',cursor:snapshot.cursor},status:'needs-migration',message:'发现这台设备已有学习进度。确认后才会上传到你的云端空间。'};
  return{metadata:{decision:'enabled',cursor:snapshot.cursor,lastSyncedAt:snapshot.syncedAt},status:'synced',message:'云同步已就绪；以后产生的学习进度会跨设备保存。'};
}
