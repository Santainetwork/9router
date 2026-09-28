// Task 8: the control writer must refuse to start against an external Redis
// whose persistence/eviction config is unsafe. The bundled Compose profile
// enforces AOF/noeviction via redis-server flags; an external REDIS_URL must be
// probed at writer startup. Fail closed: an unsafe server never gets a writer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../src/lib/db/sqliteMutationRuntime.js", import.meta.url), "utf8");

test("writer startup runs the Redis server config preflight and fails closed", async () => {
  assert.match(source, /checkRedisServerConfig/, "startup must call the preflight");
  assert.match(
    source,
    /if \(!preflight\.ok\)[\s\S]*?throw/,
    "an unsafe Redis config must abort writer startup",
  );
});
