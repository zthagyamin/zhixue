import type { CloudLearningEvent, CloudSyncSnapshot } from '../../domain/sync';
import type { CloudProgress } from '../../domain/evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseProgress, parseEvent, safeText } from '../../domain/sync/index.ts';
export interface LegacySyncPersistence {
    ensureAccount(owner: string): Promise<void>;
    readSnapshot(owner: string): Promise<CloudSyncSnapshot>;
    applyEvent(owner: string, event: CloudLearningEvent): Promise<boolean>;
    migrateProgress(owner: string, progress: CloudProgress, id: string): Promise<CloudSyncSnapshot | null>;
}
export type LegacySyncResult = {
    value: unknown;
    status: number;
};
export function createLegacySyncRequests(store: LegacySyncPersistence) {
    return { async snapshot(owner: string): Promise<LegacySyncResult> { await store.ensureAccount(owner); return { value: await store.readSnapshot(owner), status: 200 }; },
        async migrate(owner: string, body: Record<string, unknown>): Promise<LegacySyncResult> {
            await store.ensureAccount(owner);
            const progress = parseProgress(body.progress), id = safeText(body.migrationEventId, 160);
            if (!progress || !id)
                return { value: { message: '本地进度格式无效。' }, status: 400 };
            const migrated = await store.migrateProgress(owner, progress, id);
            if (!migrated)
                return { value: { message: '云端已有进度，未覆盖现有数据。', snapshot: await store.readSnapshot(owner) }, status: 409 };
            return { value: { migrated: true, snapshot: migrated }, status: 200 };
        }, async events(owner: string, body: Record<string, unknown>): Promise<LegacySyncResult> {
            await store.ensureAccount(owner);
            if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 50)
                return { value: { message: '学习事件数量无效。' }, status: 400 };
            const events = body.events.map(parseEvent);
            if (events.some(event => !event))
                return { value: { message: '学习事件格式无效。' }, status: 400 };
            const acceptedEventIds: string[] = [];
            for (const event of events as CloudLearningEvent[])
                if (await store.applyEvent(owner, event))
                    acceptedEventIds.push(event.eventId);
            return { value: { acceptedEventIds, processedEventIds: (events as CloudLearningEvent[]).map(event => event.eventId), snapshot: await store.readSnapshot(owner) }, status: 200 };
        } };
}
