import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapters = [
  "betterSqliteAdapter.js",
  "nodeSqliteAdapter.js",
  "bunSqliteAdapter.js",
];

test("SQLite adapters leave SIGTERM drain to Next server", () => {
  for (const name of adapters) {
    const source = fs.readFileSync(new URL(`../../src/lib/db/adapters/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /process\.(once|on)\("SIGTERM"[\s\S]{0,180}process\.exit/,
      `${name} must not exit before Next drains active connections`);
  }
});
