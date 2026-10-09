import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { bumpDbVersion } from "../dbVersion.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeContextWindow } from "@/shared/utils/contextWindow.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    contextWindow: normalizeContextWindow(row.contextWindow),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    contextWindow: normalizeContextWindow(data.contextWindow),
    createdAt: now,
    updatedAt: now,
  };
  db.transaction(() => {
    db.run(
      `INSERT INTO combos(id, name, kind, models, contextWindow, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.contextWindow, combo.createdAt, combo.updatedAt]
    );
    bumpDbVersion(db);
  });
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    // Partial update: a body without the key keeps the stored override, while an
    // explicit null clears it.
    if (data.contextWindow === undefined) {
      merged.contextWindow = normalizeContextWindow(row.contextWindow);
    } else {
      merged.contextWindow = normalizeContextWindow(data.contextWindow);
    }
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, contextWindow = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.contextWindow, merged.updatedAt, id]
    );
    result = merged;
    bumpDbVersion(db);
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
    if (deleted) bumpDbVersion(db);
  });
  return deleted;
}
