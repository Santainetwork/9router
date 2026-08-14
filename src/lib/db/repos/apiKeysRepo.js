import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    rpm: row.rpm ?? 0,
    queueTimeoutMs: row.queueTimeoutMs ?? 0,
    allowedModels: parseAllowedModels(row.allowedModels),
    tokenQuota: row.tokenQuota ?? 0,
  };
}

// allowedModels stored as JSON array of model ids; empty/absent = all models.
function parseAllowedModels(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter((m) => typeof m === "string" && m.trim()) : [];
  } catch {
    return [];
  }
}

function serializeAllowedModels(value) {
  if (!Array.isArray(value)) return null;
  const clean = value.filter((m) => typeof m === "string" && m.trim());
  return clean.length ? JSON.stringify(clean) : null;
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    rpm: 0,
    queueTimeoutMs: 0,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, rpm, queueTimeoutMs, allowedModels, tokenQuota) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, 0, 0, null, 0]
  );
  return { ...apiKey, allowedModels: [], tokenQuota: 0 };
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const rpm = Number.isFinite(Number(merged.rpm)) ? Math.max(0, Math.floor(Number(merged.rpm))) : 0;
    const queueTimeoutMs = Number.isFinite(Number(merged.queueTimeoutMs)) ? Math.max(0, Math.floor(Number(merged.queueTimeoutMs))) : 0;
    const tokenQuota = Number.isFinite(Number(merged.tokenQuota)) ? Math.max(0, Math.floor(Number(merged.tokenQuota))) : 0;
    const allowedModelsJson = serializeAllowedModels(merged.allowedModels);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, rpm = ?, queueTimeoutMs = ?, allowedModels = ?, tokenQuota = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, rpm, queueTimeoutMs, allowedModelsJson, tokenQuota, id]
    );
    result = { ...merged, rpm, queueTimeoutMs, tokenQuota, allowedModels: parseAllowedModels(allowedModelsJson) };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// Fetch limit config for a raw key value (used by the request gate).
export async function getApiKeyLimits(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT id, rpm, queueTimeoutMs, allowedModels, tokenQuota FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return null;
  return {
    id: row.id,
    rpm: row.rpm ?? 0,
    queueTimeoutMs: row.queueTimeoutMs ?? 0,
    allowedModels: parseAllowedModels(row.allowedModels),
    tokenQuota: row.tokenQuota ?? 0,
  };
}

// Sum of prompt+completion tokens already spent by this key (all-time),
// used to enforce tokenQuota. Uses the indexed apiKey column on usageHistory.
export async function getApiKeyTokenUsage(key) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)), 0) AS used FROM usageHistory WHERE apiKey = ?`,
    [key]
  );
  return Number(row?.used) || 0;
}

// Public metadata + limits for a raw key value. Returns null if the key does
// not exist. Never returns the raw key back. Used by the self-service usage
// endpoint so a caller can inspect only their own key.
export async function getApiKeyByKey(key) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT id, name, isActive, createdAt, rpm, queueTimeoutMs, allowedModels, tokenQuota FROM apiKeys WHERE key = ?`,
    [key]
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || "",
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt || null,
    rpm: row.rpm ?? 0,
    queueTimeoutMs: row.queueTimeoutMs ?? 0,
    allowedModels: parseAllowedModels(row.allowedModels),
    tokenQuota: row.tokenQuota ?? 0,
  };
}

// Usage for a single key since `startDate` (ISO string). Aggregates request
// count, prompt/completion tokens, plus per-model and per-day breakdowns.
// Powers the self-service usage-check endpoint (period 1d–30d).
export async function getApiKeyUsageInRange(key, startDate) {
  const db = await getAdapter();
  const conds = ["apiKey = ?"];
  const params = [key];
  if (startDate) {
    conds.push("timestamp >= ?");
    params.push(new Date(startDate).toISOString());
  }
  const rows = db.all(
    `SELECT timestamp, model, provider, status,
            COALESCE(promptTokens,0) AS pt, COALESCE(completionTokens,0) AS ct
       FROM usageHistory
      WHERE ${conds.join(" AND ")}
      ORDER BY timestamp ASC`,
    params
  );

  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const byModel = {};
  const byDay = {};
  for (const r of rows) {
    requests += 1;
    promptTokens += Number(r.pt) || 0;
    completionTokens += Number(r.ct) || 0;
    const m = r.model || "unknown";
    const day = String(r.timestamp || "").slice(0, 10) || "unknown";
    byModel[m] ||= { requests: 0, promptTokens: 0, completionTokens: 0 };
    byModel[m].requests += 1;
    byModel[m].promptTokens += Number(r.pt) || 0;
    byModel[m].completionTokens += Number(r.ct) || 0;
    byDay[day] ||= { requests: 0, promptTokens: 0, completionTokens: 0 };
    byDay[day].requests += 1;
    byDay[day].promptTokens += Number(r.pt) || 0;
    byDay[day].completionTokens += Number(r.ct) || 0;
  }
  return {
    requests,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    byModel,
    byDay,
  };
}
