import { and, asc, eq, sql } from 'drizzle-orm';
// @ts-expect-error TS5097: standalone Node contracts.
import { learningAccounts, learningEvents, learningItemStates, learningProgressMigrations, type StudyDatabase } from '../database/index.ts';
import type { CloudLearningEvent, CloudSyncSnapshot } from '../../domain/sync';
import type { CloudProgress } from '../../domain/evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseProgress } from '../../domain/sync/index.ts';
export function createLegacySyncD1(getDb: () => StudyDatabase, now: () => Date = () => new Date()) {
    const emptyProgress: CloudProgress = { itemStages: {}, answered: 0, correct: 0 };
    async function ensureAccount(userId: string) {
        const database = getDb();
        await database.insert(learningAccounts).values({ userId }).onConflictDoUpdate({
            target: learningAccounts.userId,
            set: { updatedAt: sql `CURRENT_TIMESTAMP` },
        });
    }
    async function readSnapshot(userId: string): Promise<CloudSyncSnapshot> {
        const database = getDb();
        const [migrations, events] = await Promise.all([
            database.select({ progressJson: learningProgressMigrations.progressJson }).from(learningProgressMigrations).where(eq(learningProgressMigrations.userId, userId)).limit(1),
            database.select({
                sequence: learningEvents.sequence,
                itemKind: learningEvents.itemKind,
                itemKey: learningEvents.itemKey,
                outcome: learningEvents.outcome,
                numericValue: learningEvents.numericValue,
                answeredDelta: learningEvents.answeredDelta,
                correctDelta: learningEvents.correctDelta,
            }).from(learningEvents).where(eq(learningEvents.userId, userId)).orderBy(asc(learningEvents.sequence)),
        ]);
        const migrated = migrations[0] ? parseProgress(JSON.parse(migrations[0].progressJson)) : null;
        const progress: CloudProgress = migrated ? {
            itemStages: { ...(migrated.itemStages || {}) },
            answered: migrated.answered,
            correct: migrated.correct,
            // Approved legacy FSRS state is returned to the browser so the client can
            // create user-approved v3 review-baseline events; it is never written
            // directly into review_projections.
            ...(migrated.fsrsData ? { fsrsData: migrated.fsrsData } : {}),
        } : { ...emptyProgress, itemStages: {} };
        for (const event of events) {
            progress.answered += event.answeredDelta;
            progress.correct += event.correctDelta;
            if (event.numericValue !== undefined && event.numericValue !== null) {
                progress.itemStages[event.itemKey] = event.numericValue;
            }
        }
        return {
            hasProgress: migrations.length > 0 || events.length > 0,
            cursor: events.at(-1)?.sequence ?? 0,
            progress,
            syncedAt: now().toISOString(),
        };
    }
    async function applyItemState(userId: string, event: CloudLearningEvent, eventSequence: number) {
        if (event.itemKind === "activity")
            return;
        if (event.itemKind === "python" && event.outcome !== "completed")
            return;
        const database = getDb();
        const numericValue = event.numericValue ?? (event.outcome === "completed" ? 1 : 0);
        const state = event.itemKind === "word"
            ? numericValue >= 3 ? "completed" : numericValue === 0 ? "needs-review" : "in-progress"
            : event.itemKind === "due"
                ? event.outcome === "completed" ? "stable" : "needs-review"
                : "completed";
        await database.insert(learningItemStates).values({ userId, itemKind: event.itemKind, itemKey: event.itemKey, numericValue, state, lastEventSequence: eventSequence }).onConflictDoUpdate({
            target: [learningItemStates.userId, learningItemStates.itemKind, learningItemStates.itemKey],
            set: {
                numericValue,
                state,
                version: sql `${learningItemStates.version} + 1`,
                lastEventSequence: eventSequence,
                updatedAt: sql `CURRENT_TIMESTAMP`,
                deletedAt: null,
            },
            setWhere: sql `${learningItemStates.lastEventSequence} < ${eventSequence}`,
        });
    }
    async function applyEvent(userId: string, event: CloudLearningEvent) {
        const database = getDb();
        const inserted = await database.insert(learningEvents).values({
            eventId: event.eventId,
            userId,
            domain: event.domain,
            itemKind: event.itemKind,
            itemKey: event.itemKey,
            eventType: event.eventType,
            outcome: event.outcome,
            numericValue: event.numericValue,
            answeredDelta: event.answeredDelta ?? 0,
            correctDelta: event.correctDelta ?? 0,
            occurredAt: event.occurredAt,
        }).onConflictDoNothing().returning({ sequence: learningEvents.sequence });
        const eventSequence = inserted[0]?.sequence ?? (await database.select({ sequence: learningEvents.sequence }).from(learningEvents).where(and(eq(learningEvents.userId, userId), eq(learningEvents.eventId, event.eventId))).limit(1))[0]?.sequence;
        if (eventSequence !== undefined) {
            try {
                await applyItemState(userId, event, eventSequence);
            }
            catch {
                // The append-only event remains authoritative; readSnapshot rebuilds progress from events.
            }
        }
        return inserted.length > 0;
    }
    async function migrateProgress(userId: string, progress: CloudProgress, migrationEventId: string) {
        const database = getDb();
        const existing = await readSnapshot(userId);
        if (existing.hasProgress)
            return null;
        try {
            await database.batch([
                database.insert(learningProgressMigrations).values({ userId, migrationEventId, progressJson: JSON.stringify(progress) }),
                database.insert(learningEvents).values({ eventId: migrationEventId, userId, domain: "ielts", itemKind: "activity", itemKey: "legacy-indexeddb-progress", eventType: "activity", outcome: "completed", occurredAt: now().toISOString() }),
            ]);
        }
        catch {
            return null;
        }
        return readSnapshot(userId);
    }
    return { ensureAccount, readSnapshot, applyEvent, migrateProgress };
}
