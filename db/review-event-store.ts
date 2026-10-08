import { and, asc, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { AppendOutcome, ReviewEventStore } from "../app/review-event-service";
import type { ReviewProjection } from "../app/review-projection";
import type { CloudDiagnostics, CloudReviewProjection, SequencedStudyEventV3, SyncV3Store } from "../app/sync-v3-api";
import type { StudyEventV3 } from "../app/study-event-v3";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { SCHEDULER_VERSION } from "../app/study-event-v3.ts";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import * as schema from "./schema.ts";

const { reviewProjections, studyEventsV3 } = schema;

type Database = DrizzleD1Database<typeof schema>;
type StudyEventRow = typeof studyEventsV3.$inferSelect;
type ProjectionRow = typeof reviewProjections.$inferSelect;

// Cloudflare D1 caps each query at 100 bound parameters. A projection lookup
// binds two parameters per (itemKind, itemKey) pair, so batches stay at 49 pairs.
const PROJECTION_BATCH_PAIRS = 49;

function eventValues(userId: string, event: StudyEventV3) {
  if (event.eventType === "review-baseline") {
    return {
      userId,
      eventId: event.eventId,
      coreHash: event.coreHash,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      domain: event.domain,
      eventType: event.eventType,
      itemKind: event.item.kind,
      itemKey: event.item.key,
      stateHandle: event.item.stateHandle ?? null,
      rating: null,
      correct: null,
      stageBefore: null,
      stageAfter: null,
      reviewedAt: null,
      schedulerVersion: event.schedulerVersion,
      clientProjectionJson: null,
      baselineJson: JSON.stringify(event.baselineState),
      receivedAt: new Date().toISOString(),
    };
  }
  return {
    userId,
    eventId: event.eventId,
    coreHash: event.coreHash,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    domain: event.domain,
    eventType: event.eventType,
    itemKind: event.item.kind,
    itemKey: event.item.key,
    stateHandle: event.item.stateHandle ?? null,
    rating: event.attempt.rating,
    correct: event.attempt.correct,
    stageBefore: event.attempt.stageBefore,
    stageAfter: event.attempt.stageAfter,
    reviewedAt: event.scheduling?.reviewedAt ?? null,
    schedulerVersion: event.scheduling?.schedulerVersion ?? null,
    clientProjectionJson: event.scheduling?.clientStateAfter === undefined
      ? null
      : JSON.stringify(event.scheduling.clientStateAfter),
    baselineJson: null,
    receivedAt: new Date().toISOString(),
  };
}

function eventFromRow(row: StudyEventRow): StudyEventV3 {
  const item = {
    kind: row.itemKind as StudyEventV3["item"]["kind"],
    key: row.itemKey,
    ...(row.stateHandle === null ? {} : { stateHandle: row.stateHandle }),
  };
  if (row.eventType === "review-baseline") {
    return {
      schemaVersion: row.schemaVersion as 3,
      eventId: row.eventId,
      coreHash: row.coreHash,
      occurredAt: row.occurredAt,
      domain: row.domain as StudyEventV3["domain"],
      eventType: "review-baseline",
      item,
      schedulerVersion: row.schedulerVersion as typeof SCHEDULER_VERSION,
      baselineState: JSON.parse(row.baselineJson ?? "null"),
    };
  }
  return {
    schemaVersion: row.schemaVersion as 3,
    eventId: row.eventId,
    coreHash: row.coreHash,
    occurredAt: row.occurredAt,
    domain: row.domain as StudyEventV3["domain"],
    eventType: "practice-attempt",
    item,
    attempt: {
      rating: row.rating as "again" | "hard" | "good" | "easy",
      correct: row.correct === null ? false : row.correct,
      stageBefore: row.stageBefore ?? 0,
      stageAfter: row.stageAfter ?? 0,
    },
    ...(row.reviewedAt === null
      ? {}
      : {
          scheduling: {
            reviewedAt: row.reviewedAt,
            schedulerVersion: row.schedulerVersion as typeof SCHEDULER_VERSION,
            ...(row.clientProjectionJson === null
              ? {}
              : { clientStateAfter: JSON.parse(row.clientProjectionJson) }),
          },
        }),
  } as StudyEventV3;
}

function projectionValues(userId: string, itemKind: string, projection: ReviewProjection) {
  return {
    userId,
    itemKind,
    itemKey: projection.itemKey,
    fsrsJson: JSON.stringify(projection.fsrs),
    dueAt: projection.dueAt,
    schedulerVersion: projection.schedulerVersion,
    appliedEventCount: projection.appliedEventCount,
    eventSetHash: projection.eventSetHash,
    lastReviewedAt: projection.lastReviewedAt ?? null,
    source: projection.source,
    updatedAt: new Date().toISOString(),
  };
}

function projectionFromRow(row: ProjectionRow): ReviewProjection {
  return {
    itemKey: row.itemKey,
    fsrs: JSON.parse(row.fsrsJson),
    dueAt: row.dueAt,
    schedulerVersion: row.schedulerVersion as typeof SCHEDULER_VERSION,
    appliedEventCount: row.appliedEventCount,
    eventSetHash: row.eventSetHash,
    ...(row.lastReviewedAt === null ? {} : { lastReviewedAt: row.lastReviewedAt }),
    source: row.source as ReviewProjection["source"],
  };
}

function cloudProjectionFromRow(row: ProjectionRow): CloudReviewProjection {
  return { itemKind: row.itemKind, ...projectionFromRow(row) };
}

export class D1ReviewEventStore implements SyncV3Store {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async appendEvent(userId: string, event: StudyEventV3): Promise<AppendOutcome> {
    const existing = await this.database
      .select({ coreHash: studyEventsV3.coreHash })
      .from(studyEventsV3)
      .where(and(eq(studyEventsV3.userId, userId), eq(studyEventsV3.eventId, event.eventId)))
      .limit(1);
    if (existing[0] !== undefined) {
      return existing[0].coreHash === event.coreHash ? "duplicate" : "conflict";
    }

    const inserted = await this.database
      .insert(studyEventsV3)
      .values(eventValues(userId, event))
      .onConflictDoNothing()
      .returning({ sequence: studyEventsV3.sequence });
    if (inserted.length > 0) return "inserted";

    // A concurrent request inserted the same event id between our read and write;
    // the unique (user_id, event_id) index makes this deterministic.
    const raced = await this.database
      .select({ coreHash: studyEventsV3.coreHash })
      .from(studyEventsV3)
      .where(and(eq(studyEventsV3.userId, userId), eq(studyEventsV3.eventId, event.eventId)))
      .limit(1);
    return raced[0] === undefined ? "inserted" : raced[0].coreHash === event.coreHash ? "duplicate" : "conflict";
  }

  async listItemEvents(userId: string, itemKind: string, itemKey: string): Promise<StudyEventV3[]> {
    const rows = await this.database
      .select()
      .from(studyEventsV3)
      .where(and(
        eq(studyEventsV3.userId, userId),
        eq(studyEventsV3.itemKind, itemKind),
        eq(studyEventsV3.itemKey, itemKey),
      ))
      .orderBy(asc(studyEventsV3.sequence));
    return rows.map(eventFromRow);
  }

  async upsertProjection(userId: string, itemKind: string, projection: ReviewProjection): Promise<ReviewProjection> {
    const existing = await this.database
      .select()
      .from(reviewProjections)
      .where(and(
        eq(reviewProjections.userId, userId),
        eq(reviewProjections.itemKind, itemKind),
        eq(reviewProjections.itemKey, projection.itemKey),
      ))
      .limit(1);
    const persisted = existing[0];
    if (persisted !== undefined) {
      if (persisted.appliedEventCount > projection.appliedEventCount) return projectionFromRow(persisted);
      if (persisted.appliedEventCount === projection.appliedEventCount) {
        if (persisted.eventSetHash === projection.eventSetHash) return projectionFromRow(persisted);
        throw new Error("projection-event-set-conflict");
      }
    }

    const values = projectionValues(userId, itemKind, projection);
    await this.database
      .insert(reviewProjections)
      .values(values)
      .onConflictDoUpdate({
        target: [reviewProjections.userId, reviewProjections.itemKind, reviewProjections.itemKey],
        set: {
          fsrsJson: sql`excluded.fsrs_json`,
          dueAt: sql`excluded.due_at`,
          schedulerVersion: sql`excluded.scheduler_version`,
          appliedEventCount: sql`excluded.applied_event_count`,
          eventSetHash: sql`excluded.event_set_hash`,
          lastReviewedAt: sql`excluded.last_reviewed_at`,
          source: sql`excluded.source`,
          updatedAt: sql`excluded.updated_at`,
        },
        // Atomic guard: a stale concurrent replay can never regress a newer
        // persisted stock. A no-op here means another replica won; the read
        // below returns that canonical projection instead.
        setWhere: sql`excluded.applied_event_count > ${reviewProjections.appliedEventCount}`,
      });

    // Re-read and apply the same canonical rule: whichever writer actually
    // persisted, the caller receives the durable projection, never a guess.
    const after = await this.database
      .select()
      .from(reviewProjections)
      .where(and(
        eq(reviewProjections.userId, userId),
        eq(reviewProjections.itemKind, itemKind),
        eq(reviewProjections.itemKey, projection.itemKey),
      ))
      .limit(1);
    const winner = after[0]!;
    if (winner.appliedEventCount > projection.appliedEventCount) return projectionFromRow(winner);
    if (winner.appliedEventCount === projection.appliedEventCount) {
      if (winner.eventSetHash === projection.eventSetHash) return projectionFromRow(winner);
      throw new Error("projection-event-set-conflict");
    }
    return projectionFromRow(winner);
  }

  async latestCursor(userId: string): Promise<number> {
    const rows = await this.database
      .select({ sequence: studyEventsV3.sequence })
      .from(studyEventsV3)
      .where(eq(studyEventsV3.userId, userId))
      .orderBy(desc(studyEventsV3.sequence))
      .limit(1);
    return rows[0]?.sequence ?? 0;
  }

  async listEventsAfter(userId: string, after: number, limit: number,through?:number): Promise<SequencedStudyEventV3[]> {
    const rows = await this.database
      .select()
      .from(studyEventsV3)
      .where(and(eq(studyEventsV3.userId, userId), gt(studyEventsV3.sequence, after),through===undefined?undefined:lte(studyEventsV3.sequence,through)))
      .orderBy(asc(studyEventsV3.sequence))
      .limit(limit);
    return rows.map((row) => ({ sequence: row.sequence, event: eventFromRow(row) }));
  }

  async listProjections(
    userId: string,
    items: ReadonlyArray<{ itemKind: string; itemKey: string }>,
  ): Promise<CloudReviewProjection[]> {
    const projections: CloudReviewProjection[] = [];
    for (let index = 0; index < items.length; index += PROJECTION_BATCH_PAIRS) {
      const batch = items.slice(index, index + PROJECTION_BATCH_PAIRS);
      const rows = await this.database
        .select()
        .from(reviewProjections)
        .where(and(
          eq(reviewProjections.userId, userId),
          or(...batch.map((item) => and(
            eq(reviewProjections.itemKind, item.itemKind),
            eq(reviewProjections.itemKey, item.itemKey),
          ))),
        ));
      projections.push(...rows.map(cloudProjectionFromRow));
    }
    return projections;
  }

  async diagnostics(userId: string): Promise<CloudDiagnostics> {
    const events = await this.database
      .select({ sequence: studyEventsV3.sequence, receivedAt: studyEventsV3.receivedAt })
      .from(studyEventsV3)
      .where(eq(studyEventsV3.userId, userId))
      .orderBy(desc(studyEventsV3.sequence))
      .limit(1);
    const eventCountRow = await this.database
      .select({ count: sql<number>`count(*)` })
      .from(studyEventsV3)
      .where(eq(studyEventsV3.userId, userId));
    const sourceRows = await this.database
      .select({ source: reviewProjections.source, count: sql<number>`count(*)` })
      .from(reviewProjections)
      .where(eq(reviewProjections.userId, userId))
      .groupBy(reviewProjections.source);
    const sourceCounts: CloudDiagnostics["sourceCounts"] = { rebuilt: 0, "legacy-baseline": 0 };
    for (const row of sourceRows) {
      if (row.source === "rebuilt" || row.source === "legacy-baseline") sourceCounts[row.source] = row.count;
    }
    return {
      cursor: events[0]?.sequence ?? 0,
      eventCount: eventCountRow[0]?.count ?? 0,
      ...(events[0] === undefined ? {} : { lastAckAt: events[0].receivedAt }),
      sourceCounts,
      schedulerVersion: SCHEDULER_VERSION,
    };
  }
}

export type { ReviewEventStore };
