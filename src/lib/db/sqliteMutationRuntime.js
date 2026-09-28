import { getDatabaseType, isSqliteMulticoreWorker } from "./driver.js";
import { createMutationWriter } from "./sqliteMutationWriter.js";
import { applyMutation } from "./sqliteMutationHandlers.js";
import { getRedisManager } from "../redis/client.js";
import { checkRedisServerConfig } from "../redis/serverConfig.js";

const state = global.__sqliteMutationRuntime ??= { writer: null, promise: null };

export function shouldStartSqliteMutationWriter(env = process.env) {
  return getDatabaseType(env) === "sqlite"
    && String(env.SQLITE_MULTICORE || "").toLowerCase() === "redis"
    && String(env.WORKER_ROLE || env.NINEROUTER_WORKER_ROLE || "control").toLowerCase() === "control";
}

export async function startSqliteMutationWriter() {
  if (!shouldStartSqliteMutationWriter() || isSqliteMulticoreWorker() || state.writer) return state.writer;
  if (state.promise) return state.promise;
  state.promise = (async () => {
    const [{ getAdapter }, manager] = await Promise.all([
      import("./driver.js"),
      Promise.resolve(getRedisManager()),
    ]);
    const [db, redis] = await Promise.all([getAdapter(), manager.command()]);
    // External Redis preflight: refuse to start the single writer against a
    // server that could silently lose or evict queued mutations. The bundled
    // Compose profile enforces this via flags; external REDIS_URL is probed.
    const preflight = await checkRedisServerConfig(redis);
    if (!preflight.ok) {
      const error = new Error(`[SQLiteMutationWriter] refusing unsafe Redis: ${preflight.issues.join("; ")}`);
      error.code = "REDIS_PREFLIGHT_FAILED";
      throw error;
    }
    const writer = createMutationWriter({ redis, db, applyMutation });
    state.writer = writer;
    global.__stopSqliteMutationWriter = stopSqliteMutationWriter;
    writer.run().catch((error) => {
      console.error("[SQLiteMutationWriter] stopped:", error?.code || "writer_failed");
      state.writer = null;
    });
    return writer;
  })().finally(() => { state.promise = null; });
  return state.promise;
}

export async function stopSqliteMutationWriter() {
  const writer = state.writer;
  state.writer = null;
  delete global.__stopSqliteMutationWriter;
  if (writer) await writer.stop();
}
