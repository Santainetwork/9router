import { getAdapter } from "../driver.js";
import { bumpDbVersion } from "../dbVersion.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [alias, stringifyJson(model)]
    );
    bumpDbVersion(db);
  });
}

export async function deleteModelAlias(alias) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?`, [alias]);
    bumpDbVersion(db);
  });
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, transport }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      bumpDbVersion(db);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
    bumpDbVersion(db);
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [customKey(providerAlias, id, type)]);
    bumpDbVersion(db);
  });
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [toolName, stringifyJson(mappings || {})]
    );
    bumpDbVersion(db);
  });
}
