const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

// Shared ceiling: the Docker entrypoint derives ::20131.. ::20137 for 7 API
// workers, so 8 total processes is the supported maximum. Keep both validators
// in agreement.
const MAX_API_WORKERS = 8;

function validRedisUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["redis:", "rediss:"].includes(url.protocol)
      && Boolean(url.hostname)
      && (!url.pathname || /^\/[0-9]+$/.test(url.pathname));
  } catch {
    return false;
  }
}

function validateWorkerConfig(env = process.env) {
  // Honor the NINEROUTER_WORKER_ROLE alias too, matching driver/engine role
  // detection so an api worker is recognized regardless of which is set.
  const role = env.WORKER_ROLE || env.NINEROUTER_WORKER_ROLE || "control";
  const workersValue = env.API_WORKERS || "1";
  const workers = Number(workersValue);
  const postgres = String(env.DB_TYPE || "").toLowerCase() === "postgres" || /^(postgres|postgresql):\/\//.test(env.DATABASE_URL || "");
  if (!/^[1-9]\d*$/.test(workersValue) || !Number.isSafeInteger(workers)) {
    throw new Error("API_WORKERS must be a positive integer");
  }
  if (workers > MAX_API_WORKERS) {
    throw new Error(`API_WORKERS must not exceed ${MAX_API_WORKERS}`);
  }
  if (role !== "control" && role !== "api") throw new Error("WORKER_ROLE must be control or api");
  const needsSharedSqlite = !postgres && (role === "api" || workers > 1);
  if (needsSharedSqlite && String(env.SQLITE_MULTICORE || "").toLowerCase() !== "redis") {
    throw new Error(role === "api"
      ? "WORKER_ROLE=api requires PostgreSQL or SQLITE_MULTICORE=redis"
      : "SQLite API_WORKERS>1 requires PostgreSQL or SQLITE_MULTICORE=redis");
  }
  if (needsSharedSqlite && !validRedisUrl(env.REDIS_URL)) {
    throw new Error("SQLite multicore requires a valid redis:// or rediss:// REDIS_URL");
  }
  if (needsSharedSqlite && String(env.ENABLE_GO_HYBRID || "").toLowerCase() !== "true") {
    throw new Error("SQLite multicore requires ENABLE_GO_HYBRID=true");
  }
  return { role, workers, postgres, sqliteMulticore: needsSharedSqlite };
}

if (process.argv.includes("--check-config")) {
  try { validateWorkerConfig(); process.exit(0); }
  catch (error) { console.error(`[9Router] Invalid worker configuration: ${error.message}`); process.exit(1); }
}

const workerConfig = validateWorkerConfig();
if (workerConfig.role === "api") {
  process.env.NINEROUTER_WORKER_ROLE = "api";
  process.env.DISABLE_BACKGROUND_TOKEN_REFRESH = "true";
  global.__appBootstrapped = true;
}

const origCreate = http.createServer.bind(http);
const DRAIN_TIMEOUT_MS = Number(process.env.NINEROUTER_DRAIN_TIMEOUT_MS || 300000);
let gracefulShutdownInstalled = false;
let gracefulShutdownStarted = false;

// Next's default SIGTERM handler exits after its own cleanup path. The wrapper
// owns the signal instead so the actual HTTP server drains active streams first.
process.env.NEXT_MANUAL_SIG_HANDLE = "1";

function installGracefulShutdown(server) {
  if (gracefulShutdownInstalled) return;
  gracefulShutdownInstalled = true;

  const shutdown = (signal, exitCode) => {
    if (gracefulShutdownStarted) return;
    gracefulShutdownStarted = true;
    console.log(`[9Router] ${signal}: draining active connections (timeout ${DRAIN_TIMEOUT_MS}ms)`);

    const forceExit = setTimeout(() => {
      console.error(`[9Router] ${signal}: drain timeout reached, forcing exit`);
      process.exit(exitCode);
    }, DRAIN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async (error) => {
      clearTimeout(forceExit);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error(`[9Router] ${signal}: server drain failed:`, error.message);
      }
      try { await global.__stopSqliteMutationWriter?.(); } catch {}
      process.exit(exitCode);
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  process.once("SIGINT", () => shutdown("SIGINT", 130));
}

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    const isLoopbackAddr = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
    if (viaProxy && !isLoopbackAddr) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  installGracefulShutdown(server);
  server.once("listening", () => {
    if (workerConfig.role !== "api") startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}

module.exports = { validateWorkerConfig };
