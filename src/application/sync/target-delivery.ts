import type {CloudBatchResult,CompanionActivityResult,DeliveryTarget,DeliveryState,LocalStudyEventRecord,ProjectionMismatch} from '../../domain/sync';
import type {StudyEventV3,LocalEventContext} from '../../domain/evidence';
// @ts-expect-error TS5097: standalone Node source contracts.
import {isDurableCompanionAck} from '../../domain/sync/index.ts';
export type FlushTargetsDependencies = {
  listPending: (workspaceId: string) => Promise<LocalStudyEventRecord[]>;
  sendCloud: (event: StudyEventV3) => Promise<CloudBatchResult>;
  sendCompanion: (payload: { event: StudyEventV3; localContext?: LocalEventContext }) => Promise<CompanionActivityResult>;
  updateDelivery: (workspaceId: string, eventId: string, target: DeliveryTarget, status: DeliveryState) => Promise<void>;
};


/**
 * Drains pending v3 events toward their targets, updating exactly one receipt
 * per target. Per-event results are parsed even when the batch returns 409:
 * only listed conflicts become conflicts, accepted and duplicate ids become
 * acknowledged, an error-body 409 acknowledges the persisted batch with a
 * diagnostic mismatch, and network failures stay pending.
 */
export async function flushStudyEventTargets(
  workspaceId: string,
  dependencies: FlushTargetsDependencies,
): Promise<{ deliveries: LocalStudyEventRecord[]; projectionMismatches: ProjectionMismatch[] }> {
  const pending = await dependencies.listPending(workspaceId);
  const deliveries: LocalStudyEventRecord[] = [];
  const projectionMismatches: ProjectionMismatch[] = [];

  for (const record of pending) {
    const delivery = { ...record };

    if (delivery.cloud === "pending") {
      try {
        const result = await dependencies.sendCloud(delivery.event);
        if (result.error !== undefined) {
          // A 409 error body means the server already persisted the batch; the
          // client refetches the canonical projection and records a mismatch.
          await dependencies.updateDelivery(workspaceId, delivery.eventId, "cloud", "acked");
          if (result.error === "projection-event-set-conflict") {
            projectionMismatches.push({ eventId: delivery.eventId, itemKey: delivery.event.item.key, serverDueAt: "" });
          }
        } else {
          const acknowledged = (result.accepted ?? []).includes(delivery.eventId)
            || (result.duplicates ?? []).includes(delivery.eventId);
          const conflict = (result.conflicts ?? []).find((entry) => entry.eventId === delivery.eventId);
          if (conflict !== undefined) {
            await dependencies.updateDelivery(workspaceId, delivery.eventId, "cloud", "conflict");
            delivery.cloud = "conflict";
          } else if (acknowledged) {
            await dependencies.updateDelivery(workspaceId, delivery.eventId, "cloud", "acked");
            delivery.cloud = "acked";
          }
          const clientState = delivery.event.eventType === "practice-attempt"
            ? delivery.event.scheduling?.clientStateAfter
            : undefined;
          const projection = (result.projections ?? []).find((entry) => entry.itemKey === delivery.event.item.key);
          if (clientState !== undefined && projection !== undefined && projection.dueAt !== clientState.due) {
            projectionMismatches.push({
              eventId: delivery.eventId,
              itemKey: delivery.event.item.key,
              serverDueAt: projection.dueAt,
              localDueAt: clientState.due,
            });
          }
        }
      } catch {
        // Network failure: the receipt stays pending for the next flush.
      }
    }

    if (delivery.companion === "pending") {
      try {
        const result = await dependencies.sendCompanion({
          event: delivery.event,
          localContext: delivery.localContext,
        });
        if (result.status === "conflict") {
          // The Companion already accepted a different immutable event under
          // this id; mark the receipt conflicted so the outbox stops retrying.
          await dependencies.updateDelivery(workspaceId, delivery.eventId, "companion", "conflict");
          delivery.companion = "conflict";
        } else if (isDurableCompanionAck(result)) {
          await dependencies.updateDelivery(workspaceId, delivery.eventId, "companion", "acked");
          delivery.companion = "acked";
        }
      } catch {
        // Network failure: the receipt stays pending for the next flush.
      }
    }

    deliveries.push(delivery);
  }

  return { deliveries, projectionMismatches };
}
