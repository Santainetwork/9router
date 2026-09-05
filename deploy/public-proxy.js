#!/usr/bin/env node
// Public-only reverse proxy for 9Router.
// Listens on PORT (default 20140) and proxies only allowed paths to the
// upstream 9router instance (default 127.0.0.1:20128).
// Everything else returns 404.
//
// Usage:
//   node deploy/public-proxy.js
//   PORT=20141 UPSTREAM=127.0.0.1:20130 node deploy/public-proxy.js

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "20140", 10);
const UPSTREAM = process.env.UPSTREAM || "127.0.0.1:20128";

// Self-contained usage-check page (inline CSS/JS, no Next chunks). Served
// directly by this proxy so the public port never has to expose /_next/static.
const USAGE_CHECK_HTML = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "usage-check.html"), "utf8");
  } catch {
    return null;
  }
})();

// Self-contained public API documentation page (also inline, no Next chunks).
const DOCS_HTML = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "docs.html"), "utf8");
  } catch {
    return null;
  }
})();

// Paths allowed through the public port.  Everything else gets 404.
// NOTE: /usage-check is served locally (below), not proxied — no /_next needed.
const ALLOW = [
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/api/v1/",
  "/v1/",
  "/api/v2/",
  "/v2/",
  "/nosaver/",
  "/v1beta/",
];

function isAllowed(p) {
  return ALLOW.some((prefix) => p === prefix || p.startsWith(prefix));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const reqPath = parsed.pathname;

  // Serve the self-contained usage-check page locally.
  if (reqPath === "/usage-check" || reqPath === "/usage-check/") {
    if (!USAGE_CHECK_HTML) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("usage-check.html missing");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(USAGE_CHECK_HTML);
    return;
  }

  // Serve the self-contained API docs page locally.
  if (reqPath === "/docs" || reqPath === "/docs/" || reqPath === "/") {
    if (!DOCS_HTML) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("docs.html missing");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(DOCS_HTML);
    return;
  }

  if (!isAllowed(reqPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }

  const options = {
    hostname: UPSTREAM.split(":")[0],
    port: parseInt(UPSTREAM.split(":")[1] || "20128", 10),
    path: req.url,
    method: req.method,
    headers: { ...req.headers },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Remove chunked encoding if upstream sends it (node handles it)
    const headers = { ...proxyRes.headers };
    delete headers["transfer-encoding"]; // let node manage
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error(`[public-proxy] ${err.message}`);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  });

  req.pipe(proxyReq);
});

server.listen(PORT, "::", () => {
  console.log(`public-proxy listening on :${PORT}, upstream=${UPSTREAM}`);
});