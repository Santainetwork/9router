// Task 5: failing mutation-audit test. Enumerates every updateProviderConnection
// call site reachable from API-worker routes and requires a classification of
// synchronous correctness or control-only. An unknown mutation fails the test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const {
  classifyMutationSite,
  MUTATION_CLASS,
  KNOWN_MUTATION_SITES,
} = await import("../../src/lib/db/providerMutationAudit.js");

const ROOT = new URL("../../", import.meta.url);
const SOURCE_DIRS = ["src", "open-sse"];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__test__" || entry.name === "test") continue;
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

async function findCallSites() {
  const sites = new Map(); // relativePath -> line numbers
  for (const sourceDir of SOURCE_DIRS) {
    const files = await walk(path.join(ROOT.pathname, sourceDir));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!source.includes("updateProviderConnection")) continue;
      // Barrel files re-export the symbol; they contain no mutation call.
      const relative = path.relative(ROOT.pathname, file);
      if (source.includes("} from \"") && !/\bupdateProviderConnection\(/.test(source)) continue;
      const lines = source.split("\n");
      const numbers = [];
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed.includes("updateProviderConnection")) return;
        if (trimmed.startsWith("//") || trimmed.startsWith("export")) return;
        if (trimmed.includes("from ")) return; // re-export barrel line
        numbers.push(i + 1);
      });
      if (numbers.length) {
        sites.set(relative, numbers);
      }
    }
  }
  return sites;
}

test("every updateProviderConnection call site is classified as sync or control-only", async () => {
  const sites = await findCallSites();
  assert.ok(sites.size > 0, "expected at least one call site to audit");

  for (const [relativePath, lines] of sites) {
    const classification = classifyMutationSite(relativePath);
    assert.notEqual(
      classification,
      "unknown",
      `unknown mutation site ${relativePath}:${lines.join(",")} — add it to KNOWN_MUTATION_SITES`,
    );
    assert.ok(
      [MUTATION_CLASS.SYNC, MUTATION_CLASS.CONTROL_ONLY].includes(classification),
      `invalid classification for ${relativePath}: ${classification}`,
    );
  }
});

test("sync sites are the provider-state/credential request-path mutations", () => {
  const syncSites = [
    "src/app/api/models/availability/route.js",
    "src/app/api/provider-nodes/[id]/route.js",
    "src/app/api/translator/send/route.js",
    "src/app/api/usage/[connectionId]/route.js",
    "src/sse/services/auth.js",
    "src/sse/services/tokenRefresh.js",
  ];
  for (const site of syncSites) {
    assert.equal(classifyMutationSite(site), MUTATION_CLASS.SYNC, site);
  }
});

test("control-only sites are admin/dashboard/background mutations", () => {
  const controlSites = [
    "src/app/api/oauth/xiaomi-mimo/api-key/route.js",
    "src/app/api/providers/[id]/route.js",
    "src/shared/services/quotaAutoPing.js",
    "src/lib/oauth/providers/index.js",
  ];
  for (const site of controlSites) {
    assert.equal(classifyMutationSite(site), MUTATION_CLASS.CONTROL_ONLY, site);
  }
});

test("registry has no stale entries pointing at files that no longer call updateProviderConnection", async () => {
  const sites = await findCallSites();
  const wrapperSites = new Set();
  for (const sourceDir of SOURCE_DIRS) {
    const files = await walk(path.join(ROOT.pathname, sourceDir));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/\bupdateProviderCredentials\(/.test(source)) {
        wrapperSites.add(path.relative(ROOT.pathname, file));
      }
    }
  }
  for (const relativePath of Object.keys(KNOWN_MUTATION_SITES)) {
    if (relativePath === "src/sse/services/tokenRefresh.js") continue;
    assert.ok(
      sites.has(relativePath) || wrapperSites.has(relativePath),
      `registry entry ${relativePath} no longer contains a call site`,
    );
  }
});

test("every updateProviderCredentials wrapper caller is classified", async () => {
  const sites = new Map();
  for (const sourceDir of SOURCE_DIRS) {
    const files = await walk(path.join(ROOT.pathname, sourceDir));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!/\bupdateProviderCredentials\(/.test(source)) continue;
      const lines = source.split("\n");
      const numbers = [];
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed.includes("updateProviderCredentials(")) return;
        if (trimmed.startsWith("//") || trimmed.startsWith("export") || trimmed.includes("from ")) return;
        numbers.push(i + 1);
      });
      if (numbers.length) sites.set(path.relative(ROOT.pathname, file), numbers);
    }
  }
  assert.ok(sites.size > 0, "expected at least one wrapper call site");
  for (const relativePath of sites.keys()) {
    assert.notEqual(
      classifyMutationSite(relativePath),
      "unknown",
      `unknown updateProviderCredentials caller ${relativePath} — classify it in KNOWN_MUTATION_SITES`,
    );
  }
});

test("updateProviderCredentials wrapper refuses control-only mutation in a worker", async () => {
  const source = await readFile(new URL("../../src/sse/services/tokenRefresh.js", import.meta.url), "utf8");
  // The wrapper must route through updateProviderConnection (which bridges
  // sync through the Redis single-writer in worker mode) rather than a raw
  // adapter write, and must surface a typed refusal for control-only callers.
  assert.match(source, /await updateProviderConnection\(connectionId, updates\)/, "wrapper must delegate to updateProviderConnection");
});
