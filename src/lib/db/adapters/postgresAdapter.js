import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import pg from "pg";

const { Pool } = pg;

export const TABLE_PKS = {
  _meta: ["key"],
  settings: ["id"],
  providerconnections: ["id"],
  providernodes: ["id"],
  proxypools: ["id"],
  apikeys: ["id"],
  combos: ["id"],
  kv: ["scope", "key"],
  usagehistory: ["id"],
  usagedaily: ["datekey"],
  requestdetails: ["id"],
  provider_footer_logs: ["id"],
};

export function convertPlaceholders(sql) {
  if (typeof sql !== "string" || !sql.includes("?")) return sql;

  let out = "";
  let paramIndex = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollarQuote = false;
  let dollarTag = "";

  const len = sql.length;
  for (let i = 0; i < len; i++) {
    const c = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (inLineComment) {
      out += c;
      if (c === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      out += c;
      if (c === "*" && next === "/") {
        out += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingleQuote) {
      out += c;
      if (c === "'") {
        if (next === "'") {
          out += next;
          i++;
        } else if (sql[i - 1] !== "\\") {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDoubleQuote) {
      out += c;
      if (c === '"') {
        if (next === '"') {
          out += next;
          i++;
        } else if (sql[i - 1] !== "\\") {
          inDoubleQuote = false;
        }
      }
      continue;
    }

    if (inDollarQuote) {
      out += c;
      if (c === "$" && sql.startsWith(dollarTag, i)) {
        out += dollarTag.slice(1);
        i += dollarTag.length - 1;
        inDollarQuote = false;
        dollarTag = "";
      }
      continue;
    }

    if (c === "-" && next === "-") {
      out += c + next;
      i++;
      inLineComment = true;
      continue;
    }

    if (c === "/" && next === "*") {
      out += c + next;
      i++;
      inBlockComment = true;
      continue;
    }

    if (c === "'") {
      out += c;
      inSingleQuote = true;
      continue;
    }

    if (c === '"') {
      out += c;
      inDoubleQuote = true;
      continue;
    }

    if (c === "$") {
      const match = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        out += dollarTag;
        i += dollarTag.length - 1;
        inDollarQuote = true;
        continue;
      }
    }

    if (c === "?") {
      out += `$${paramIndex++}`;
      continue;
    }

    out += c;
  }

  return out;
}

export function normalizeSql(sql) {
  if (typeof sql !== "string") return sql;
  let s = sql;

  // 1. SQLite datetime functions -> PostgreSQL equivalent
  s = s.replace(
    /datetime\s*\(\s*['"]now['"]\s*,\s*['"]start of day['"]\s*\)/gi,
    "to_char(date_trunc('day', NOW()), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
  );
  s = s.replace(
    /datetime\s*\(\s*['"]now['"]\s*,\s*['"]-(\d+)\s*(days?|hours?|minutes?|months?|years?)['"]\s*\)/gi,
    "to_char(NOW() - INTERVAL '$1 $2', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
  );
  s = s.replace(/datetime\s*\(\s*['"]now['"]\s*\)/gi, "NOW()");

  // 2. PRAGMA table_info(tableName) -> information_schema
  const pragmaMatch = s.match(/^\s*PRAGMA\s+table_info\s*\(\s*['"]?([a-zA-Z0-9_]+)['"]?\s*\)\s*;?$/i);
  if (pragmaMatch) {
    const tbl = pragmaMatch[1].toLowerCase();
    return `SELECT column_name AS name FROM information_schema.columns WHERE lower(table_name) = '${tbl}'`;
  }

  // Generic SQLite PRAGMA statements -> no-op in PostgreSQL
  if (/^\s*PRAGMA\s+/i.test(s)) {
    return "SELECT 1 WHERE 1 = 0";
  }

  // 3. SQLite DDL compatibility
  if (/CREATE\s+TABLE/i.test(s)) {
    s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
  }

  // 4. INSERT OR REPLACE INTO -> INSERT INTO ... ON CONFLICT (...) DO UPDATE ...
  const insertReplaceRegex = /INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z0-9_"]+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+?)\)(?:\s*;)?$/i;
  const match = s.match(insertReplaceRegex);
  if (match) {
    const cleanTable = match[1].trim().replace(/["`]/g, "");
    const cleanCols = match[2].split(",").map((c) => c.trim().replace(/["`]/g, ""));
    const valuesPart = match[3];

    const lowerTable = cleanTable.toLowerCase();
    let pks = TABLE_PKS[lowerTable];
    if (!pks) {
      if (cleanCols.some((c) => c.toLowerCase() === "id")) {
        pks = ["id"];
      } else {
        pks = [cleanCols[0]];
      }
    }

    const nonPkCols = cleanCols.filter(
      (c) => !pks.some((pk) => pk.toLowerCase() === c.toLowerCase())
    );

    let conflictClause;
    const pkList = pks.join(", ");
    if (nonPkCols.length > 0) {
      const updateList = nonPkCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
      conflictClause = `ON CONFLICT (${pkList}) DO UPDATE SET ${updateList}`;
    } else {
      conflictClause = `ON CONFLICT (${pkList}) DO NOTHING`;
    }

    s = `INSERT INTO ${cleanTable} (${cleanCols.join(", ")}) VALUES (${valuesPart}) ${conflictClause}`;
  }

  return s;
}

export function translateSql(sql) {
  return convertPlaceholders(normalizeSql(sql));
}

const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Pool } = require("pg");

const int32 = new Int32Array(workerData.sab);
const pool = new Pool(
  typeof workerData.config === "string"
    ? { connectionString: workerData.config, connectionTimeoutMillis: 5000 }
    : (workerData.config || { connectionTimeoutMillis: 5000 })
);

let dedicatedClient = null;

async function getClient() {
  if (!dedicatedClient) {
    dedicatedClient = await pool.connect();
    dedicatedClient.on("error", (err) => {
      try { dedicatedClient.release(true); } catch {}
      dedicatedClient = null;
    });
  }
  return dedicatedClient;
}

parentPort.once("message", ({ port }) => {
  port.on("message", async (msg) => {
    try {
      if (msg.type === "close") {
        if (dedicatedClient) {
          try { dedicatedClient.release(); } catch {}
          dedicatedClient = null;
        }
        await pool.end();
        port.postMessage({ status: "ok" });
      } else if (msg.type === "query") {
        const client = await getClient();
        const result = await client.query(msg.sql, msg.params);
        port.postMessage({
          status: "ok",
          rowCount: result.rowCount ?? 0,
          rows: result.rows ?? [],
        });
      } else if (msg.type === "exec") {
        const client = await getClient();
        await client.query(msg.sql);
        port.postMessage({ status: "ok" });
      } else if (msg.type === "ping") {
        const client = await getClient();
        await client.query("SELECT 1");
        port.postMessage({ status: "ok" });
      }
    } catch (err) {
      if (dedicatedClient && /transaction/i.test(err.message)) {
        try { dedicatedClient.release(true); } catch {}
        dedicatedClient = null;
      }
      port.postMessage({ status: "error", error: err.message, stack: err.stack });
    } finally {
      Atomics.store(int32, 0, 1);
      Atomics.notify(int32, 0);
    }
  });
});
`;

export async function createPostgresAdapter(connectionStringOrConfig, options = {}) {
  const poolConfig = connectionStringOrConfig || process.env.DATABASE_URL || "postgres://localhost:5432/postgres";
  const mockClient = options.mockClient || options.client || null;

  let pool = null;
  let worker = null;
  let port1 = null;
  let int32 = null;
  let closed = false;

  if (mockClient) {
    pool = mockClient;
  } else {
    pool = options.pool || new Pool(
      typeof poolConfig === "string"
        ? { connectionString: poolConfig, connectionTimeoutMillis: 5000 }
        : poolConfig
    );

    const sab = new SharedArrayBuffer(4);
    int32 = new Int32Array(sab);
    const channel = new MessageChannel();
    port1 = channel.port1;

    worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { config: poolConfig, sab },
    });

    worker.postMessage({ port: channel.port2 }, [channel.port2]);

    // Initial ping to verify connection
    Atomics.store(int32, 0, 0);
    port1.postMessage({ type: "ping" });
    const waitResult = Atomics.wait(int32, 0, 0, options.connectTimeoutMs || 5000);
    if (waitResult === "timed-out") {
      try { worker.terminate(); } catch {}
      try { pool.end(); } catch {}
      throw new Error(`[DB] PostgreSQL connection timed out connecting to ${typeof poolConfig === "string" ? poolConfig.replace(/:[^:@]+@/, ":***@") : "host"}`);
    }

    const initMsg = receiveMessageOnPort(port1)?.message;
    if (initMsg?.status === "error") {
      try { worker.terminate(); } catch {}
      try { pool.end(); } catch {}
      throw new Error(`[DB] PostgreSQL connection failed: ${initMsg.error}`);
    }
  }

  function syncDispatch(req) {
    if (closed) throw new Error("[DB] Adapter is closed");
    Atomics.store(int32, 0, 0);
    port1.postMessage(req);
    Atomics.wait(int32, 0, 0);
    const res = receiveMessageOnPort(port1)?.message;
    if (!res) throw new Error("[DB] No response from PostgreSQL worker");
    if (res.status === "error") {
      const err = new Error(res.error);
      if (res.stack) err.stack = res.stack;
      throw err;
    }
    return res;
  }

  function run(sql, params = []) {
    const normSql = translateSql(sql);
    if (mockClient) {
      const res = mockClient.query(normSql, params);
      return {
        changes: res?.rowCount ?? res?.changes ?? (Array.isArray(res?.rows) ? res.rows.length : 0),
        lastInsertRowid: res?.rows?.[0]?.id ?? res?.lastInsertRowid ?? null,
      };
    }
    const res = syncDispatch({ type: "query", sql: normSql, params });
    return {
      changes: res.rowCount ?? 0,
      lastInsertRowid: res.rows?.[0]?.id ?? null,
    };
  }

  function get(sql, params = []) {
    const normSql = translateSql(sql);
    if (mockClient) {
      const res = mockClient.query(normSql, params);
      if (res && Array.isArray(res.rows)) return res.rows[0] ?? undefined;
      if (Array.isArray(res)) return res[0] ?? undefined;
      return res ?? undefined;
    }
    const res = syncDispatch({ type: "query", sql: normSql, params });
    return res.rows?.[0] ?? undefined;
  }

  function all(sql, params = []) {
    const normSql = translateSql(sql);
    if (mockClient) {
      const res = mockClient.query(normSql, params);
      if (res && Array.isArray(res.rows)) return res.rows;
      if (Array.isArray(res)) return res;
      return [];
    }
    const res = syncDispatch({ type: "query", sql: normSql, params });
    return res.rows ?? [];
  }

  function exec(sql) {
    const normSql = translateSql(sql);
    if (mockClient) {
      if (typeof mockClient.exec === "function") return mockClient.exec(normSql);
      return mockClient.query(normSql);
    }
    syncDispatch({ type: "exec", sql: normSql });
  }

  let txDepth = 0;
  function transaction(fn) {
    const sp = `sp_${++txDepth}_${Math.random().toString(36).slice(2, 8)}`;
    if (txDepth === 1) {
      exec("BEGIN");
    } else {
      exec(`SAVEPOINT ${sp}`);
    }
    try {
      const result = fn();
      if (txDepth === 1) {
        exec("COMMIT");
      } else {
        exec(`RELEASE SAVEPOINT ${sp}`);
      }
      return result;
    } catch (err) {
      if (txDepth === 1) {
        try { exec("ROLLBACK"); } catch {}
      } else {
        try {
          exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {}
      }
      throw err;
    } finally {
      txDepth--;
    }
  }

  function checkpoint() {
    // WAL managed natively by PostgreSQL engine
  }

  function close() {
    if (closed) return;
    closed = true;
    if (mockClient) {
      if (typeof mockClient.close === "function") mockClient.close();
      if (typeof mockClient.end === "function") mockClient.end();
      return;
    }
    try { syncDispatch({ type: "close" }); } catch {}
    try { worker.terminate(); } catch {}
    if (pool && typeof pool.end === "function") {
      try { pool.end(); } catch {}
    }
  }

  process.once("beforeExit", () => {
    try { close(); } catch {}
  });

  return {
    driver: "postgres",
    run,
    get,
    all,
    exec,
    transaction,
    checkpoint,
    close,
    raw: pool,
  };
}
