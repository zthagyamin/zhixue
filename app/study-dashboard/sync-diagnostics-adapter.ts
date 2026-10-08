import {getLocalStudyEventDiagnostics} from '../local-study-events';
import type {CloudSyncMetadata} from '../cloud-sync-types';
import type {CompanionSession} from './prelude';
import type {ReviewDiagnostics} from '../review-diagnostics';
export async function readSyncDiagnostics(workspaceId:string,companionSession:CompanionSession|null,companionUrl:string,companionHeaders:Record<string,string>,cloudSyncMetadata:CloudSyncMetadata,fetcher:typeof fetch=fetch):Promise<ReviewDiagnostics>{
      const [local, cloud, companion] = await Promise.all([
        getLocalStudyEventDiagnostics(workspaceId),
        fetcher("/api/sync?diagnostics=1", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return null;
          return response.json() as Promise<{ cursor: number; eventCount: number; lastAckAt?: string; sourceCounts: { rebuilt: number; "legacy-baseline": number }; schedulerVersion: string }>;
        }),
        companionSession
          ? fetcher(`${companionUrl}/v1/diagnostics`, { headers: companionHeaders, signal: AbortSignal.timeout(2500) }).then(async (response) => {
              if (!response.ok) return null;
              return response.json() as Promise<{ eventCount: number; eventSetHash: string; duplicateCount: number; conflictCount: number; latestAcceptedAt?: string; schedulerVersion: string }>;
            })
          : Promise.resolve(null),
      ]);
      const v3 = cloudSyncMetadata.v3;
      const projectionMismatchCount = v3?.projectionMismatchCount ?? 0;
      return {
        localEventCount: local.total,
        localPending: local.pendingCloud + local.pendingCompanion,
        cloudBehind: cloud !== null && v3 !== undefined && cloud.cursor > (v3.cursor ?? 0),
        conflicts: local.conflicts,
        projectionMismatchCount,
        source: cloud === null || (cloud.sourceCounts.rebuilt === 0 && cloud.sourceCounts["legacy-baseline"] === 0)
          ? undefined
          : cloud.sourceCounts["legacy-baseline"] > 0 ? "legacy-baseline" : "rebuilt",
        cloudCursor: cloud?.cursor,
        schedulerVersion: cloud?.schedulerVersion ?? companion?.schedulerVersion,
        companionEventSetHash: companion?.eventSetHash,
        companionConflictCount: companion?.conflictCount,
        companionDuplicateCount: companion?.duplicateCount,
      };
}
