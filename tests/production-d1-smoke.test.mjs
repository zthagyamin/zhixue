import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { buildSmokeSteps, runSmoke } from "../scripts/production-d1-smoke.mjs";

let cliRun = 0;

// Import the real CLI entry after replacing the native spawn binding. No
// executable, npm package, deployment credential or remote D1 is ever used.
async function captureCli(args = [], responseOverride) {
  const memory = memoryExecutor();
  await memory.executor(await loadMigrationSql());
  const original = {
    spawn: childProcess.spawn, argv: process.argv, exitCode: process.exitCode,
    log: console.log, error: console.error,
  };
  const calls = [];
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  let timer;
  childProcess.spawn = (command, argv, options) => {
    calls.push({ command, argv: [...argv], options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      try {
        const sql = argv[argv.indexOf("--command") + 1];
        const payload = responseOverride
          ? responseOverride(sql)
          : [{ success: true, results: await memory.executor(sql), meta: {} }];
        child.stdout.end(JSON.stringify(payload));
        child.emit("close", 0);
      } catch (error) {
        child.stderr.end(error.message);
        child.emit("close", 1);
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  assert.equal((await import("node:child_process")).spawn, childProcess.spawn);
  process.argv = [process.execPath, fileURLToPath(new URL("../scripts/production-d1-smoke.mjs", import.meta.url)), ...args];
  console.log = value => complete({ report: JSON.parse(value), calls });
  console.error = value => complete({ error: String(value), calls });
  try {
    const cliModuleUrl = new URL("../scripts/production-d1-smoke.mjs", import.meta.url);
    cliModuleUrl.searchParams.set("isolated-cli-test", String(++cliRun));
    await import(cliModuleUrl.href);
    return await Promise.race([
      finished,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Captured CLI did not finish")), 2000); }),
    ]);
  } finally {
    clearTimeout(timer);
    childProcess.spawn = original.spawn;
    syncBuiltinESMExports();
    process.argv = original.argv;
    process.exitCode = original.exitCode;
    console.log = original.log;
    console.error = original.error;
    memory.close();
  }
}

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

test("real CLI defaults to the locked local Wrangler instead of npm package discovery", async () => {
  const result = await captureCli();
  assert.equal(result.calls[0].command, process.execPath);
  assert.equal(result.calls[0].argv[0], fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)));
  assert.deepEqual(result.calls[0].argv.slice(1, 6), ["d1", "execute", "DB", "--remote", "--json"]);
  assert.equal(result.calls[0].options.shell ?? false, false);
});

test("real CLI unwraps Wrangler result envelopes through actual SQLite smoke steps", async () => {
  const result = await captureCli(["--wrangler", "synthetic-wrangler"]);
  assert.equal(result.report.total, buildSmokeSteps().length);
  assert.equal(result.report.passed, buildSmokeSteps().length);
  assert.deepEqual(result.report.report.filter(step => !step.passed), []);
});

test("a zero-exit failed Wrangler envelope cannot pass mutation checks", async () => {
  const result = await captureCli(["--wrangler", "synthetic-wrangler"], () => [
    { success: false, results: [], errors: [{ message: "synthetic D1 rejection" }] },
  ]);
  const seed = result.report.report.find(step => step.id === "seed-test-accounts");
  assert.equal(seed.passed, false);
  assert.match(seed.error, /synthetic D1 rejection/);
});

test("legacy npx selection uses local Wrangler while an explicit executable stays an argv command", async () => {
  const alias = await captureCli(["--wrangler", "npx"]);
  assert.equal(alias.calls[0].command, process.execPath);
  assert.match(alias.calls[0].argv[0], /wrangler[\\/]bin[\\/]wrangler\.js$/);
  const custom = await captureCli(["--wrangler", "C:/Synthetic Apps/wrangler.exe"]);
  assert.equal(custom.calls[0].command, "C:/Synthetic Apps/wrangler.exe");
  assert.deepEqual(custom.calls[0].argv.slice(0, 5), ["d1", "execute", "DB", "--remote", "--json"]);
  assert.equal(custom.calls[0].options.shell ?? false, false);
});

test("an explicit missing Wrangler executable stops before dispatching SQL", async () => {
  const result = await captureCli(["--wrangler"]);
  assert.equal(result.calls.length, 0);
  assert.match(result.error, /--wrangler.*executable/i);
});
