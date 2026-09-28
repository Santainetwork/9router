import { validateMutation, MutationValidationError } from "./mutationProtocol.js";
import { getQueueEncryptionKey, decryptQueuePayload } from "./queueEncryption.js";
import { resetHealthStateOnActivation, rowToConn, upsert, reorderInTx } from "./repos/connectionRow.js";

const MAX_LOGS = 200;

// Allowlisted repository mutations replayed by the single control writer.
// Closed switch only: no dynamic SQL, no dynamic dispatch. Each handler is a
// synchronous function of the adapter so it runs inside the writer's single
// transaction (receipt insert + mutation + result in one commit).
//
// Security: payloads carry apiKeyId (opaque row id), never the raw key. The raw
// key is resolved here, inside control, via SELECT key FROM apiKeys WHERE id = ?.
// requestDetail.save is metadata-only per protocol: raw request/response bodies
// and headers are rejected before they reach this module, and only a redacted
// footer text is ever persisted.

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(str, fallback = null) {
  if (str == null) return fallback;
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function resolveApiKey(db, apiKeyId) {
  if (!apiKeyId) return null;
  const row = db.get("SELECT key FROM apiKeys WHERE id = ?", [apiKeyId]);
  return row?.key ?? null;
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function applyUsageSave(db, payload) {
  const apiKey = resolveApiKey(db, payload.apiKeyId);
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const provider = payload.provider ?? null;
  const model = payload.model ?? null;
  const connectionId = payload.connectionId ?? null;
  const endpoint = payload.endpoint ?? null;
  const tokens = payload.tokens ?? {};
  const promptTokens = Number(tokens.prompt_tokens ?? tokens.input_tokens ?? 0) || 0;
  const completionTokens = Number(tokens.completion_tokens ?? tokens.output_tokens ?? 0) || 0;
  const cost = Number(payload.cost) || 0;
  const status = payload.status ?? "ok";
  const meta = stringifyJson({
    requestedModel: payload.requestedModel,
    upstreamModel: payload.upstreamModel ?? undefined,
  });

  // Same dedupe contract as usageRepo.saveRequestUsage: an identical row
  // (timestamp/provider/model/connection/apiKey/prompt/completion) is a no-op,
  // except that a missing endpoint on the existing row is backfilled.
  const existing = db.get(
    `SELECT id, endpoint FROM usageHistory
     WHERE timestamp = ?
       AND COALESCE(provider, '') = COALESCE(?, '')
       AND COALESCE(model, '') = COALESCE(?, '')
       AND COALESCE(connectionId, '') = COALESCE(?, '')
       AND COALESCE(apiKey, '') = COALESCE(?, '')
       AND promptTokens = ?
       AND completionTokens = ?
     ORDER BY id DESC LIMIT 1`,
    [timestamp, provider, model, connectionId, apiKey, promptTokens, completionTokens],
  );

  if (existing) {
    if (!existing.endpoint && endpoint) {
      db.run("UPDATE usageHistory SET endpoint = ? WHERE id = ?", [endpoint, existing.id]);
    }
    return { inserted: false };
  }

  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, stringifyJson(tokens), meta],
  );

  const dateKey = getLocalDateKey(timestamp);
  const row = db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey]);
  const day = row ? parseJson(row.data, {}) : {
    requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
  };
  const entry = { timestamp, provider, model, connectionId, apiKey, endpoint, tokens, cost, requestedModel: payload.requestedModel, upstreamModel: payload.upstreamModel };
  aggregateEntryToDay(day, entry);
  db.run(
    "INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data",
    [dateKey, stringifyJson(day)],
  );

  const cur = db.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
  const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
  db.run(
    "INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(next)],
  );
  return { inserted: true };
}

function applyRequestDetailSave(db, payload) {
  const id = payload.id ?? `detail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const record = {
    id,
    provider: payload.provider ?? null,
    model: payload.model ?? null,
    connectionId: payload.connectionId ?? null,
    timestamp,
    status: payload.status ?? null,
    latency: payload.latency ?? {},
    tokens: payload.tokens ?? {},
    // Metadata-only: bodies and headers are rejected at the protocol boundary,
    // so these are always null here. Defense in depth keeps them out on read.
    request: null,
    providerRequest: null,
    providerResponse: null,
    response: null,
    pxpipe: payload.pxpipe ?? undefined,
    upstreamModel: payload.upstreamModel ?? undefined,
    requestedModel: payload.requestedModel ?? undefined,
  };

  db.run(
    "INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data",
    [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)],
  );

  const cnt = db.get("SELECT COUNT(*) AS c FROM requestDetails");
  if (cnt && cnt.c > MAX_LOGS) {
    db.run(
      "DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)",
      [cnt.c - MAX_LOGS],
    );
  }
  return { id };
}

function redactFooterText(text) {
  if (!text || typeof text !== "string") return "";
  let redacted = text;
  for (const pattern of [
    /Bearer\s+[a-zA-Z0-9._~-]+/gi,
    /sk-[a-zA-Z0-9]{20,}/g,
    /[a-zA-Z0-9_-]{32,}/g,
  ]) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function applyFooterLogAdd(db, payload) {
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const redactedText = redactFooterText(payload.referralText);

  db.run(
    "INSERT INTO provider_footer_logs (timestamp, provider, model, referral_text) VALUES (?, ?, ?, ?)",
    [timestamp, payload.provider, payload.model, redactedText],
  );
  db.run(
    `DELETE FROM provider_footer_logs WHERE id NOT IN (
      SELECT id FROM provider_footer_logs ORDER BY timestamp DESC LIMIT ${MAX_LOGS}
    )`,
  );
  return { inserted: true };
}

function applyConnectionUpdate(db, payload) {
  const { connectionId, updates, ciphertext } = payload;
  const row = db.get("SELECT * FROM providerConnections WHERE id = ?", [connectionId]);
  if (!row) return { updated: false };
  const existing = rowToConn(row);

  // Decrypt token-bearing credential fields in the control process before merge.
  // Never accepts plaintext credential keys: the protocol deep scan rejects them
  // upstream, so only encrypted material can arrive here.
  let mergedUpdates = updates ?? {};
  if (ciphertext) {
    const key = getQueueEncryptionKey();
    const decrypted = decryptQueuePayload(key, ciphertext);
    mergedUpdates = { ...mergedUpdates, ...decrypted };
  }

  const normalized = resetHealthStateOnActivation(existing, mergedUpdates);
  const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
  upsert(db, merged);
  if (mergedUpdates.priority !== undefined) reorderInTx(db, existing.provider);

  // Synchronous correctness mutation: bump the monotonic database version in the
  // same transaction so workers reread versioned state, never a stale cache.
  const cur = db.get("SELECT version FROM dbVersion WHERE id = 1");
  const next = (cur ? Number(cur.version) : 0) + 1;
  db.run(
    "INSERT INTO dbVersion(id, version, updatedAt) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updatedAt = excluded.updatedAt",
    [String(next), merged.updatedAt],
  );
  return { updated: true, version: next };
}

const HANDLERS = Object.freeze({
  "usage.save": applyUsageSave,
  "requestDetail.save": applyRequestDetailSave,
  "footerLog.add": applyFooterLogAdd,
  "connection.update": applyConnectionUpdate,
});

export function applyMutation(db, command) {
  validateMutation(command);
  const handler = HANDLERS[command.type];
  if (!handler) {
    throw new MutationValidationError(`unknown mutation type: ${command.type}`, "MUTATION_TYPE_UNKNOWN");
  }
  return handler(db, command.payload);
}
