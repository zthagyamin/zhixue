import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildSmokeSteps, runSmoke } from "../scripts/production-d1-smoke.mjs";

// Executes the same smoke steps against a real local SQLite database running
// the published migration, proving the step SQL and assertions are valid.
function memoryExecutor() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE learning_accounts (user_id text PRIMARY KEY);");
  return {
    async executor(sql) {
      if (sql.includes(";") || /^\s*(CREATE|DROP|ALTER)/i.test(sql)) {
        // Multi-statement migration scripts and DDL go through exec.
        db.exec(sql);
        return [];
      }
      const statement = db.prepare(sql);
      if (/^\s*(INSERT|DELETE|UPDATE)/i.test(sql)) {
        statement.run();
        return [];
      }
      return statement.all();
    },
    close() {
      db.close();
    },
  };
}

async function loadMigrationSql() {
  return readFile(new URL("../drizzle/0003_study_events_v3.sql", import.meta.url), "utf8");
}

test("smoke steps pass against the published migration on real SQLite", async () => {
  const memory = memoryExecutor();
  try {
    await memory.executor(await loadMigrationSql());
    const report = await runSmoke(memory.executor);
    const failed = report.filter((step) => !step.passed);
    assert.deepEqual(
      failed.map((step) => ({ id: step.id, error: step.error })),
      [],
      "every smoke step must pass on the migration schema",
    );
    assert.equal(report.length, buildSmokeSteps().length);
    // Cleanup removed the disposable rows.
    const leftover = await memory.executor("SELECT count(*) AS count FROM study_events_v3 WHERE user_id LIKE 'smoke-%'");
    assert.equal(Number(leftover[0].count), 0);
  } finally {
    memory.close();
  }
});

test("same-user duplicate insert is rejected by the unique index", async () => {
  const memory = memoryExecutor();
  try {
    await memory.executor(await loadMigrationSql());
    await memory.executor("INSERT INTO learning_accounts (user_id) VALUES ('smoke-user-a')");
    const insert = `INSERT INTO study_events_v3 (user_id, event_id, core_hash, schema_version, occurred_at, domain, event_type, item_kind, item_key, received_at)
      VALUES ('smoke-user-a', 'smoke-evt-1', 'h', 3, '2026-08-25T00:00:00.000Z', 'ielts', 'practice-attempt', 'word', 'smoke-word', '2026-08-25T00:00:00.000Z')`;
    await memory.executor(insert);
    await assert.rejects(memory.executor(insert), /UNIQUE/i);
  } finally {
    memory.close();
  }
});
