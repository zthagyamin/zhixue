import {loadWorkspaceRecord,migrateLegacyLocalStorage} from '../local-study-db';
import {companionSessionRecordKey} from '../companion-endpoint';
import {type CompanionSession,type PendingActivity,emptyProgress,emptyCloudSyncMetadata,pendingActivityKey,companionUrl} from './prelude';
import type {CloudLearningEvent,CloudSyncMetadata} from '../cloud-sync-types';
import {type PluginOverrides,emptyPluginOverrides} from '../plugin-routing';
import type {ModuleSummary} from '../dynamic-ui-model';
export async function readWorkspaceSource(nextWorkspaceId:string){
        const [savedProgress, savedPending, savedCompanion, savedCloudOutbox, savedCloudMetadata, savedPluginOverrides, savedModuleCatalog,savedAccountPreference,savedAccountDevice] = await Promise.all([
          migrateLegacyLocalStorage(nextWorkspaceId, "study-loop-progress-v3", "progress", emptyProgress),
          migrateLegacyLocalStorage<PendingActivity[]>(nextWorkspaceId, pendingActivityKey, "pending-activities", []),
          (async()=>{const scoped=await loadWorkspaceRecord<{session:CompanionSession|null}|null>(nextWorkspaceId,companionSessionRecordKey(companionUrl),null);return scoped?scoped.session:await loadWorkspaceRecord<CompanionSession|null>(nextWorkspaceId,'companion-session',null);})(),
          loadWorkspaceRecord<CloudLearningEvent[]>(nextWorkspaceId, "cloud-outbox", []),
          loadWorkspaceRecord<CloudSyncMetadata>(nextWorkspaceId, "cloud-sync-metadata", emptyCloudSyncMetadata),
          loadWorkspaceRecord<PluginOverrides>(nextWorkspaceId, "plugin-overrides", emptyPluginOverrides),
          loadWorkspaceRecord<ModuleSummary[]>(nextWorkspaceId, "module-catalog", []),
          loadWorkspaceRecord<string|boolean>(nextWorkspaceId,"account-study-preference",'auto'),
          loadWorkspaceRecord<string>(nextWorkspaceId,"account-study-device",''),
        ]);

 return{savedProgress,savedPending,savedCompanion,savedCloudOutbox,savedCloudMetadata,savedPluginOverrides,savedModuleCatalog,savedAccountPreference,savedAccountDevice};
}
