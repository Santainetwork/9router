import { AsyncLocalStorage } from "node:async_hooks";
import { getAdapter, isSqliteMulticoreWorker } from "../driver.js";

export const requestLogStore = globalThis.__9rRequestLogStore ||= new AsyncLocalStorage();
const MAX_ROWS = Math.max(100, parseInt(process.env.REQUEST_LOGS_MAX || "5000", 10));
let insertsSincePrune = 0;

export async function insertRequestLog(entry) {
  try {
    if (isSqliteMulticoreWorker()) {
      const { getWorkerMutationQueue, buildRequestLogSavePayload, enqueueTelemetry } = await import("../workerMutation.js");
      await enqueueTelemetry(getWorkerMutationQueue(), { type: "requestLog.save", payload: buildRequestLogSavePayload(entry) });
      return;
    }
    const db = await getAdapter();
    const cols = ["timestamp", "apiKeyId", "apiKeyName", "apiKeyMasked", "ip", "method", "path", "endpointKind", "model", "provider", "resolvedModel", "status", "stream", "promptTokens", "completionTokens", "durationMs", "ttftMs", "tps", "userAgent", "error"];
    const values = cols.map((key) => typeof entry[key] === "boolean" ? (entry[key] ? 1 : 0) : entry[key] ?? null);
    db.run(`INSERT INTO requestLogs(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, values);
    if (++insertsSincePrune >= 100) {
      insertsSincePrune = 0;
      db.run("DELETE FROM requestLogs WHERE id <= (SELECT id FROM requestLogs ORDER BY id DESC LIMIT 1 OFFSET ?)", [MAX_ROWS]);
    }
  } catch (error) {
    console.error("[requestLogs] insert failed:", error?.message || error);
  }
}

export async function getRequestLogs(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (filter.apiKeyId === "none") conds.push("apiKeyId IS NULL");
  else if (filter.apiKeyId) { conds.push("apiKeyId = ?"); params.push(filter.apiKeyId); }
  if (filter.status === "ok") conds.push("status < 400");
  if (filter.status === "error") conds.push("status >= 400");
  if (filter.endpointKind) { conds.push("endpointKind = ?"); params.push(filter.endpointKind); }
  if (filter.search) {
    const q = `%${filter.search}%`;
    conds.push("(model LIKE ? OR resolvedModel LIKE ? OR ip LIKE ? OR path LIKE ? OR provider LIKE ? OR userAgent LIKE ?)");
    params.push(q, q, q, q, q, q);
  }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filter.pageSize) || 50));
  const total = Number(db.get(`SELECT COUNT(*) AS c FROM requestLogs${where}`, params)?.c || 0);
  const logs = db.all(`SELECT * FROM requestLogs${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
    .map((row) => ({ ...row, stream: row.stream === 1 }));
  return { logs, pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) } };
}

export function recordUsageForRequestLog(entry) {
  const ctx = requestLogStore.getStore();
  if (!ctx) return;
  const tokens = entry.tokens || {};
  const promptTokens = Number(tokens.prompt_tokens || tokens.input_tokens || 0);
  const completionTokens = Number(tokens.completion_tokens || tokens.output_tokens || 0);
  const signature = `${entry.timestamp}|${entry.provider}|${entry.model}|${promptTokens}|${completionTokens}`;
  if (ctx.seen.has(signature)) return;
  ctx.seen.add(signature);
  ctx.promptTokens += promptTokens;
  ctx.completionTokens += completionTokens;
  ctx.provider = entry.provider || ctx.provider;
  ctx.resolvedModel = entry.model || ctx.resolvedModel;
}
