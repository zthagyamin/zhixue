import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { drizzle } from "drizzle-orm/d1";

import { summarizeReplicaState } from "../app/review-diagnostics.ts";
import { processStudyEventBatch } from "../app/review-event-service.ts";
import { SCHEDULER_VERSION, withStudyEventCoreHash } from "../app/study-event-v3.ts";
import * as schema from "../db/schema.ts";
import {readDashboardSource} from './helpers/dashboard-source.mjs';

const storeModule = await import("../db/review-event-store.ts").catch(() => ({}));
const D1ReviewEventStore = storeModule.D1ReviewEventStore;

function plainRow(row) {
  return Object.fromEntries(Object.entries(row));
}

class SqliteD1Statement {
  constructor(database, query, parameters = []) {
    this.database = database;
    this.query = query;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new SqliteD1Statement(this.database, this.query, parameters);
  }

  async all() {
    const results = this.database.prepare(this.query).all(...this.parameters).map(plainRow);
    return { success: true, results, meta: {} };
  }

  async raw() {
    const results = this.database.prepare(this.query).all(...this.parameters).map(plainRow);
    return results.map((row) => Object.values(row));
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async first(column) {
    const row = this.database.prepare(this.query).get(...this.parameters);
    if (row === undefined) return null;
    const plain = plainRow(row);
    return column === undefined ? plain : plain[column];
  }
}

class SqliteD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function openDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("CREATE TABLE learning_accounts (user_id text PRIMARY KEY);");
  const migration = await readFile(new URL("../drizzle/0003_study_events_v3.sql", import.meta.url), "utf8");
  sqlite.exec(migration);
  sqlite.exec("INSERT INTO learning_accounts (user_id) VALUES ('user-a'), ('user-b')");
  const database = drizzle(new SqliteD1Database(sqlite), { schema });
  return { sqlite, store: new D1ReviewEventStore(database) };
}

async function makeEvent(eventId, reviewedAt, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: reviewedAt,
    domain: "ielts",
    eventType: "practice-attempt",
    item: { kind: "word", key: "diag-word" },
    attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
    ...overrides,
  });
}

test("diagnostics distinguish pending behind conflict baseline and rebuilt", () => {
  assert.equal(summarizeReplicaState({ localPending: 2, cloudBehind: false, conflicts: 0 }).level, "pending");
  assert.equal(summarizeReplicaState({ localPending: 0, cloudBehind: true, conflicts: 0 }).level, "behind");
  assert.equal(summarizeReplicaState({ localPending: 0, cloudBehind: false, conflicts: 1 }).level, "conflict");
  assert.equal(summarizeReplicaState({ localPending: 0, cloudBehind: false, conflicts: 0, source: "legacy-baseline" }).sourceLabel, "旧数据基线");
  assert.equal(summarizeReplicaState({ localPending: 0, cloudBehind: false, conflicts: 0, source: "rebuilt" }).sourceLabel, "事件重建");
  assert.equal(summarizeReplicaState({ localPending: 0, cloudBehind: false, conflicts: 0 }).level, "healthy");
  const mismatch = summarizeReplicaState({ localPending: 0, cloudBehind: false, conflicts: 0, projectionMismatchCount: 2 });
  assert.equal(mismatch.level, "mismatch");
});

test("cloud diagnostics are authenticated and user-scoped", async () => {
  const { store } = await openDatabase();
  const event = await makeEvent("evt-diag-1", "2026-08-24T10:00:00.000Z");
  await processStudyEventBatch("user-a", [event], store);

  const forA = await store.diagnostics("user-a");
  assert.equal(forA.eventCount, 1);
  assert.equal(forA.cursor, 1);
  assert.equal(forA.schedulerVersion, SCHEDULER_VERSION);
  assert.equal(forA.sourceCounts.rebuilt, 1);

  const forB = await store.diagnostics("user-b");
  assert.equal(forB.eventCount, 0);
  assert.equal(forB.cursor, 0);
});

test("diagnostic UI cannot expose secrets or edit review state", async () => {
  const source = await readDashboardSource();
  assert.match(source, /复习状态/);
  assert.doesNotMatch(source, /显示.*(token|api key|绝对路径)/i);
  assert.doesNotMatch(source, /修改到期|标记掌握|删除事件|移出复习/);
});
