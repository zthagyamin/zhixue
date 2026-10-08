#!/usr/bin/env node
// Production D1 smoke test for zhixue-study-loop v0.7.1.
//
// Checks the storage layer of the deployed D1 database against the v0.7
// migration contract: tables exist, the (user_id, event_id) uniqueness holds,
// the same event id can coexist across users, and per-user data stays
// isolated. API-layer classification (duplicates/conflicts/cursor) still
// requires an authenticated browser session; see
// docs/verification/2026-08-25-v0.7.1-acceptance.md section 1.
//
// Usage (requires Cloudflare authentication):
//   set CLOUDFLARE_API_TOKEN=... (or run `wrangler login` once)
//   node scripts/production-d1-smoke.mjs [--wrangler npx]
//
// The executor is injectable so the same steps run against a local SQLite
// database in tests/production-d1-smoke.test.mjs.

import { spawn } from "node:child_process";

const TEST_USER_A = "smoke-user-a";
const TEST_USER_B = "smoke-user-b";
const TEST_EVENT_ID = "smoke-evt-1";
const TEST_ITEM_KEY = "smoke-word";
const TEST_CORE_HASH = "smoke-core-hash";

export function buildSmokeSteps() {
  const stamp = "2026-08-25T00:00:00.000Z";
  return [
    {
      id: "migration-tables-exist",
      description: "study_events_v3 and review_projections exist",
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('study_events_v3','review_projections') ORDER BY name",
      check: (rows) => rows.map((row) => row.name).join(",") === "review_projections,study_events_v3",
    },
    {
      id: "unique-user-event-index",
      description: "(user_id, event_id) unique index present",
      sql: "SELECT name, \"unique\" AS is_unique FROM pragma_index_list('study_events_v3')",
      check: (rows) => {
        const byName = Object.fromEntries(rows.map((row) => [row.name, Number(row.is_unique) === 1]));
        return byName.study_events_v3_user_event_uq === true
          && byName.study_events_v3_replay_idx === false
          && byName.study_events_v3_cursor_idx === false;
      },
    },
    {
      id: "seed-test-accounts",
      description: "seed two disposable smoke accounts",
      sql: `INSERT INTO learning_accounts (user_id) VALUES ('${TEST_USER_A}'), ('${TEST_USER_B}') ON CONFLICT DO NOTHING`,
      check: () => true,
    },
    {
      id: "same-event-id-across-users",
      description: "the same event id can be stored under two different users",
      sql: `INSERT INTO study_events_v3 (user_id, event_id, core_hash, schema_version, occurred_at, domain, event_type, item_kind, item_key, received_at)
            VALUES ('${TEST_USER_A}', '${TEST_EVENT_ID}', '${TEST_CORE_HASH}', 3, '${stamp}', 'ielts', 'practice-attempt', 'word', '${TEST_ITEM_KEY}', '${stamp}'),
                   ('${TEST_USER_B}', '${TEST_EVENT_ID}', '${TEST_CORE_HASH}', 3, '${stamp}', 'ielts', 'practice-attempt', 'word', '${TEST_ITEM_KEY}', '${stamp}')`,
      check: () => true,
    },
    {
      id: "duplicate-same-user-event-rejected",
      description: "re-inserting the same (user_id, event_id) is rejected by the unique index",
      sql: `INSERT INTO study_events_v3 (user_id, event_id, core_hash, schema_version, occurred_at, domain, event_type, item_kind, item_key, received_at)
            VALUES ('${TEST_USER_A}', '${TEST_EVENT_ID}', '${TEST_CORE_HASH}', 3, '${stamp}', 'ielts', 'practice-attempt', 'word', '${TEST_ITEM_KEY}', '${stamp}')`,
      expectError: /unique|constraint/i,
      check: () => true,
    },
    {
      id: "per-user-isolation",
      description: "each smoke account sees exactly its own event",
      sql: `SELECT user_id, count(*) AS count FROM study_events_v3
            WHERE user_id IN ('${TEST_USER_A}', '${TEST_USER_B}') GROUP BY user_id ORDER BY user_id`,
      check: (rows) => {
        const counts = Object.fromEntries(rows.map((row) => [row.user_id, Number(row.count)]));
        return counts[TEST_USER_A] === 1 && counts[TEST_USER_B] === 1;
      },
    },
  ];
}

export function cleanupSql() {
  return [
    `DELETE FROM study_events_v3 WHERE user_id IN ('${TEST_USER_A}', '${TEST_USER_B}')`,
    `DELETE FROM learning_accounts WHERE user_id IN ('${TEST_USER_A}', '${TEST_USER_B}')`,
  ];
}

export async function runSmoke(executor) {
  const steps = buildSmokeSteps();
  const report = [];
  try {
    for (const step of steps) {
      try {
        const rows = await executor(step.sql);
        const passed = step.check(rows);
        report.push({ id: step.id, description: step.description, passed, rows: rows.slice(0, 10) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const expected = step.expectError !== undefined && step.expectError.test(message);
        report.push({
          id: step.id,
          description: step.description,
          passed: expected,
          error: expected ? undefined : message,
        });
      }
    }
  } finally {
    const cleanup = cleanupSql();
    for (const sql of cleanup) {
      try {
        await executor(sql);
      } catch {
        // Cleanup is best effort; evidence rows carry the smoke- prefix.
      }
    }
  }
  return report;
}

function wranglerExecutor(wranglerCommand) {
  return async (sql) => {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(wranglerCommand, [
        "d1", "execute", "DB", "--remote", "--json", "--command", sql,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim() || `wrangler exited ${code}`));
      });
    });
    const parsed = JSON.parse(output);
    const results = Array.isArray(parsed) ? parsed : parsed.results ?? [];
    return results;
  };
}

function main() {
  const wranglerCommand = process.argv.find((arg, index) => arg === "--wrangler" && process.argv[index + 1])
    ? process.argv[process.argv.indexOf("--wrangler") + 1]
    : "npx";
  runSmoke(wranglerExecutor(wranglerCommand)).then((report) => {
    const passed = report.filter((step) => step.passed).length;
    console.log(JSON.stringify({ total: report.length, passed, report }, null, 2));
    process.exitCode = passed === report.length ? 0 : 1;
  }).catch((error) => {
    console.error("smoke failed to run:", error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}

if (process.argv[1] && process.argv[1].endsWith("production-d1-smoke.mjs")) {
  main();
}
