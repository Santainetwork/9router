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
