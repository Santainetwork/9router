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
const httpProxy = require("http");
const url = require("url");

const PORT = parseInt(process.env.PORT || "20140", 10);
const UPSTREAM = process.env.UPSTREAM || "127.0.0.1:20128";

// Paths allowed through the public port.  Everything else gets 404.
const ALLOW = [
  "/usage-check",
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/_next/static/",
  "/_next/image/",
  "/api/v1/",
  "/v1/",
  "/v1beta/",
];

function isAllowed(path) {
  return ALLOW.some((prefix) => path === prefix || path.startsWith(prefix));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const path = parsed.pathname;

  if (!isAllowed(path)) {
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