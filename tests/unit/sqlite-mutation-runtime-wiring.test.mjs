import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../src/instrumentation.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../../custom-server.js", import.meta.url), "utf8");
const { shouldStartSqliteMutationWriter } = await import("../../src/lib/db/sqliteMutationRuntime.js");

test("control bootstrap starts the SQLite mutation writer in Redis multicore mode", () => {
  assert.match(source, /startSqliteMutationWriter/);
  assert.match(serverSource, /__stopSqliteMutationWriter/);
});

test("writer starts only on SQLite Redis control process", () => {
  assert.equal(shouldStartSqliteMutationWriter({ DB_TYPE: "sqlite" }), false);
  assert.equal(shouldStartSqliteMutationWriter({ DB_TYPE: "postgres", SQLITE_MULTICORE: "redis" }), false);
  assert.equal(shouldStartSqliteMutationWriter({ DB_TYPE: "sqlite", SQLITE_MULTICORE: "redis", WORKER_ROLE: "api" }), false);
  assert.equal(shouldStartSqliteMutationWriter({ DB_TYPE: "sqlite", SQLITE_MULTICORE: "redis", WORKER_ROLE: "control" }), true);
});
