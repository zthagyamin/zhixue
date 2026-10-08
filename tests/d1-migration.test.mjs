import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0003_study_events_v3.sql", import.meta.url);

function indexColumns(db, tableName, indexName) {
  return db
    .prepare(`PRAGMA index_info(${JSON.stringify(indexName)})`)
    .all()
    .map((column) => column.name);
}

function plainRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

test("v3 migration creates additive review-state structures without harming legacy sentinels", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const db = new DatabaseSync(":memory:");

  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE learning_accounts (user_id text PRIMARY KEY);
      CREATE TABLE learning_events (
        sequence integer PRIMARY KEY,
        user_id text NOT NULL,
        event_id text NOT NULL,
        outcome text NOT NULL
      );
      CREATE TABLE learning_item_states (
        user_id text NOT NULL,
        item_kind text NOT NULL,
        item_key text NOT NULL,
        state text NOT NULL,
        PRIMARY KEY (user_id, item_kind, item_key)
      );
      INSERT INTO learning_accounts (user_id) VALUES ('legacy-user');
      INSERT INTO learning_events (sequence, user_id, event_id, outcome)
        VALUES (7, 'legacy-user', 'legacy-event', 'correct');
      INSERT INTO learning_item_states (user_id, item_kind, item_key, state)
        VALUES ('legacy-user', 'flashcard', 'legacy-card', 'review');
    `);

    db.exec(sql);

    assert.deepEqual(
      plainRows(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('study_events_v3', 'review_projections') ORDER BY name").all()),
      [{ name: "review_projections" }, { name: "study_events_v3" }],
    );
    assert.deepEqual(
      plainRows(db.prepare("SELECT sequence, user_id, event_id, outcome FROM learning_events").all()),
      [{ sequence: 7, user_id: "legacy-user", event_id: "legacy-event", outcome: "correct" }],
    );
    assert.deepEqual(
      plainRows(db.prepare("SELECT user_id, item_kind, item_key, state FROM learning_item_states").all()),
      [{ user_id: "legacy-user", item_kind: "flashcard", item_key: "legacy-card", state: "review" }],
    );

    const studyIndexes = db.prepare("PRAGMA index_list('study_events_v3')").all();
    assert.deepEqual(
      indexColumns(db, "study_events_v3", "study_events_v3_user_event_uq"),
      ["user_id", "event_id"],
    );
    assert.equal(
      studyIndexes.find((index) => index.name === "study_events_v3_user_event_uq")?.unique,
      1,
    );
    assert.deepEqual(
      indexColumns(db, "study_events_v3", "study_events_v3_replay_idx"),
      ["user_id", "item_kind", "item_key", "reviewed_at", "event_id"],
    );
    assert.deepEqual(
      indexColumns(db, "study_events_v3", "study_events_v3_cursor_idx"),
      ["user_id", "sequence"],
    );
    assert.deepEqual(
      indexColumns(db, "review_projections", "review_projections_due_idx"),
      ["user_id", "due_at"],
    );
    assert.deepEqual(
      db.prepare("PRAGMA table_info('review_projections')").all().filter((column) => column.pk > 0).map((column) => column.name),
      ["user_id", "item_kind", "item_key"],
    );
  } finally {
    db.close();
  }
});

test("v3 migration metadata: foreign keys, nullable JSON columns, autoincrement and boolean", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE learning_accounts (user_id text PRIMARY KEY);");
    db.exec(sql);

    // Foreign keys: both new tables cascade-delete with learning_accounts.
    const eventFks = db.prepare("PRAGMA foreign_key_list('study_events_v3')").all();
    assert.deepEqual(
      eventFks.map((fk) => [fk.table, fk.from, fk.to, fk.on_delete]),
      [["learning_accounts", "user_id", "user_id", "CASCADE"]],
    );
    const projectionFks = db.prepare("PRAGMA foreign_key_list('review_projections')").all();
    assert.deepEqual(
      projectionFks.map((fk) => [fk.table, fk.from, fk.to, fk.on_delete]),
      [["learning_accounts", "user_id", "user_id", "CASCADE"]],
    );

    // Nullable JSON/evidence columns must stay nullable.
    const eventColumns = Object.fromEntries(
      db.prepare("PRAGMA table_info('study_events_v3')").all().map((column) => [column.name, column.notnull === 0]),
    );
    for (const nullableColumn of ["state_handle", "rating", "correct", "stage_before", "stage_after", "reviewed_at", "scheduler_version", "client_projection_json", "baseline_json"]) {
      assert.equal(eventColumns[nullableColumn], true, `${nullableColumn} must be nullable`);
    }
    const projectionColumns = Object.fromEntries(
      db.prepare("PRAGMA table_info('review_projections')").all().map((column) => [column.name, column.notnull === 0]),
    );
    assert.equal(projectionColumns.last_reviewed_at, true, "last_reviewed_at must be nullable");

    // Auto-increment: sequence is the integer primary key and the table is
    // registered in sqlite_sequence after an insert.
    const sequenceColumn = db.prepare("PRAGMA table_info('study_events_v3')").all().find((column) => column.name === "sequence");
    assert.equal(sequenceColumn.pk, 1);
    assert.equal(sequenceColumn.type, "INTEGER");
    assert.match(sql, /`sequence` integer PRIMARY KEY AUTOINCREMENT/i);
    db.prepare("INSERT INTO learning_accounts (user_id) VALUES ('meta-user')").run();
    const inserted = db.prepare("INSERT INTO study_events_v3 (user_id, event_id, core_hash, schema_version, occurred_at, domain, event_type, item_kind, item_key, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("meta-user", "meta-evt", "h", 3, "2026-08-24T10:00:00.000Z", "ielts", "practice-attempt", "word", "word-1", "2026-08-24T10:00:00.000Z");
    assert.equal(Number(inserted.lastInsertRowid), 1);
    assert.equal(
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'study_events_v3'").get().seq,
      1,
    );

    // Boolean semantics: `correct` is stored as an integer 0/1 column.
    db.prepare("INSERT INTO study_events_v3 (user_id, event_id, core_hash, schema_version, occurred_at, domain, event_type, item_kind, item_key, correct, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("meta-user", "meta-evt-bool", "h", 3, "2026-08-24T10:00:00.000Z", "ielts", "practice-attempt", "word", "word-2", 1, "2026-08-24T10:00:00.000Z");
    assert.equal(
      db.prepare("SELECT correct FROM study_events_v3 WHERE event_id = 'meta-evt-bool'").get().correct,
      1,
    );
  } finally {
    db.close();
  }
});
