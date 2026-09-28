import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HANDLERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/sse/handlers");

// Handlers that call getProviderCredentials can throw ProviderNotWorkerSafeError
// from the runtime eligibility gate (SQLite multicore workers). Without a
// catch at the entrypoint the typed refusal becomes a generic Next 500 and the
// Go gateway can neither identify it (409 + x-9router-worker-refusal header)
// nor route back to control. Source-level contract, same style as the chat
// handler check in provider-eligibility-enforcement.test.mjs.
const HANDLERS_USING_CREDENTIALS = readdirSync(HANDLERS_DIR)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, source: readFileSync(path.join(HANDLERS_DIR, name), "utf8") }))
  .filter(({ source }) => /\bgetProviderCredentials\s*\(/.test(source));

test("every handler calling getProviderCredentials converts typed worker refusals", () => {
  assert.ok(HANDLERS_USING_CREDENTIALS.length >= 5, "sanity: expected the main credential-bearing handlers");
  const offenders = [];
  for (const { name, source } of HANDLERS_USING_CREDENTIALS) {
    if (!/providerNotWorkerSafeResponse\s*\(|withWorkerRefusal\s*\(/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `handlers missing refusal conversion: ${offenders.join(", ")}`);
});
