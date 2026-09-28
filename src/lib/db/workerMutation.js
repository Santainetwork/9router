// Task 4: worker-role telemetry producers. Pure payload builders + enqueue glue.
// No raw API keys, request/response bodies, headers, or cookies may ever leave a
// worker. The raw API key is resolved to its opaque apiKeys.id via the read-only
// adapter when the caller only has the raw value; the raw value itself is never
// placed in a payload.
import { getRedisManager } from "../redis/client.js";
import { createMutationQueue } from "./sqliteMutationQueue.js";
import { encryptQueuePayload, getQueueEncryptionKey } from "./queueEncryption.js";

const state = global.__workerMutationState ??= { queue: null };
// Async telemetry loss observed by this process. The queue counts its own drops;
// this counts the drops this worker actually saw, so a silently degraded worker
// is visible even when the queue itself is unreachable.
const lossState = global.__workerTelemetryLoss ??= { lost: 0 };

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function getWorkerMutationQueue() {
  if (state.queue) return state.queue;
  const manager = getRedisManager();
  state.queue = createMutationQueue({ redis: manager });
  return state.queue;
}

// Resolve a raw key to its opaque row id via the read-only adapter. Returns null
// when the key is unknown or no adapter is available, so the caller can still
// attribute the row to its connectionId instead of dropping it.
export async function resolveApiKeyId(db, rawApiKey) {
  if (!rawApiKey || typeof rawApiKey !== "string") return null;
  if (!db || typeof db.get !== "function") return null;
  try {
    const row = db.get("SELECT id FROM apiKeys WHERE key = ?", [rawApiKey]);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

// usage.save payload: apiKeyId only. `cost` and `tokens` are already computed by
// the direct-write path; the control writer replays them verbatim.
export function buildUsageSavePayload(entry) {
  return withoutUndefined({
    timestamp: entry.timestamp ?? new Date().toISOString(),
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    connectionId: entry.connectionId ?? null,
    apiKeyId: entry.apiKeyId ?? null,
    endpoint: entry.endpoint ?? null,
    promptTokens: entry.promptTokens ?? entry.tokens?.prompt_tokens ?? entry.tokens?.input_tokens ?? 0,
    completionTokens: entry.completionTokens ?? entry.tokens?.completion_tokens ?? entry.tokens?.output_tokens ?? 0,
    cost: entry.cost ?? 0,
    status: entry.status ?? "ok",
    tokens: entry.tokens ?? {},
    requestedModel: entry.requestedModel ?? undefined,
    upstreamModel: entry.upstreamModel ?? undefined,
  });
}

// requestDetail.save payload: metadata-only. Bodies, headers, cookies are dropped
// at the boundary; the control writer already stores them as null.
export function buildRequestDetailSavePayload(detail) {
  return withoutUndefined({
    id: detail.id,
    timestamp: detail.timestamp ?? new Date().toISOString(),
    provider: detail.provider ?? null,
    model: detail.model ?? null,
    connectionId: detail.connectionId ?? null,
    status: detail.status ?? null,
    latency: detail.latency ?? {},
    tokens: detail.tokens ?? {},
    endpoint: detail.endpoint ?? undefined,
    apiKeyId: detail.apiKeyId ?? null,
    requestedModel: detail.requestedModel ?? undefined,
    upstreamModel: detail.upstreamModel ?? undefined,
    pxpipe: detail.pxpipe ?? undefined,
    truncated: detail.truncated ?? undefined,
    bytesIn: detail.bytesIn ?? undefined,
    bytesOut: detail.bytesOut ?? undefined,
  });
}

// footerLog.add payload: exactly the typed fields the writer needs.
export function buildFooterLogAddPayload(provider, model, referralText, timestamp = new Date().toISOString()) {
  return { timestamp, provider, model, referralText };
}

// Best-effort async enqueue. Never throws; reports loss so callers can count it.
export async function enqueueTelemetry(queue, input) {
  try {
    const result = await queue.enqueueMutation({ ...input, consistency: "async" });
    if (result?.dropped) lossState.lost++;
    return result;
  } catch {
    lossState.lost++;
    return { enqueued: false, dropped: true, receiptId: input?.receiptId ?? null };
  }
}

function bounded(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 1_000_000_000));
}

// Sanitized worker telemetry health: bounded counters only, no payloads, keys or
// error text. Loss here is the process-observed drop count; the queue counters
// cover enqueues this worker attempted.
export function getWorkerTelemetryStatus() {
  let queueStatus = {};
  try {
    queueStatus = state.queue?.status?.() ?? {};
  } catch {}
  return {
    enqueued: bounded(queueStatus.enqueued),
    telemetryDropped: bounded(queueStatus.telemetryDropped),
    backpressure: bounded(queueStatus.backpressure),
    failures: bounded(queueStatus.failures),
    telemetryLost: bounded(lossState.lost),
  };
}

// Task 5: synchronous provider-state mutation payload + enqueue. Token-bearing
// credential fields are encrypted into a `ciphertext` field; only non-secret
// routing/health/cooldown/lock fields remain in `updates`. Plaintext secrets
// never enter the Redis command JSON.
const TOKEN_BEARING_KEYS = [
  "accessToken", "refreshToken", "idToken", "apiKey", "token",
  "copilotToken", "copilotTokenExpiresAt", "providerSpecificData", "expiresAt",
  "expiresIn", "lastRefreshAt", "projectId", "scope", "tokenType",
  // lastError carries upstream error text, which can embed response-body
  // fragments. It rides encrypted, never plaintext in the stream.
  "lastError",
];

function splitConnectionUpdate(updates) {
  const plain = {};
  const secret = {};
  for (const [key, value] of Object.entries(updates ?? {})) {
    if (value === undefined) continue;
    (TOKEN_BEARING_KEYS.includes(key) ? secret : plain)[key] = value;
  }
  return { plain, secret };
}

export function buildConnectionUpdatePayload(connectionId, updates, { ciphertext = null } = {}) {
  const payload = { connectionId, updates };
  if (ciphertext) payload.ciphertext = ciphertext;
  return payload;
}

export async function enqueueSyncConnectionUpdate(queue, connectionId, updates) {
  const { plain, secret } = splitConnectionUpdate(updates);
  let ciphertext = null;
  if (Object.keys(secret).length > 0) {
    ciphertext = encryptQueuePayload(getQueueEncryptionKey(), secret);
  }
  const payload = buildConnectionUpdatePayload(connectionId, plain, { ciphertext });
  // consistency "sync": enqueueMutation blocks on the committed receipt and
  // throws on timeout/queue failure. No direct-write fallback exists here.
  const result = await queue.enqueueMutation({ type: "connection.update", payload, consistency: "sync" });
  return result.result ?? { updated: true };
}
